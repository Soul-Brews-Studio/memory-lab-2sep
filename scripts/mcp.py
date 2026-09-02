#!/usr/bin/env python3
"""Tiny MCP client over the static token: python3 scripts/mcp.py <initialize|tools/list|status|list_clients|list_calls [n]|recall <q>|remember <text>>"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("BASE", "http://127.0.0.1:8797").rstrip("/")
TOKEN = os.environ.get("API_TOKEN", "")


def call(method: str, params: dict | None = None):
    payload = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        payload["params"] = params
    req = urllib.request.Request(
        f"{BASE}/mcp",
        data=json.dumps(payload).encode(),
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json", "accept": "application/json", "user-agent": "memory-lab-2sep-cli/1"},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read().decode())
    return body, (time.perf_counter() - t0) * 1000


def main() -> int:
    if not TOKEN:
        print("STUCK: API_TOKEN is unset (the static-token door)", file=sys.stderr)
        return 2
    args = sys.argv[1:] or ["status"]
    cmd = args[0]
    if cmd == "initialize":
        body, ms = call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "memory-lab-2sep-cli", "version": "1"}})
        print(f"$ initialize  [{ms:.0f} ms]\n{json.dumps(body['result'], ensure_ascii=False, indent=1)}")
    elif cmd == "tools/list":
        body, ms = call("tools/list")
        print(f"$ tools/list  [{ms:.0f} ms]")
        for t in body["result"]["tools"]:
            print(f"  {t['name']:14} {t['description'].split(' · ')[0][:60]}")
    else:
        tool = {"recall": "recall", "remember": "remember", "status": "status", "list_clients": "list_clients", "list_calls": "list_calls", "memory_stats": "memory_stats", "list_memories": "list_memories"}.get(cmd)
        if not tool:
            print(f"unknown command {cmd}", file=sys.stderr)
            return 2
        arguments: dict = {}
        if tool == "recall":
            arguments = {"query": " ".join(args[1:]) or "ความจำ", "limit": 5}
        elif tool == "remember":
            arguments = {"content": " ".join(args[1:]), "createdBy": "cli"}
        elif tool == "list_calls":
            arguments = {"limit": int(args[1]) if len(args) > 1 else 10}
        body, ms = call("tools/call", {"name": tool, "arguments": arguments})
        print(f"$ tools/call {tool} {json.dumps(arguments, ensure_ascii=False)}  [{ms:.0f} ms]")
        print(body["result"]["content"][0]["text"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
