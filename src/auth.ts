import { verifyBearer } from "./oauth";
import { SESSION_COOKIE, verifySession } from "./session";
import { readCookie, timingSafeEqual } from "./utils";

/**
 * One gate, three keys (digger-wiki's four minus HA ingress):
 *   api-token      Claude Code / Codex / curl — a static header.
 *   oauth          claude.ai — it cannot send a static header; OAuth is its only door.
 *   owner-session  the dashboard in a browser — a signed cookie.
 * All three land on the same memory with the same rights.
 */
export type AuthMethod = "owner-session" | "api-token" | "oauth";

export interface AuthResult {
  ok: boolean;
  method?: AuthMethod;
  clientId?: string;
  scope?: string;
}

const DENIED: AuthResult = { ok: false };

export interface AuthEnv {
  OWNER_PASSPHRASE?: string;
  API_TOKEN?: string;
}

export async function authenticate(request: Request, env: AuthEnv, db: D1Database): Promise<AuthResult> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const presented = authorization.slice(7).trim();
    const apiToken = env.API_TOKEN?.trim();
    if (apiToken && (await timingSafeEqual(presented, apiToken))) return { ok: true, method: "api-token" };
    const token = await verifyBearer(db, presented);
    if (token) return { ok: true, method: "oauth", clientId: token.clientId, scope: token.scope };
    // A Bearer that matched neither is a definite no; never fall through to the cookie.
    return DENIED;
  }
  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (await verifySession(env.OWNER_PASSPHRASE ?? "", cookie)) return { ok: true, method: "owner-session" };
  return DENIED;
}

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "access-control-max-age": "86400",
};

/**
 * The 401 that starts the OAuth dance. `resource_metadata` is the RFC 9728
 * pointer claude.ai follows to find /authorize; byte-for-byte Arra's header.
 */
export function unauthorized(origin: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", error_description: "Authentication required." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate":
        `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
        `error="invalid_token", error_description="Missing or invalid access token"`,
      ...CORS_HEADERS,
    },
  });
}
