import type { AuthResult } from "./auth";
import { getClient, isClaudeAiClient } from "./oauth";
import { nowSeconds } from "./utils";

/**
 * Who has been calling in, and what they called.
 *
 * Nat's question (digger-wiki, 2026-09-02): "how many devices or services are
 * connected to our service, is claude.ai among them, and which methods do
 * they call from where?" Two tables answer it, written after every gated
 * request through ctx.waitUntil so the caller never waits on the ledger:
 *
 *   clients  one row per (auth method, principal): first/last seen, counters,
 *            the MCP clientInfo it announced on `initialize`, the last IP /
 *            country / Cloudflare colo it came from.
 *   calls    one row per request: JSON-RPC method, tool, who, from where,
 *            duration, ok/error. Bounded to the newest 2000 rows.
 *
 * Stateless by construction: no Durable Object, no socket, no stream. Every
 * request writes its own row; every read is a query. A dashboard refresh IS
 * the live view.
 *
 * Identity (as digger-wiki): an OAuth token's principal is its client_id, and
 * the label says "claude.ai" only when the client REGISTERED a claude.ai
 * callback — Claude Code can also arrive over OAuth. The static token is one
 * secret shared by every script, so the user-agent family is its identity.
 * Nothing here stores a credential.
 */

export type Since = "24h" | "7d" | "all";
export type ClaudeAiState = "connected" | "idle" | "none";

const DAY = 24 * 60 * 60;
const WINDOW: Record<Since, number> = { "24h": DAY, "7d": 7 * DAY, all: 0 };
const KEEP_CALLS = 2000;

export interface Principal {
  method: NonNullable<AuthResult["method"]>;
  principal: string;
  label: string;
}

export const CLAUDE_AI = "claude.ai";

