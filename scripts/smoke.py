#!/usr/bin/env python3
"""End-to-end smoke of a memory-lab-2sep Worker, stdlib only.

  BASE=https://memory-lab-2sep.laris.workers.dev OWNER_PASSPHRASE=… [API_TOKEN=…] python3 scripts/smoke.py

Walks the real doors a client walks: discovery → DCR → PKCE authorize (owner
passphrase) → token → MCP initialize / tools/list / remember (Thai) / recall
(Thai substring) / list_clients / list_calls / status, and the static-token
door if API_TOKEN is set. Prints one line per step with the measured
round-trip time. Never prints a secret.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("BASE", "http://127.0.0.1:8797").rstrip("/")
PASS = os.environ.get("OWNER_PASSPHRASE", "")
API_TOKEN = os.environ.get("API_TOKEN", "")
UA = "memory-lab-2sep-smoke/1 (curl-like)"
TIMES: list[tuple[str, float]] = []


def http(method: str, path: str, body=None, headers=None, form=False, allow_redirect=False):
    url = f"{BASE}{path}"
    data = None
    hdrs = {"user-agent": UA}
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            hdrs["content-type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            hdrs["content-type"] = "application/json"
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    t0 = time.perf_counter()
    try:
        with opener.open(req, timeout=30) as r:
            status, text, rh = r.status, r.read().decode(), dict(r.headers)
    except urllib.error.HTTPError as e:
        status, text, rh = e.code, e.read().decode(), dict(e.headers)
    ms = (time.perf_counter() - t0) * 1000
    TIMES.append((f"{method} {path}", ms))
    return status, text, rh, ms


def step(label: str, ok: bool, detail: str = "", ms: float | None = None):
    mark = "OK " if ok else "FAIL"
    tail = f"  [{ms:.0f} ms]" if ms is not None else ""
    print(f"{mark} {label}{(' — ' + detail) if detail else ''}{tail}")
    if not ok:
        sys.exit(1)


def rpc(token: str, method: str, params=None, rid=1, sse=False):
    headers = {"authorization": f"Bearer {token}", "accept": "application/json, text/event-stream" if sse else "application/json"}
    payload = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        payload["params"] = params
    if method.startswith("notifications/"):
        payload.pop("id")
    status, text, rh, ms = http("POST", "/mcp", payload, headers)
    if status == 202:
        return status, None, rh, ms
    if text.startswith("event:"):
        text = [l[6:] for l in text.splitlines() if l.startswith("data: ")][-1]
    return status, (json.loads(text) if text else None), rh, ms


def main() -> None:
    print(f"# memory-lab-2sep smoke → {BASE}")
    s, t, _, ms = http("GET", "/api/health")
    step("GET /api/health", s == 200, t.strip()[:160], ms)
    s, t, _, ms = http("GET", "/.well-known/oauth-protected-resource/mcp")
    step("discovery: protected resource", s == 200 and '"resource"' in t, json.loads(t)["resource"], ms)
    s, t, _, ms = http("GET", "/.well-known/oauth-authorization-server")
    meta = json.loads(t)
    step("discovery: authorization server", s == 200, f"issuer={meta['issuer']} pkce={meta['code_challenge_methods_supported']}", ms)
    s, t, rh, ms = http("POST", "/mcp", {"jsonrpc": "2.0", "id": 0, "method": "ping"})
    www = rh.get("WWW-Authenticate") or rh.get("www-authenticate", "")
    step("POST /mcp without a token → 401 + resource_metadata", s == 401 and "resource_metadata" in www, www[:110], ms)

    if not PASS:
        print("-- OWNER_PASSPHRASE not set: stopping before the OAuth flow")
        return

    # Dynamic client registration — what claude.ai does first.
    s, t, _, ms = http("POST", "/oauth/register", {"client_name": "smoke-test (curl)", "redirect_uris": ["http://localhost:6274/oauth/callback"]})
    step("DCR: POST /oauth/register", s == 201, f"client_id={json.loads(t)['client_id'][:8]}…", ms)
    client_id = json.loads(t)["client_id"]

    # PKCE S256 + the owner's passphrase on the approval page.
    verifier = secrets.token_urlsafe(48)[:64]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    redirect = "http://localhost:6274/oauth/callback"
    q = urllib.parse.urlencode({"response_type": "code", "client_id": client_id, "redirect_uri": redirect, "code_challenge": challenge, "code_challenge_method": "S256", "state": "xyz", "scope": "memory:rw"})
    s, t, _, ms = http("GET", f"/authorize?{q}")
    step("GET /authorize renders the approval page", s == 200 and "passphrase" in t, f"{len(t)} bytes html", ms)
    s, t, rh, ms = http("POST", "/authorize", {"passphrase": "definitely-wrong", "client_id": client_id, "redirect_uri": redirect, "state": "xyz", "code_challenge": challenge, "code_challenge_method": "S256", "scope": "memory:rw"}, form=True)
    step("POST /authorize wrong passphrase → 401, no redirect", s == 401, "", ms)
    s, t, rh, ms = http("POST", "/authorize", {"passphrase": PASS, "client_id": client_id, "redirect_uri": redirect, "state": "xyz", "code_challenge": challenge, "code_challenge_method": "S256", "scope": "memory:rw"}, form=True)
    loc = rh.get("Location") or rh.get("location", "")
    code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("code", [""])[0]
    step("POST /authorize right passphrase → 302 with code", s == 302 and bool(code), f"→ {loc.split('?')[0]}?code=…&state=xyz", ms)
    s, t, _, ms = http("POST", "/oauth/token", {"grant_type": "authorization_code", "code": code, "client_id": client_id, "redirect_uri": redirect, "code_verifier": verifier}, form=True)
    step("POST /oauth/token (PKCE) → access_token", s == 200 and "access_token" in t, f"expires_in={json.loads(t).get('expires_in')} scope={json.loads(t).get('scope')}", ms)
    token = json.loads(t)["access_token"]
    s, t, _, ms = http("POST", "/oauth/token", {"grant_type": "authorization_code", "code": code, "client_id": client_id, "redirect_uri": redirect, "code_verifier": verifier}, form=True)
    step("replaying the code → invalid_grant", s == 400, "", ms)

    # MCP over the OAuth token — the exact sequence claude.ai sends.
    s, r, _, ms = rpc(token, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "smoke-test", "version": "1.0"}}, sse=True)
    step("MCP initialize (Accept: text/event-stream)", s == 200 and r["result"]["protocolVersion"] == "2025-11-25", f"server={r['result']['serverInfo']['name']} {r['result']['serverInfo']['version']} proto echoed", ms)
    s, r, _, ms = rpc(token, "notifications/initialized")
    step("notifications/initialized → 202 empty", s == 202, "", ms)
    s, r, _, ms = rpc(token, "tools/list", rid=2)
    tools = [x["name"] for x in r["result"]["tools"]]
    step("tools/list", s == 200 and len(tools) >= 9, ", ".join(tools), ms)
    thai = "หน่วยความจำบน Cloudflare Workers ทำจริงได้ — one-click install, ติดตั้งบน claude.ai ได้ (workshop 2 ก.ย. 2569)"
    s, r, _, ms = rpc(token, "tools/call", {"name": "remember", "arguments": {"title": "workshop memo", "content": thai, "tags": ["workshop", "cloudflare"], "createdBy": "smoke"}}, rid=3)
    mem_id = r["result"]["structuredContent"]["id"]
    step("tools/call remember (Thai content)", s == 200 and len(mem_id) == 8, f"id={mem_id}", ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "recall", "arguments": {"query": "ความจำ", "limit": 5}}, rid=4)
    hits = r["result"]["structuredContent"]["hits"]
    step("tools/call recall 'ความจำ' (Thai mid-word substring)", s == 200 and any(h["id"] == mem_id for h in hits), f"{len(hits)} hit(s); first line: {r['result']['content'][0]['text'].splitlines()[0]}", ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "recall", "arguments": {"query": "CLOUDFLARE workers", "limit": 5}}, rid=5)
    step("tools/call recall 'CLOUDFLARE workers' (case-insensitive)", s == 200 and any(h["id"] == mem_id for h in r["result"]["structuredContent"]["hits"]), "", ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "recall", "arguments": {"query": "zzz-not-there-9f1"}}, rid=6)
    step("tools/call recall miss → 0 hits, not an error", s == 200 and r["result"]["structuredContent"]["hits"] == [], "", ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "list_clients", "arguments": {}}, rid=7)
    step("tools/call list_clients", s == 200, r["result"]["content"][0]["text"].replace("\n", " | ")[:300], ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "list_calls", "arguments": {"limit": 5}}, rid=8)
    step("tools/call list_calls", s == 200, r["result"]["content"][0]["text"].replace("\n", " | ")[:300], ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "status", "arguments": {}}, rid=9)
    step("tools/call status", s == 200, r["result"]["content"][0]["text"].replace("\n", " | ")[:400], ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "no_such_tool", "arguments": {}}, rid=10)
    step("unknown tool → isError inside a 200 result", s == 200 and r["result"].get("isError") is True, "", ms)
    s, r, _, ms = rpc(token, "tools/call", {"name": "forget", "arguments": {"id": mem_id}}, rid=11)
    step("tools/call forget (cleanup)", s == 200 and not r["result"].get("isError"), f"forgot {mem_id}", ms)

    if API_TOKEN:
        s, r, _, ms = rpc(API_TOKEN, "tools/call", {"name": "memory_stats", "arguments": {}}, rid=12)
        step("static API_TOKEN door: memory_stats", s == 200, r["result"]["content"][0]["text"].splitlines()[0], ms)
    else:
        print("-- API_TOKEN not set: static-token door not exercised")

    s, t, _, ms = http("GET", "/api/overview", headers={"authorization": f"Bearer {token}"})
    ov = json.loads(t)
    step("GET /api/overview (OAuth token)", s == 200, f"clients={len(ov['clients'])} calls={len(ov['calls'])} access={len(ov['access'])} claudeAi={ov['summary']['claudeAi']}", ms)

    print("\n# latency (ms, this run)")
    mcp = [ms for (label, ms) in TIMES if label == "POST /mcp"]
    other = [ms for (label, ms) in TIMES if label != "POST /mcp"]
    if mcp:
        mcp.sort()
        print(f"POST /mcp   n={len(mcp)} min={mcp[0]:.0f} median={mcp[len(mcp)//2]:.0f} max={mcp[-1]:.0f}")
    if other:
        other.sort()
        print(f"other       n={len(other)} min={other[0]:.0f} median={other[len(other)//2]:.0f} max={other[-1]:.0f}")
    print("# smoke: ALL PASS")


if __name__ == "__main__":
    main()
