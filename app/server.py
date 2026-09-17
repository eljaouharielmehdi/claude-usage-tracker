"""
Claude Code usage tracker.

Reads local Claude Code CLI session logs (~/.claude/projects/**/*.jsonl,
mounted read-only into this container) and serves a live dashboard of
token usage and estimated cost, per session and per project.

No data leaves this container: everything is parsed from local files
already on disk.
"""

import calendar
import glob
import json
import logging
import os
import shutil
import threading
import time
from collections import Counter
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from waitress import serve

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("claude-usage-tracker")

PROJECTS_DIR = Path(os.environ.get("CLAUDE_PROJECTS_DIR", "/data/projects"))
PRICING_PATH = Path(os.environ.get("PRICING_CONFIG", "/config/pricing.json"))
DEFAULT_PRICING_PATH = Path(__file__).parent / "pricing_defaults.json"
NETWORK_LOG_PATH = Path(os.environ.get("NETWORK_LOG_PATH", "/data/network/anthropic_traffic.jsonl"))
CACHE_SECONDS = float(os.environ.get("REFRESH_SECONDS", "2"))

app = Flask(__name__, static_folder="static", static_url_path="")

_cache_lock = threading.Lock()
_cache = {}  # (token_range, net_range) -> {"computed_at": epoch, "data": stats}

# Chart ranges: key -> (window seconds, bucket seconds). Bucket widths are
# chosen to keep every view between ~60 and ~370 bars.
RANGES = {
    "1h": (3600, 60),
    "24h": (24 * 3600, 5 * 60),
    "7d": (7 * 24 * 3600, 3600),
    "30d": (30 * 24 * 3600, 6 * 3600),
    "1y": (365 * 24 * 3600, 24 * 3600),
}
DEFAULT_RANGE = "24h"

# Per-file parse cache: path -> ((mtime, size), events). Session log files are
# append-only while active and immutable once a session ends, so a file whose
# (mtime, size) hasn't changed since last read can skip disk I/O and JSON
# decoding entirely instead of being fully re-parsed on every poll.
# Only ever touched from compute_stats(), which runs under _cache_lock.
_file_cache = {}


def load_pricing():
    if PRICING_PATH.exists():
        try:
            with open(PRICING_PATH) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to read %s (%s), falling back to defaults", PRICING_PATH, exc)
    with open(DEFAULT_PRICING_PATH) as f:
        return json.load(f)


def ensure_pricing_config_seeded():
    """Copy the default pricing file into the mounted config volume on first run
    so the user has something on disk to edit."""
    if not PRICING_PATH.exists():
        try:
            PRICING_PATH.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(DEFAULT_PRICING_PATH, PRICING_PATH)
            logger.info("Seeded pricing config at %s", PRICING_PATH)
        except OSError as exc:
            logger.warning("Could not seed pricing config at %s (%s)", PRICING_PATH, exc)


def decode_project_name(dirname: str) -> str:
    """Best-effort reversal of Claude Code's directory-name encoding
    (path separators become '-'). Not guaranteed exact for paths that
    contain literal hyphens, but good enough for display."""
    name = dirname[1:] if dirname.startswith("-") else dirname
    return "/" + name.replace("-", "/")


def empty_totals():
    return {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0, "thinking_tokens": 0, "message_count": 0,
            "cost_usd": 0.0, "cache_savings_usd": 0.0}


def add_usage(totals, usage, model, pricing):
    input_tokens = usage.get("input_tokens", 0) or 0
    output_tokens = usage.get("output_tokens", 0) or 0
    cache_write = usage.get("cache_creation_input_tokens", 0) or 0
    cache_read = usage.get("cache_read_input_tokens", 0) or 0
    # Thinking tokens are a subset of output_tokens (Anthropic bills them as
    # output) — tracked here purely as an informational breakdown, not added
    # again on top of output_tokens for cost.
    output_details = usage.get("output_tokens_details") or {}
    thinking_tokens = output_details.get("thinking_tokens", 0) or 0

    rates = pricing.get(model, pricing.get("default", {}))
    cost = (
        input_tokens * rates.get("input", 0)
        + output_tokens * rates.get("output", 0)
        + cache_write * rates.get("cache_write", 0)
        + cache_read * rates.get("cache_read", 0)
    ) / 1_000_000
    # What those cache-read tokens would have cost at the regular input rate,
    # minus what they actually cost — i.e. money saved by prompt caching.
    cache_savings = max(0.0, cache_read * (rates.get("input", 0) - rates.get("cache_read", 0)) / 1_000_000)

    totals["input_tokens"] += input_tokens
    totals["output_tokens"] += output_tokens
    totals["cache_creation_input_tokens"] += cache_write
    totals["cache_read_input_tokens"] += cache_read
    totals["thinking_tokens"] += thinking_tokens
    totals["message_count"] += 1
    totals["cost_usd"] += cost
    totals["cache_savings_usd"] += cache_savings
    return cost


