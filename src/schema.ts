/**
 * The schema, applied lazily (CREATE … IF NOT EXISTS) on the first request an
 * isolate sees. This is what makes the Deploy button a real one click: no
 * migration step has to run in Cloudflare's build container. `migrations/`
 * carries the same statements for `wrangler d1 migrations apply` users.
 */
export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
     content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 12000),
     tags TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS memories_created_idx ON memories(created_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_clients (
     client_id TEXT PRIMARY KEY, client_name TEXT, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
     code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
     code_challenge_method TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
     token TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, expires_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS clients (
     id TEXT PRIMARY KEY, method TEXT NOT NULL, principal TEXT NOT NULL, label TEXT NOT NULL,
     user_agent TEXT, client_name TEXT, client_version TEXT, protocol_version TEXT,
     last_ip TEXT, last_country TEXT, last_colo TEXT,
     first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
     requests INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, last_tool TEXT)`,
  `CREATE INDEX IF NOT EXISTS clients_last_seen_idx ON clients(last_seen)`,
  `CREATE TABLE IF NOT EXISTS calls (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, rpc_method TEXT NOT NULL, tool TEXT,
     client_id TEXT NOT NULL, auth_method TEXT NOT NULL, user_agent TEXT, ip TEXT, country TEXT, city TEXT,
     colo TEXT, asn_org TEXT, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL DEFAULT 1, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS calls_ts_idx ON calls(ts)`,
  `CREATE INDEX IF NOT EXISTS calls_client_idx ON calls(client_id, ts)`,
];

let ensured: Promise<void> | null = null;

/** Once per isolate. A failure clears the memo so the next request retries. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!ensured) {
    ensured = db.batch(SCHEMA.map((sql) => db.prepare(sql))).then(
      () => undefined,
      (error) => {
        ensured = null;
        throw error;
      },
    );
  }
  return ensured;
}
