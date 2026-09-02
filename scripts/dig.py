#!/usr/bin/env python3
"""Query fan-out digger for memory-lab-2sep — find memories without guessing the
exact phrasing they were written with.

Learned from ψ/lab/02-arra-memory-digger (2026-09-01, thor-memory): a one-word
query `teamcharter` found 0 memories while `team charter` found 3, because
keyword recall matches tokens. This server's recall is a substring match, so a
compound already finds less than its parts only when the parts are written
apart — the fan-out still helps: it splits compounds, camelCase, hyphens and
underscores, tries each part, follows 8-hex memory ids referenced inside hits,
dedupes by id and ranks by how many variants matched. Read-only: only `recall`
and `read_memory` are called.

  BASE=… API_TOKEN=… python3 scripts/dig.py memorylab
  python3 scripts/dig.py "team charter" --json --depth 0
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict

BASE = os.environ.get("BASE", "http://127.0.0.1:8797").rstrip("/")
TOKEN = os.environ.get("API_TOKEN", "")
MEMORY_REF = re.compile(r"(?<![0-9a-f])([0-9a-f]{8})(?![0-9a-f])", re.I)
CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
WORDS = {"agent", "api", "charter", "claude", "cloud", "cloudflare", "code", "digger", "lab", "memory", "mcp", "oracle", "team", "thor", "tool", "worker", "workshop", "sep"}


def split_compound(word: str) -> list[str]:
    lower = word.lower()
    scored = []
    for i in range(2, len(lower) - 1):
        left, right = lower[:i], lower[i:]
        known = int(left in WORDS) + int(right in WORDS)
        if known:
            scored.append((known, f"{left} {right}"))
    if scored:
        best = max(s for s, _ in scored)
        return [v for s, v in scored if s == best]
    return []


def variants(raw: str) -> list[str]:
    base = " ".join(raw.split())
    out = {base, CAMEL.sub(" ", base).replace("_", " ").replace("-", " ")}
    if not re.search(r"[\s_-]", base) and len(base) >= 6:
        out.update(split_compound(base))
    parts = [p for v in list(out) for p in re.findall(r"[A-Za-z0-9]+|[฀-๿]+", v) if len(p) >= 3]
    out.update(parts)
    return sorted(out, key=lambda v: (v != base, -len(v), v))


def rpc(tool: str, arguments: dict):
    req = urllib.request.Request(
        f"{BASE}/mcp",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}).encode(),
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json", "accept": "application/json", "user-agent": "memory-lab-2sep-dig/1"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode())
    return body["result"].get("structuredContent") or {}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("query", nargs="+")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--depth", type=int, default=1, help="reference-following depth (0 = off)")
    a = ap.parse_args()
    if not TOKEN:
        print("STUCK: API_TOKEN is unset", file=sys.stderr)
        return 2
    raw = " ".join(a.query)
    memories: dict[str, dict] = {}
    via: dict[str, set[str]] = defaultdict(set)
    t0 = time.perf_counter()
    calls = 0
    vs = variants(raw)
    for v in vs:
        calls += 1
        for m in rpc("recall", {"query": v, "limit": a.limit}).get("hits", []):
            memories[m["id"]] = m
            via[m["id"]].add(f"query:{v}")
    frontier = set(memories)
    followed: set[str] = set()
    for _ in range(a.depth):
        refs = {r.lower() for mid in frontier for r in MEMORY_REF.findall(memories[mid].get("content", "")) if r.lower() != mid.lower() and r.lower() not in followed}
        if not refs:
            break
        frontier = set()
        for ref in sorted(refs):
            followed.add(ref)
            calls += 1
            try:
                m = rpc("read_memory", {"id": ref})
            except Exception:
                continue
            if m.get("id"):
                memories[m["id"]] = m
                via[m["id"]].add(f"reference:{ref}")
                frontier.add(m["id"])
    ms = (time.perf_counter() - t0) * 1000
    ranked = sorted(memories.values(), key=lambda m: (-len(via[m["id"]]), m.get("createdAt", ""), m["id"]))
    report = [{"id": m["id"], "title": m.get("title", ""), "createdAt": m.get("createdAt", ""), "matched-via": sorted(via[m["id"]])} for m in ranked]
    if a.json:
        print(json.dumps({"query": raw, "variants": vs, "calls": calls, "ms": round(ms), "memories": report}, ensure_ascii=False, indent=2))
    else:
        print(f"dig “{raw}” → {len(vs)} variants {vs} · {calls} recall/read calls · {ms:.0f} ms · {len(report)} memories")
        for r in report:
            print(f"{r['id']} | {r['title'] or '(untitled)'} | {r['createdAt'][:16]} | matched-via={','.join(r['matched-via'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