def parse_timestamp(timestamp):
    """Returns a UTC epoch for a Claude Code log timestamp ('...Z'), or None."""
    if not timestamp:
        return None
    try:
        return calendar.timegm(time.strptime(timestamp[:19], "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return None


def bucket_key(epoch, bucket_seconds):
    """Floors an epoch to a fixed-width bucket label, e.g. '2026-09-17T18:35'."""
    floored = epoch - (epoch % bucket_seconds)
    return time.strftime("%Y-%m-%dT%H:%M", time.gmtime(floored))


def all_bucket_keys(range_start, now, bucket_seconds):
    """Every bucket label from range_start to now, so charts have a linear
    time axis with explicit zero bars instead of gaps between active periods."""
    first = range_start - (range_start % bucket_seconds)
    return [bucket_key(epoch, bucket_seconds) for epoch in range(int(first), int(now) + 1, bucket_seconds)]


def iter_session_files():
    if not PROJECTS_DIR.exists():
        return
    for path in glob.glob(str(PROJECTS_DIR / "*" / "*.jsonl")):
        yield Path(path)


_network_cache = {"key": None, "rows": []}


def load_network_rows():
    """Parsed rows of the netmon log, re-read only when the file changes.
    The collector appends one row a minute, so a year is ~500k lines — not
    something to json-decode on every 2s poll."""
    try:
        stat = NETWORK_LOG_PATH.stat()
    except OSError:
        return []
    cache_key = (stat.st_mtime, stat.st_size)
    if _network_cache["key"] == cache_key:
        return _network_cache["rows"]

    rows = []
    try:
        with open(NETWORK_LOG_PATH, "r", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                epoch = parse_timestamp(row.get("timestamp"))
                if epoch is None:
                    continue
                rows.append({
                    "epoch": epoch,
                    "timestamp": row.get("timestamp"),
                    "sent": row.get("bytes_sent_delta", 0) or 0,
                    "received": row.get("bytes_received_delta", 0) or 0,
                    "sent_cumulative": row.get("bytes_sent_cumulative", 0),
                    "received_cumulative": row.get("bytes_received_cumulative", 0),
                })
    except OSError:
        return []

    _network_cache["key"] = cache_key
    _network_cache["rows"] = rows
    return rows


def compute_network_stats(range_key):
    """Reads the Anthropic network-traffic log written by netmon/collector.py
    (a host-level systemd service — see netmon/README.md). Device-wide, not
    Claude-Code-specific: see that README for why."""
    rows = load_network_rows()
    if not rows:
        return {
            "available": False,
            "bytes_sent_total": 0,
            "bytes_received_total": 0,
            "last_sample_at": None,
            "range": range_key,
            "timeseries": [],
        }

    window_seconds, bucket_seconds = RANGES[range_key]
    now = time.time()
    range_start = now - window_seconds
    buckets = {key: {"sent": 0, "received": 0} for key in all_bucket_keys(range_start, now, bucket_seconds)}
    for row in rows:
        if row["epoch"] < range_start:
            continue
        bucket = buckets.get(bucket_key(row["epoch"], bucket_seconds))
        if bucket is None:
            continue
        bucket["sent"] += row["sent"]
        bucket["received"] += row["received"]

    timeseries = [
        {"bucket": key, "sent": b["sent"], "received": b["received"], "total": b["sent"] + b["received"]}
        for key, b in buckets.items()
    ]

    last = rows[-1]
    return {
        "available": True,
        "bytes_sent_total": last["sent_cumulative"],
        "bytes_received_total": last["received_cumulative"],
        "last_sample_at": last["timestamp"],
        "range": range_key,
        "timeseries": timeseries,
    }


def avg(values):
    return sum(values) / len(values) if values else None


def parse_session_events(path: Path):
    """Extracts the lightweight event list this dashboard needs from one
    session log file, using the per-file cache when the file is unchanged
    (mtime + size) since the last read."""
    try:
        stat = path.stat()
    except OSError:
        return []
    cache_key = (stat.st_mtime, stat.st_size)

    cached = _file_cache.get(path)
    if cached and cached[0] == cache_key:
        return cached[1]

    try:
        with open(path, "r", errors="ignore") as f:
            lines = f.readlines()
    except OSError:
        return []

    events = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        entry_type = entry.get("type")

        if entry_type == "system" and entry.get("subtype") == "turn_duration":
            duration = entry.get("durationMs")
            if isinstance(duration, (int, float)):
                events.append({"kind": "turn_duration", "duration_ms": duration})
            continue

        if entry_type != "assistant":
            continue

        if entry.get("error") == "rate_limit":
            events.append({"kind": "rate_limit", "epoch": parse_timestamp(entry.get("timestamp"))})
            continue

        message = entry.get("message", {})
        usage = message.get("usage")
        model = message.get("model")
        if not usage or not model or model == "<synthetic>":
            continue
        if not (usage.get("input_tokens") or usage.get("output_tokens")
                or usage.get("cache_creation_input_tokens") or usage.get("cache_read_input_tokens")):
            continue

        tools = [item.get("name") or "unknown" for item in (message.get("content") or [])
                 if isinstance(item, dict) and item.get("type") == "tool_use"]

        events.append({
            "kind": "usage",
            "timestamp": entry.get("timestamp"),
            "epoch": parse_timestamp(entry.get("timestamp")),
            "model": model,
            "usage": usage,
            "tools": tools,
        })

    _file_cache[path] = (cache_key, events)
    return events


def evict_missing_files(seen_paths):
    for stale_path in set(_file_cache) - seen_paths:
        _file_cache.pop(stale_path, None)


def compute_stats(token_range, net_range):
    pricing = load_pricing()
    window_seconds, bucket_seconds = RANGES[token_range]

    global_totals = empty_totals()
    by_model = {}
    by_project = {}
    sessions = {}
    chart_buckets = {}  # bucket label -> {model: tokens}
    tool_counts = Counter()
    global_turn_durations_ms = []

    now = time.time()
    range_start = now - window_seconds
    chart_buckets = {key: {} for key in all_bucket_keys(range_start, now, bucket_seconds)}
    today_start = calendar.timegm(time.gmtime(now)[:3] + (0, 0, 0, 0, 0, 0))
    week_start = now - 7 * 24 * 3600

    today_totals = empty_totals()
    week_totals = empty_totals()
    rate_limit_hits = {"today": 0, "week": 0, "total": 0}

    seen_paths = set()
    for path in iter_session_files():
        seen_paths.add(path)
        project_dir = path.parent.name
        project_name = decode_project_name(project_dir)
        session_id = path.stem

        events = parse_session_events(path)
        if not events:
            continue

        session_entry = sessions.get(session_id)
        if session_entry is None:
            session_entry = {
                "session_id": session_id,
                "project": project_name,
                "totals": empty_totals(),
                "first_activity": None,
                "last_activity": None,
                "models": set(),
                "turn_durations_ms": [],
            }
            sessions[session_id] = session_entry

        for event in events:
            if event["kind"] == "turn_duration":
                session_entry["turn_durations_ms"].append(event["duration_ms"])
                global_turn_durations_ms.append(event["duration_ms"])
                continue

            if event["kind"] == "rate_limit":
                epoch = event["epoch"]
                rate_limit_hits["total"] += 1
                if epoch and epoch >= today_start:
                    rate_limit_hits["today"] += 1
                if epoch and epoch >= week_start:
                    rate_limit_hits["week"] += 1
                continue

            # event["kind"] == "usage"
            usage = event["usage"]
            model = event["model"]
            timestamp = event["timestamp"]
            epoch = event["epoch"]

            add_usage(session_entry["totals"], usage, model, pricing)
            session_entry["models"].add(model)
            if timestamp and (session_entry["first_activity"] is None or timestamp < session_entry["first_activity"]):
                session_entry["first_activity"] = timestamp
            if timestamp and (session_entry["last_activity"] is None or timestamp > session_entry["last_activity"]):
                session_entry["last_activity"] = timestamp

            for tool_name in event["tools"]:
                tool_counts[tool_name] += 1

            add_usage(global_totals, usage, model, pricing)

            model_totals = by_model.setdefault(model, empty_totals())
            add_usage(model_totals, usage, model, pricing)

            project_totals = by_project.setdefault(project_name, empty_totals())
            add_usage(project_totals, usage, model, pricing)

            if epoch and epoch >= today_start:
                add_usage(today_totals, usage, model, pricing)
            if epoch and epoch >= week_start:
                add_usage(week_totals, usage, model, pricing)

            if epoch and epoch >= range_start:
                bucket = chart_buckets.get(bucket_key(epoch, bucket_seconds))
                if bucket is not None:
                    tok = (usage.get("input_tokens", 0) or 0) + (usage.get("output_tokens", 0) or 0)
                    bucket[model] = bucket.get(model, 0) + tok

    evict_missing_files(seen_paths)

    session_list = []
    for s in sessions.values():
        if s["totals"]["message_count"] == 0:
            continue
        duration_s = None
        if s["first_activity"] and s["last_activity"]:
            duration_s = parse_timestamp(s["last_activity"]) - parse_timestamp(s["first_activity"])
        session_list.append({
            "session_id": s["session_id"],
            "project": s["project"],
            "totals": s["totals"],
            "first_activity": s["first_activity"],
            "last_activity": s["last_activity"],
            "duration_ms": duration_s * 1000 if duration_s is not None else None,
            "avg_turn_ms": avg(s["turn_durations_ms"]),
            "models": sorted(s["models"]),
        })
    session_list.sort(key=lambda s: s["last_activity"] or "", reverse=True)

    project_list = [{"project": name, "totals": totals} for name, totals in by_project.items()]
    project_list.sort(key=lambda p: p["totals"]["cost_usd"], reverse=True)

    model_list = [{"model": name, "totals": totals} for name, totals in by_model.items()]
    model_list.sort(key=lambda m: m["totals"]["cost_usd"], reverse=True)

    timeseries = [
        {"bucket": key, "by_model": models, "total": sum(models.values())}
        for key, models in chart_buckets.items()
    ]
    model_order = sorted(by_model.keys())

    # Cap distinct tools shown individually to the palette's safe categorical
    # count; fold the long tail into "Other" rather than generating more hues.
    MAX_TOOL_SLOTS = 7
    tool_list = [{"tool": name, "count": count} for name, count in tool_counts.most_common()]
    if len(tool_list) > MAX_TOOL_SLOTS:
        other_count = sum(t["count"] for t in tool_list[MAX_TOOL_SLOTS:])
        tool_list = tool_list[:MAX_TOOL_SLOTS] + [{"tool": "Other", "count": other_count}]

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "global_totals": global_totals,
        "by_model": model_list,
        "model_order": model_order,
        "by_project": project_list,
        "sessions": session_list[:50],
        "range": token_range,
        "bucket_seconds": bucket_seconds,
        "timeseries": timeseries,
        "network": compute_network_stats(net_range),
        "tool_usage": tool_list,
        "avg_turn_duration_ms": avg(global_turn_durations_ms),
        "today": today_totals,
        "week": week_totals,
        "rate_limit_hits": rate_limit_hits,
        "active_sessions_5min": sum(
            1 for s in session_list
            if s["last_activity"] and now - parse_timestamp(s["last_activity"]) < 300
        ),
    }


def get_stats_cached(token_range, net_range):
    key = (token_range, net_range)
    with _cache_lock:
        entry = _cache.get(key)
        if entry is None or (time.time() - entry["computed_at"]) > CACHE_SECONDS:
            entry = {"data": compute_stats(token_range, net_range), "computed_at": time.time()}
            _cache[key] = entry
        return entry["data"]


def range_arg(name):
    value = request.args.get(name, DEFAULT_RANGE)
    return value if value in RANGES else DEFAULT_RANGE


@app.route("/api/stats")
def api_stats():
    return jsonify(get_stats_cached(range_arg("range"), range_arg("net_range")))


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    ensure_pricing_config_seeded()
    logger.info("Watching %s for Claude Code session logs", PROJECTS_DIR)
    serve(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8687")), threads=4)
