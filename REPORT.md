# REPORT — memory-lab-2sep, measured 2026-09-02 (Asia/Bangkok)

Everything here was produced today by the recipes in `justfile`; the raw logs are in `out/`. Nothing was pushed. No production memory database (thor-memory, arra) was touched.

## 1. What was built

| item | value |
|---|---|
| runtime | Cloudflare Worker, `compatibility_date 2026-08-23`, one D1 binding, no KV, no Durable Object |
| runtime dependencies | **0** (dev: wrangler 4.125.0, typescript 6.0.3, types) |
| source | 1,656 lines TypeScript in `src/` (+ 90 lines of tests), 11 tests pass, `tsc --noEmit` clean |
| bundle | 60.97 KiB, 17.25 KiB gzip; Worker startup 5 ms |
| deploy | `node scripts/deploy.mjs --create` — D1 created by name, uploaded 1.64 s, triggers 1.33 s |
| live | `https://memory-lab-2sep.laris.workers.dev` (Nat's account, `laris.workers.dev`) |
| Cloudflare metrics at 11:47 | 89 invocations, 0 errors, CPU p50 2 ms, wall 98 ms, request duration 75 ms (screenshot `docs/images/13-cloudflare-worker.png`) |

## 2. The loop, end to end (`out/smoke-remote-1137.log`)

24 steps, all pass, from Bangkok against the live Worker (Cloudflare colo BKK):

| step | result | ms |
|---|---|---|
| GET /api/health | `status ok` | 270 (cold) |
| discovery: protected resource / authorization server | `resource=…/mcp`, PKCE `S256` | 199 / 86 |
| POST /mcp without token | 401 + `WWW-Authenticate … resource_metadata=…` | 178 |
| DCR `POST /oauth/register` | 201, client_id | 203 |
| GET /authorize | approval page 2,665 bytes | 146 |
| POST /authorize wrong passphrase | 401, no redirect | 139 |
| POST /authorize right passphrase | 302 → `redirect_uri?code=…&state=xyz` | 198 |
| POST /oauth/token (PKCE) | access_token, `expires_in 2592000`, scope `memory:rw` | 286 |
| replay the code | 400 `invalid_grant` | 166 |
| MCP initialize (`Accept: text/event-stream`) | SSE frame, protocol `2025-11-25` echoed | 153 |
| notifications/initialized | 202 empty | 152 |
| tools/list | 9 tools | 189 |
| tools/call remember (Thai content) | id `4d6375f4` | 198 |
| tools/call recall `ความจำ` | **1 of 1** — matched inside `ความจำบน…` | 303 |
| tools/call recall `CLOUDFLARE workers` | hit (case-insensitive) | 191 |
| recall miss | 0 hits, not an error | 311 |
| list_clients / list_calls / status | ledger rows returned | 183 / 236 / 244 |
| unknown tool | `isError` inside a 200 result | 151 |
| forget | cleaned up | 213 |
| static API_TOKEN door | memory_stats | 105 |
| GET /api/overview | clients=2 calls=14 access=1 | 207 |

`POST /mcp` round-trip from Bangkok: n=14, **min 105 · median 191 · max 311 ms**. The same 24 steps under `wrangler dev --local`: median **11 ms** (`out/`-less; see the local run in the session log).

## 3. Approach × Thai recall × latency × restore

| approach | Thai recall (query `ความจำ`) | latency (measured today) | restore |
|---|---|---|---|
| **memory-lab-2sep** (this) — Workers + D1, substring | 1/1 in smoke, 1/3 on the seeded corpus; matches mid-word, no tokenizer | MCP median 191 ms from BKK; 33–51 ms server-side from BKK callers; 745–761 ms server-side from claude.ai (IAD) | `d1 export` 46 rows / 17,196 B in 7.5 s → local D1 in 10.5 s; counts equal (memories 3 · clients 5 · calls 35) |
| arra-memory-lab — Workers + D1 + Workers AI | keyword `LIKE` + 768-d embeddings (not re-measured today) | `GET /api/info` 72 / 135 / 242 ms from BKK | `d1 export` (same mechanism) |
| digger-wiki-haos — HAOS add-on + tunnel | trigram FTS + Thai vector space; documented 5 Thai-majority chunks of 2,787 | `GET /api/health` 203 / 206 / 204 ms from BKK (through a private tunnel to a home box) | HA backup of `/data` |
| arra-memory / thor-memory — HAOS add-on, libSQL | keyword-only while the embedding host is down (1 Sep finding) | **not measured — production, off-limits** | HA backup of `/data` |
| session-lance-mcp — local LanceDB + Apple NL | ngram-3 FTS + Thai model; 4,148 Thai vectors of 56,600 | local stdio; index build 1,729 s for 56,710 docs (2 Sep 06:52–07:20) | copy `db/*.lance` |

## 4. Who connected, which method, from where (`out/ledger-final.log`)

`list_clients`, 24 h, verbatim minus IPs:

```
claude.ai · Claude            12 req / 3 tool calls · clientInfo Anthropic/ClaudeAI 1.0.0 · proto 2025-11-25→2025-11-25 · from US/IAD · last tool list_calls
token · Claude Code            4 req / 0 tool calls · clientInfo claude-code 2.1.258      · proto 2025-11-25→2025-11-25 · from TH/BKK
token · memory-lab-2sep-cli    9 req / 7 tool calls · clientInfo memory-lab-2sep-cli 1    · proto 2025-06-18→2025-06-18 · from TH/BKK
token · memory-lab-2sep-dig    8 req / 8 tool calls · from TH/BKK · last tool recall
OAuth · smoke-test (curl)     13 req / 9 tool calls · clientInfo smoke-test 1.0          · proto 2025-11-25→2025-11-25 · from TH/BKK
```

`list_calls` for the claude.ai principal — the sequence it sends on **Add** (discovery + tools) and again on **Connect**, then the three tool calls from a chat:

| time (UTC) | method | from | server-side ms |
|---|---|---|---|
| 04:43:50 | `server/discover` | US/IAD | 494 (answered `-32601 method not found`) |
| 04:43:50 | `initialize` | US/IAD | 483 |
| 04:43:51 | `notifications/initialized` | US/IAD | 501 |
| 04:43:52 | `tools/list` | US/IAD | 468 |
| 04:43:54–56 | same four again after Connect | US/IAD | 482–494 |
| 04:45:33 | `tools/call status` | US/IAD | 746 |
| 04:45:46 | `tools/call recall` (`ความจำ`) | US/IAD | 745 |
| 04:46:00 | `tools/call list_calls` | US/IAD | 761 |

Claude Code 2.1.258 sends the same `server/discover` probe before `initialize`. It is not an MCP method; the server answers `-32601` and the ledger records it.

**Finding — where the data lives decides the latency.** The Worker runs in the caller's colo; the D1 database is single-region and was placed near Bangkok on first use. Each request does 3–4 sequential D1 queries (bearer lookup, client label, the tool, the ledger write is async). From BKK that is 33–51 ms server-side; from IAD 468–761 ms. Same code, ~15× slower across the Pacific. Fix candidates for a follow-up: D1 read replication (`Sessions API`), or fewer sequential queries per request (cache the bearer in the isolate).

## 5. Digger fan-out (`out/dig-*.log`)

| query | variants | calls | ms | memories found | found by the literal query alone |
|---|---|---|---|---|---|
| `teamcharter` | `teamcharter`, `team charter`, `charter`, `team` | 4 | 615 | 2 | 1 |
| `memorylab` | `memorylab`, `memory lab`, `memory`, `lab` | 4 | 486 | 3 | 1 |

Same lesson as lab 02 on thor-memory (1 Sep: `teamcharter` 0, `team charter` 3), now with the fan-out running against this server's substring recall: the split still finds what the compound cannot.

## 6. Backup → restore (`out/backup.log`, `out/restore.log`, `out/demo.log`)

```
just backup   d1 export --remote → backup/20260902-1140.sql   17,196 bytes, 46 INSERT rows, 7.5 s wall
just restore  → local D1: {'memories': 3, 'clients': 5, 'calls': 35}
              remote D1: {'memories': 3, 'clients': 5, 'calls': 35}      10.5 s wall
```

The restore target is the local D1 on purpose: the live database is never dropped by a demo recipe. The full `just demo` run at 11:51 (`out/demo.log`) repeated the loop end to end in **42 s**: 11 tests, deploy, smoke ALL PASS, dig 519 ms / 3 memories, backup 101 rows, restore `memories 3 · clients 9 · calls 82` on both sides.

## 7. claude.ai install, verified (`docs/images/03…11`)

- Step 2 of "Add custom connector" detected our discovery documents by itself: *Always required — Detected*, *No client ID — register one automatically — Detected*.
- claude.ai registered client name `Claude`, redirect `https://claude.ai/api/mcp/auth_callback` (04:43:27 UTC), then walked `/authorize` (owner passphrase) → `/oauth/token` (PKCE S256) and showed **Connected to memory-lab-2sep** with the nine tools grouped read-only / write-delete / other.
- In a chat (Opus 5), Claude first ran `tool_search` twice because the connector's tools are *deferred*, then called `status`, `recall`, `list_calls` after one permission prompt each, and quoted the ledger back: *"~745 ms … versus 36–38 ms for the CLI's api-token calls out of TH/BKK. The log is live and includes the reader."*
- New in the claude.ai form today, worth knowing for the older notes that say otherwise: **Additional request headers** (up to four, sent with every MCP request) and **CIMD** (Anthropic-hosted client metadata) as an alternative to DCR.

## 8. Not done / escalations

| item | state |
|---|---|
| Deploy button end to end | repo is public; the button itself was not click-tested. `just deploy` used the same `wrangler.jsonc`. |
| push · publication | published after a five-lens public-safety audit; branch rebuilt as one commit so no pre-scrub blob is in history |
| thor-memory / arra | untouched, including health endpoints |
| D1 dashboard screenshot | captured (`docs/images/14-cloudflare-d1.png`): region **Asia Pacific (APAC)**, 419 queries / 2k rows read / 392 written today, storage 90 kB, 6 tables — confirms the latency finding in §4 |
| CIMD | not implemented (DCR is); claude.ai defaults to DCR when CIMD is unsupported |
