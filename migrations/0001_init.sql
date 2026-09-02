-- memory-lab-2sep — one D1 database holds everything.
-- Every statement is parameterised in src/*.ts; nothing here is interpolated.

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
  tags       TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(created_at);

-- OAuth 2.1 (DCR + PKCE S256), the claude.ai door. Ported from digger-wiki / Arra Memory.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT NOT NULL DEFAULT '',
  expires_at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token      TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at INTEGER
);

-- Who has connected: one row per (auth method, principal). Counters, never credentials.
CREATE TABLE IF NOT EXISTS clients (
  id               TEXT PRIMARY KEY,
  method           TEXT NOT NULL,
  principal        TEXT NOT NULL,
  label            TEXT NOT NULL,
  user_agent       TEXT,
  client_name      TEXT,
  client_version   TEXT,
  protocol_version TEXT,
  last_ip          TEXT,
  last_country     TEXT,
  last_colo        TEXT,
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  requests         INTEGER NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  last_tool        TEXT
);
CREATE INDEX IF NOT EXISTS clients_last_seen_idx ON clients(last_seen);

-- Every JSON-RPC method call on /mcp: what was called, by whom, from where, how long.
-- Stateless: one INSERT per request via ctx.waitUntil; bounded to the newest 2000 rows.
CREATE TABLE IF NOT EXISTS calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  rpc_method  TEXT NOT NULL,
  tool        TEXT,
  client_id   TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT,
  country     TEXT,
  city        TEXT,
  colo        TEXT,
  asn_org     TEXT,
  duration_ms INTEGER NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 1,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS calls_ts_idx ON calls(ts);
CREATE INDEX IF NOT EXISTS calls_client_idx ON calls(client_id, ts);
