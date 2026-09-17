#!/usr/bin/env bash
# Idempotent setup for Anthropic network-traffic accounting.
#
# Creates two ipsets (IPv4 + IPv6) that the collector keeps populated with
# Anthropic's resolved IPs, and a pair of counting-only iptables/ip6tables
# chains that tally bytes to/from members of those sets. The counting rules
# are created exactly once and never flushed, so their byte counters
# accumulate indefinitely (only ipset *membership* changes on refresh) — that
# accumulation is what "all-time total" reads from later.
#
# Safe by construction: the jump into each accounting chain sends every
# packet through it, but the chain itself uses RETURN (falls back to the
# calling chain's normal processing) — nothing here ever ACCEPTs or DROPs
# a packet, it only counts. Existing ufw rules are completely unaffected.
set -euo pipefail

ipset create anthropic_v4 hash:ip timeout 3600 -exist
ipset create anthropic_v6 hash:ip family inet6 timeout 3600 -exist

setup_chain() {
  local table_cmd="$1" chain="$2" base_chain="$3" set_name="$4" direction="$5"
  $table_cmd -N "$chain" 2>/dev/null || true
  # Only add the counting rule if this exact chain is still empty (first run) —
  # never flush an existing chain, that would zero out the accumulated counter.
  if [ "$($table_cmd -S "$chain" | wc -l)" -eq 1 ]; then
    $table_cmd -A "$chain" -m set --match-set "$set_name" "$direction" -j RETURN
  fi
  $table_cmd -C "$base_chain" -j "$chain" 2>/dev/null || $table_cmd -I "$base_chain" 1 -j "$chain"
}

setup_chain iptables  ANTHROPIC_OUT  OUTPUT anthropic_v4 dst
setup_chain iptables  ANTHROPIC_IN   INPUT  anthropic_v4 src
setup_chain ip6tables ANTHROPIC_OUT6 OUTPUT anthropic_v6 dst
setup_chain ip6tables ANTHROPIC_IN6  INPUT  anthropic_v6 src

echo "Anthropic accounting chains ready."