export function uaFamily(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "unknown";
  if (/claude[-_ ]?code|claude[-_]cli/i.test(ua)) return "Claude Code";
  if (/codex/i.test(ua)) return "Codex";
  if (/(^|\s)curl\//i.test(ua) || /^curl\b/i.test(ua)) return "curl";
  if (/^python-httpx|^python-requests|^python-urllib/i.test(ua)) return "python";
  const product = /^([A-Za-z0-9][A-Za-z0-9._+-]*)/.exec(ua);
  return product ? product[1]! : "unknown";
}

export async function principalOf(db: D1Database, auth: AuthResult, request: Request): Promise<Principal> {
  const method = auth.method ?? "owner-session";
  if (method === "oauth") {
    const clientId = auth.clientId ?? "unknown";
    const client = await getClient(db, clientId);
    const name = client?.clientName?.trim() || clientId.slice(0, 8);
    const label = client && isClaudeAiClient(client.redirectUris) ? `${CLAUDE_AI} · ${name}` : `OAuth · ${name}`;
    return { method, principal: clientId, label };
  }
  if (method === "api-token") {
    const family = uaFamily(request.headers.get("user-agent"));
    return { method, principal: family, label: `token · ${family}` };
  }
  return { method, principal: "browser", label: "Browser session" };
}

export interface CallInfo {
  rpcMethod: string;
  tool?: string | null;
  clientInfo?: { name?: string; version?: string } | null;
  protocolVersion?: string | null;
  durationMs: number;
  ok: boolean;
  error?: string | null;
}

interface CfProps {
  colo?: string;
  country?: string;
  city?: string;
  asOrganization?: string;
}

function whereFrom(request: Request) {
  const cf = ((request as Request & { cf?: CfProps }).cf ?? {}) as CfProps;
  return {
    ip: request.headers.get("cf-connecting-ip"),
    country: cf.country ?? request.headers.get("cf-ipcountry"),
    city: cf.city ?? null,
    colo: cf.colo ?? null,
    asnOrg: cf.asOrganization ?? null,
  };
}

/** One request → one calls row + one clients upsert, in a single D1 batch. Never throws. */
export async function record(db: D1Database, p: Principal, request: Request, call: CallInfo): Promise<void> {
  try {
    const now = nowSeconds();
    const from = whereFrom(request);
    const ua = request.headers.get("user-agent");
    const id = `${p.method}:${p.principal}`;
    const tool = call.tool?.trim() || null;
    const statements = [
      db
        .prepare(
          `INSERT INTO clients (id, method, principal, label, user_agent, client_name, client_version, protocol_version,
                                last_ip, last_country, last_colo, first_seen, last_seen, requests, tool_calls, last_tool)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             label = excluded.label, user_agent = excluded.user_agent,
             client_name = COALESCE(excluded.client_name, client_name),
             client_version = COALESCE(excluded.client_version, client_version),
             protocol_version = COALESCE(excluded.protocol_version, protocol_version),
             last_ip = excluded.last_ip, last_country = excluded.last_country, last_colo = excluded.last_colo,
             last_seen = excluded.last_seen, requests = requests + 1,
             tool_calls = tool_calls + excluded.tool_calls, last_tool = COALESCE(excluded.last_tool, last_tool)`,
        )
        .bind(
          id, p.method, p.principal, p.label, ua,
          call.clientInfo?.name ?? null, call.clientInfo?.version ?? null, call.protocolVersion ?? null,
          from.ip, from.country, from.colo, now, now, tool ? 1 : 0, tool,
        ),
      db
        .prepare(
          `INSERT INTO calls (ts, rpc_method, tool, client_id, auth_method, user_agent, ip, country, city, colo, asn_org, duration_ms, ok, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(now, call.rpcMethod, tool, id, p.method, ua, from.ip, from.country, from.city, from.colo, from.asnOrg, Math.max(0, Math.round(call.durationMs)), call.ok ? 1 : 0, call.error ?? null),
    ];
    // Bounded ledger: prune occasionally, not on every write.
    if (Math.random() < 0.05) {
      statements.push(db.prepare(`DELETE FROM calls WHERE id NOT IN (SELECT id FROM calls ORDER BY id DESC LIMIT ${KEEP_CALLS})`));
    }
    await db.batch(statements);
  } catch (error) {
    console.error("[memory-lab-2sep] track: record failed", error instanceof Error ? error.message : String(error));
  }
}

export function parseSince(value: string | null | undefined): Since {
  return value === "7d" || value === "all" ? value : "24h";
}

const iso = (s: number) => new Date(s * 1000).toISOString();

export interface ClientRow {
  id: string;
  method: string;
  principal: string;
  label: string;
  userAgent: string | null;
  clientName: string | null;
  clientVersion: string | null;
  protocolVersion: string | null;
  lastIp: string | null;
  lastCountry: string | null;
  lastColo: string | null;
  firstSeen: string;
  lastSeen: string;
  requests: number;
  toolCalls: number;
  lastTool: string | null;
}

export async function listClients(db: D1Database, since: Since = "24h"): Promise<ClientRow[]> {
  const cutoff = WINDOW[since] ? nowSeconds() - WINDOW[since] : 0;
  const { results } = await db
    .prepare("SELECT * FROM clients WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT 200")
    .bind(cutoff)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: String(r.id),
    method: String(r.method),
    principal: r.method === "oauth" ? String(r.principal).slice(0, 8) : String(r.principal),
    label: String(r.label),
    userAgent: (r.user_agent as string | null) ?? null,
    clientName: (r.client_name as string | null) ?? null,
    clientVersion: (r.client_version as string | null) ?? null,
    protocolVersion: (r.protocol_version as string | null) ?? null,
    lastIp: (r.last_ip as string | null) ?? null,
    lastCountry: (r.last_country as string | null) ?? null,
    lastColo: (r.last_colo as string | null) ?? null,
    firstSeen: iso(Number(r.first_seen)),
    lastSeen: iso(Number(r.last_seen)),
    requests: Number(r.requests),
    toolCalls: Number(r.tool_calls),
    lastTool: (r.last_tool as string | null) ?? null,
  }));
}

export interface CallRow {
  id: number;
  ts: string;
  rpcMethod: string;
  tool: string | null;
  clientId: string;
  authMethod: string;
  userAgent: string | null;
  ip: string | null;
  country: string | null;
  city: string | null;
  colo: string | null;
  asnOrg: string | null;
  durationMs: number;
  ok: boolean;
  error: string | null;
}

export async function listCalls(
  db: D1Database,
  options: { limit?: number; method?: string; client?: string } = {},
): Promise<CallRow[]> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const where: string[] = [];
  const args: unknown[] = [];
  if (options.method) {
    where.push("rpc_method = ?");
    args.push(options.method);
  }
  if (options.client) {
    where.push("client_id LIKE ? ESCAPE '\\'");
    args.push(`%${options.client.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const sql = `SELECT * FROM calls${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, limit).all<Record<string, unknown>>();
  return results.map((r) => ({
    id: Number(r.id),
    ts: iso(Number(r.ts)),
    rpcMethod: String(r.rpc_method),
    tool: (r.tool as string | null) ?? null,
    clientId: String(r.client_id),
    authMethod: String(r.auth_method),
    userAgent: (r.user_agent as string | null) ?? null,
    ip: (r.ip as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    colo: (r.colo as string | null) ?? null,
    asnOrg: (r.asn_org as string | null) ?? null,
    durationMs: Number(r.duration_ms),
    ok: Number(r.ok) === 1,
    error: (r.error as string | null) ?? null,
  }));
}

export interface Summary {
  total24h: number;
  byMethod: Record<string, number>;
  claudeAi: ClaudeAiState;
  calls24h: number;
  methods24h: Array<{ method: string; tool: string | null; n: number }>;
  countries24h: Array<{ country: string | null; n: number }>;
}

/** The 24 h roll-up: how many, by which door, which methods, from which countries, and claude.ai's standing. */
export async function summary(db: D1Database): Promise<Summary> {
  const now = nowSeconds();
  const cutoff = now - DAY;
  const [byMethodRes, callsRes, methodsRes, countriesRes, liveRes, recentRes] = await db.batch([
    db.prepare("SELECT method, COUNT(*) AS n FROM clients WHERE last_seen >= ? GROUP BY method").bind(cutoff),
    db.prepare("SELECT COUNT(*) AS n FROM calls WHERE ts >= ?").bind(cutoff),
    db.prepare("SELECT rpc_method AS method, tool, COUNT(*) AS n FROM calls WHERE ts >= ? GROUP BY rpc_method, tool ORDER BY n DESC LIMIT 30").bind(cutoff),
    db.prepare("SELECT country, COUNT(*) AS n FROM calls WHERE ts >= ? GROUP BY country ORDER BY n DESC LIMIT 10").bind(cutoff),
    db
      .prepare(
        `SELECT DISTINCT c.client_id, c.redirect_uris FROM oauth_clients c
           JOIN oauth_tokens t ON t.client_id = c.client_id AND (t.expires_at IS NULL OR t.expires_at > ?)`,
      )
      .bind(now),
    db.prepare("SELECT principal FROM clients WHERE method = 'oauth' AND last_seen >= ?").bind(cutoff),
  ]);
  const byMethod: Record<string, number> = {};
  for (const r of byMethodRes!.results as Array<{ method: string; n: number }>) byMethod[r.method] = Number(r.n);
  const live = (liveRes!.results as Array<{ client_id: string; redirect_uris: string }>).filter((c) => {
    try {
      const uris: unknown = JSON.parse(c.redirect_uris);
      return Array.isArray(uris) && isClaudeAiClient(uris.filter((u): u is string => typeof u === "string"));
    } catch {
      return false;
    }
  });
  const recent = new Set((recentRes!.results as Array<{ principal: string }>).map((r) => r.principal));
  const claudeAi: ClaudeAiState = live.length === 0 ? "none" : live.some((c) => recent.has(c.client_id)) ? "connected" : "idle";
  return {
    total24h: Object.values(byMethod).reduce((a, b) => a + b, 0),
    byMethod,
    claudeAi,
    calls24h: Number((callsRes!.results[0] as { n: number } | undefined)?.n ?? 0),
    methods24h: (methodsRes!.results as Array<{ method: string; tool: string | null; n: number }>).map((r) => ({ method: r.method, tool: r.tool, n: Number(r.n) })),
    countries24h: (countriesRes!.results as Array<{ country: string | null; n: number }>).map((r) => ({ country: r.country, n: Number(r.n) })),
  };
}
