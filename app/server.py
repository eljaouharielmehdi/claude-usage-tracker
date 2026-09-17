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

from flask import Flask, jsonify, send_from_directory

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("claude-usage-tracker")

PROJECTS_DIR = Path(os.environ.get("CLAUDE_PROJECTS_DIR", "/data/projects"))
PRICING_PATH = Path(os.environ.get("PRICING_CONFIG", "/config/pricing.json"))
DEFAULT_PRICING_PATH = Path(__file__).parent / "pricing_defaults.json"
NETWORK_LOG_PATH = Path(os.environ.get("NETWORK_LOG_PATH", "/data/network/anthropic_traffic.jsonl"))
CACHE_SECONDS = float(os.environ.get("REFRESH_SECONDS", "2"))

app = Flask(__name__, static_folder="static", static_url_path="")

_cache_lock = threading.Lock()
_cache = {"computed_at": 0, "data": None}


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
            "cache_read_input_tokens": 0, "thinking_tokens": 0, "message_count": 0, "cost_usd": 0.0}


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

    totals["input_tokens"] += input_tokens
    totals["output_tokens"] += output_tokens
    totals["cache_creation_input_tokens"] += cache_write
    totals["cache_read_input_tokens"] += cache_read
    totals["thinking_tokens"] += thinking_tokens
    totals["message_count"] += 1
    totals["cost_usd"] += cost
    return cost


def parse_timestamp(timestamp):
    """Returns a UTC epoch for a Claude Code log timestamp ('...Z'), or None."""
    if not timestamp:
        return None
    try:
        return calendar.timegm(time.strptime(timestamp[:19], "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return None


def iter_session_files():
    if not PROJECTS_DIR.exists():
        return
    for path in glob.glob(str(PROJECTS_DIR / "*" / "*.jsonl")):
        yield Path(path)


def compute_network_stats():
    """Reads the Anthropic network-traffic log written by netmon/collector.py
    (a host-level systemd service — see netmon/README.md). Device-wide, not
    Claude-Code-specific: see that README for why."""
    unavailable = {
        "available": False,
        "bytes_sent_total": 0,
        "bytes_received_total": 0,
        "last_sample_at": None,
        "timeseries": [],
    }
    if not NETWORK_LOG_PATH.exists():
        return unavailable

    try:
        with open(NETWORK_LOG_PATH, "r", errors="ignore") as f:
            lines = f.readlines()
    except OSError:
        return unavailable

    # Cap how much we parse — at one row/minute this is ~2 weeks of history,
    # comfortably more than the 24h chart needs.
    rows = []
    for line in lines[-20000:]:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    if not rows:
        return unavailable

    now = time.time()
    day_ago = now - 24 * 3600
    hourly_buckets = {}
    for row in rows:
        timestamp = row.get("timestamp")
        epoch = parse_timestamp(timestamp)
        if epoch is None:
            continue
        if epoch < day_ago:
            continue
        bucket_key = timestamp[:13]
        bucket = hourly_buckets.setdefault(bucket_key, {"sent": 0, "received": 0})
        bucket["sent"] += row.get("bytes_sent_delta", 0) or 0
        bucket["received"] += row.get("bytes_received_delta", 0) or 0

    timeseries = [
        {"hour": hour, "sent": b["sent"], "received": b["received"], "total": b["sent"] + b["received"]}
        for hour, b in sorted(hourly_buckets.items())
    ]

    last = rows[-1]
    return {
        "available": True,
        "bytes_sent_total": last.get("bytes_sent_cumulative", 0),
        "bytes_received_total": last.get("bytes_received_cumulative", 0),
        "last_sample_at": last.get("timestamp"),
        "timeseries": timeseries,
    }


def avg(values):
    return sum(values) / len(values) if values else None


def compute_stats():
    pricing = load_pricing()

    global_totals = empty_totals()
    by_model = {}
    by_project = {}
    sessions = {}
    hourly_buckets = {}  # "YYYY-MM-DDTHH" -> {model: tokens}
    tool_counts = Counter()
    global_turn_durations_ms = []

    now = time.time()
    day_ago = now - 24 * 3600
    today_start = calendar.timegm(time.gmtime(now)[:3] + (0, 0, 0, 0, 0, 0))
    week_start = now - 7 * 24 * 3600

    today_totals = empty_totals()
    week_totals = empty_totals()
    rate_limit_hits = {"today": 0, "week": 0, "total": 0}

    for path in iter_session_files():
        project_dir = path.parent.name
        project_name = decode_project_name(project_dir)
        session_id = path.stem

        try:
            with open(path, "r", errors="ignore") as f:
                lines = f.readlines()
        except OSError:
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
                    session_entry["turn_durations_ms"].append(duration)
                    global_turn_durations_ms.append(duration)
                continue

            if entry_type != "assistant":
                continue

            if entry.get("error") == "rate_limit":
                epoch = parse_timestamp(entry.get("timestamp"))
                rate_limit_hits["total"] += 1
                if epoch and epoch >= today_start:
                    rate_limit_hits["today"] += 1
                if epoch and epoch >= week_start:
                    rate_limit_hits["week"] += 1
                continue

            message = entry.get("message", {})
            usage = message.get("usage")
            model = message.get("model")
            if not usage or not model or model == "<synthetic>":
                continue
            if not (usage.get("input_tokens") or usage.get("output_tokens")
                    or usage.get("cache_creation_input_tokens") or usage.get("cache_read_input_tokens")):
                continue

            timestamp = entry.get("timestamp")
            epoch = parse_timestamp(timestamp)

            cost = add_usage(session_entry["totals"], usage, model, pricing)
            session_entry["models"].add(model)
            if timestamp and (session_entry["first_activity"] is None or timestamp < session_entry["first_activity"]):
                session_entry["first_activity"] = timestamp
            if timestamp and (session_entry["last_activity"] is None or timestamp > session_entry["last_activity"]):
                session_entry["last_activity"] = timestamp

            for item in message.get("content", []) or []:
                if isinstance(item, dict) and item.get("type") == "tool_use":
                    tool_counts[item.get("name") or "unknown"] += 1

            add_usage(global_totals, usage, model, pricing)

            model_totals = by_model.setdefault(model, empty_totals())
            add_usage(model_totals, usage, model, pricing)

            project_totals = by_project.setdefault(project_name, empty_totals())
            add_usage(project_totals, usage, model, pricing)

            if epoch and epoch >= today_start:
                add_usage(today_totals, usage, model, pricing)
            if epoch and epoch >= week_start:
                add_usage(week_totals, usage, model, pricing)

            if epoch and epoch >= day_ago:
                bucket_key = timestamp[:13]  # YYYY-MM-DDTHH
                tok = (usage.get("input_tokens", 0) or 0) + (usage.get("output_tokens", 0) or 0)
                bucket = hourly_buckets.setdefault(bucket_key, {})
                bucket[model] = bucket.get(model, 0) + tok

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
        {"hour": hour, "by_model": models, "total": sum(models.values())}
        for hour, models in sorted(hourly_buckets.items())
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
        "timeseries": timeseries,
        "network": compute_network_stats(),
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


def get_stats_cached():
    with _cache_lock:
        if _cache["data"] is None or (time.time() - _cache["computed_at"]) > CACHE_SECONDS:
            _cache["data"] = compute_stats()
            _cache["computed_at"] = time.time()
        return _cache["data"]


@app.route("/api/stats")
def api_stats():
    return jsonify(get_stats_cached())


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    ensure_pricing_config_seeded()
    logger.info("Watching %s for Claude Code session logs", PROJECTS_DIR)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8687")))
