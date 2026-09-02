import { SCOPE } from "./version";
import { nowIso, nowSeconds, randomToken, sha256Base64Url } from "./utils";

/**
 * A minimal OAuth 2.1 authorization server — enough for an MCP client, no more.
 * Ported from digger-wiki / Arra Memory (proven against claude.ai 2026-08-28),
 * storage moved from bun:sqlite to D1.
 *
 *   - Dynamic Client Registration (RFC 7591): claude.ai registers itself.
 *   - Authorization Code + PKCE S256 (RFC 7636). `plain` is refused.
 *   - Discovery (RFC 8414 + RFC 9728).
 *
 * Deliberately absent: refresh tokens, client secrets, accounts, consent scoping.
 */

const CODE_TTL_SECONDS = 10 * 60;
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface RegisteredClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: string;
}

export interface TokenInfo {
  clientId: string;
  scope: string;
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}

/** RFC 9728. `resource` is the MCP endpoint itself, not the origin. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
  };
}

const CLAUDE_AI_HOST = /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i;

/** True when the client registered a callback on a claude.ai host — the one fact that names claude.ai. */
export function isClaudeAiClient(redirectUris: string[]): boolean {
  return redirectUris.some((uri) => {
    try {
      return CLAUDE_AI_HOST.test(new URL(uri).hostname);
    } catch {
      return false;
    }
  });
}

function parseUris(raw: unknown): string[] {
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export async function registerClient(db: D1Database, input: Record<string, unknown>): Promise<RegisteredClient> {
  const redirectUris = (Array.isArray(input.redirect_uris) ? input.redirect_uris : []).filter(
    (uri): uri is string => typeof uri === "string" && uri.length > 0,
  );
  if (redirectUris.length === 0) throw new Error("redirect_uris is required");
  const clientId = randomToken(16);
  const clientName = typeof input.client_name === "string" ? input.client_name.slice(0, 120) : null;
  const createdAt = nowIso();
  await db
    .prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .bind(clientId, clientName, JSON.stringify(redirectUris), createdAt)
    .run();
  return { clientId, clientName, redirectUris, createdAt };
}

export async function getClient(db: D1Database, clientId: string): Promise<RegisteredClient | null> {
  if (!clientId) return null;
  const row = await db
    .prepare("SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<{ client_id: string; client_name: string | null; redirect_uris: string; created_at: string }>();
  return row ? { clientId: row.client_id, clientName: row.client_name, redirectUris: parseUris(row.redirect_uris), createdAt: row.created_at } : null;
}

/** Exact match only — prefix matching is the classic OAuth open redirect. */
export function isRegisteredRedirect(client: RegisteredClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

export async function issueCode(
  db: D1Database,
  input: { clientId: string; redirectUri: string; codeChallenge: string; codeChallengeMethod: string; scope: string },
): Promise<string> {
  if (input.codeChallengeMethod !== "S256") throw new Error("code_challenge_method must be S256");
  if (!input.codeChallenge) throw new Error("code_challenge is required");
  const code = randomToken(32);
  await db
    .prepare(
      "INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(code, input.clientId, input.redirectUri, input.codeChallenge, input.codeChallengeMethod, input.scope, nowSeconds() + CODE_TTL_SECONDS)
    .run();
  return code;
}

/** Single-use: the code is deleted before any check, so a failed exchange burns it too. */
export async function exchangeCode(
  db: D1Database,
  input: { code: string; clientId: string; redirectUri: string; codeVerifier: string },
): Promise<{ accessToken: string; scope: string; expiresIn: number }> {
  const row = await db
    .prepare("SELECT code, client_id, redirect_uri, code_challenge, scope FROM oauth_codes WHERE code = ? AND expires_at > ?")
    .bind(input.code, nowSeconds())
    .first<{ code: string; client_id: string; redirect_uri: string; code_challenge: string; scope: string }>();
  if (!row) throw new Error("invalid_grant");
  await db.prepare("DELETE FROM oauth_codes WHERE code = ?").bind(input.code).run();
  if (row.client_id !== input.clientId) throw new Error("invalid_grant");
  if (row.redirect_uri !== input.redirectUri) throw new Error("invalid_grant");
  if ((await sha256Base64Url(input.codeVerifier)) !== row.code_challenge) throw new Error("invalid_grant");
  const accessToken = randomToken(32);
  await db
    .prepare("INSERT INTO oauth_tokens (token, client_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(accessToken, row.client_id, row.scope, nowIso(), nowSeconds() + TOKEN_TTL_SECONDS)
    .run();
  return { accessToken, scope: row.scope, expiresIn: TOKEN_TTL_SECONDS };
}

export async function verifyBearer(db: D1Database, token: string): Promise<TokenInfo | null> {
  if (!token) return null;
  const row = await db
    .prepare("SELECT client_id, scope FROM oauth_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(token, nowSeconds())
    .first<{ client_id: string; scope: string }>();
  return row ? { clientId: row.client_id, scope: row.scope } : null;
}

export interface ClientAccess {
  clientId: string;
  clientName: string | null;
  claudeAi: boolean;
  createdAt: string;
  activeTokens: number;
  lastTokenAt: string | null;
}

/** Every registered client with its live-token count — "who has access". */
export async function listAccess(db: D1Database): Promise<ClientAccess[]> {
  const { results } = await db
    .prepare(
      `SELECT c.client_id, c.client_name, c.redirect_uris, c.created_at,
              COUNT(t.token) AS active_tokens, MAX(t.created_at) AS last_token_at
         FROM oauth_clients c
         LEFT JOIN oauth_tokens t ON t.client_id = c.client_id AND (t.expires_at IS NULL OR t.expires_at > ?)
        GROUP BY c.client_id ORDER BY c.created_at DESC`,
    )
    .bind(nowSeconds())
    .all<{ client_id: string; client_name: string | null; redirect_uris: string; created_at: string; active_tokens: number; last_token_at: string | null }>();
  return results.map((r) => ({
    clientId: r.client_id,
    clientName: r.client_name,
    claudeAi: isClaudeAiClient(parseUris(r.redirect_uris)),
    createdAt: r.created_at,
    activeTokens: Number(r.active_tokens ?? 0),
    lastTokenAt: r.last_token_at,
  }));
}

/** Revoke everything a client holds. The registration row survives so the next connect re-authorizes without re-registering. */
export async function revokeClient(db: D1Database, clientId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM oauth_tokens WHERE client_id = ?").bind(clientId),
    db.prepare("DELETE FROM oauth_codes WHERE client_id = ?").bind(clientId),
  ]);
}

/** Housekeeping only — reads already ignore expired rows. */
export async function sweepExpired(db: D1Database): Promise<void> {
  const now = nowSeconds();
  await db.batch([
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
  ]);
}
