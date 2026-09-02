import { authenticate, CORS_HEADERS, unauthorized, type AuthResult } from "./auth";
import { listMemories, stats } from "./memory";
import { handleMcp, type JsonRpcRequest } from "./mcp";
import {
  authorizationServerMetadata,
  exchangeCode,
  getClient,
  isClaudeAiClient,
  isRegisteredRedirect,
  issueCode,
  listAccess,
  protectedResourceMetadata,
  registerClient,
  revokeClient,
  sweepExpired,
} from "./oauth";
import { approvalPage, dashboardPage } from "./pages";
import { ensureSchema } from "./schema";
import { clearSessionCookie, issueSession, sessionCookie } from "./session";
import { listCalls, listClients, parseSince, principalOf, record, summary, type Principal } from "./track";
import { escapeHtml, timingSafeEqual } from "./utils";
import { PRODUCT_NAME, SCOPE, VERSION } from "./version";

/**
 * memory-lab-2sep — the HTTP surface. A plain route table, no framework, no
 * runtime dependency. Public: health, OAuth discovery + flow, the dashboard
 * shell. Gated (auth.ts): every /api/* that returns data, and /mcp.
 */

export interface Env {
  DB: D1Database;
  OWNER_PASSPHRASE?: string;
  API_TOKEN?: string;
  INSTANCE_NAME?: string;
  PUBLIC_URL?: string;
}

interface Ctx {
  request: Request;
  env: Env;
  exec: ExecutionContext;
  url: URL;
  params: Record<string, string>;
}
type Handler = (ctx: Ctx) => Response | Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}
const routes: Route[] = [];
function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_m, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
}

const instanceName = (env: Env) => env.INSTANCE_NAME?.trim() || PRODUCT_NAME;
const originOf = (request: Request, env: Env) => (env.PUBLIC_URL?.trim() || new URL(request.url).origin).replace(/\/+$/, "");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS_HEADERS, ...headers } });
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });

/** One JSON-RPC message as one SSE frame; the blank line terminates the frame. */
export function sseFrame(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

const mcpMethodNotAllowed = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. This endpoint accepts POST only." } }), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST", ...CORS_HEADERS },
  });

/** Authenticates and, unless told not to, records the request in the ledger (HTTP method + path as the "rpc method"). */
async function gate(ctx: Ctx, options: { count?: boolean } = {}): Promise<{ auth: AuthResult; principal: Principal } | Response> {
  const auth = await authenticate(ctx.request, ctx.env, ctx.env.DB);
  if (!auth.ok) return unauthorized(originOf(ctx.request, ctx.env));
  const principal = await principalOf(ctx.env.DB, auth, ctx.request);
  if (options.count !== false) {
    ctx.exec.waitUntil(record(ctx.env.DB, principal, ctx.request, { rpcMethod: `${ctx.request.method} ${ctx.url.pathname}`, durationMs: 0, ok: true }));
  }
  return { auth, principal };
}

// ── public ────────────────────────────────────────────────────────────────────

route("GET", "/api/health", async ({ env }) => {
  const s = await summary(env.DB);
  return json({ name: instanceName(env), product: PRODUCT_NAME, version: VERSION, status: env.OWNER_PASSPHRASE?.trim() ? "ok" : "unconfigured", connections24h: s.total24h, claudeAi: s.claudeAi, calls24h: s.calls24h });
});
route("GET", "/.well-known/oauth-authorization-server", ({ request, env }) => json(authorizationServerMetadata(originOf(request, env))));
route("GET", "/.well-known/oauth-protected-resource", ({ request, env }) => json(protectedResourceMetadata(originOf(request, env))));
route("GET", "/.well-known/oauth-protected-resource/mcp", ({ request, env }) => json(protectedResourceMetadata(originOf(request, env))));

// ── OAuth ─────────────────────────────────────────────────────────────────────

route("POST", "/oauth/register", async ({ request, env }) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_client_metadata" }, 400);
  }
  try {
    const c = await registerClient(env.DB, body);
    return json({ client_id: c.clientId, client_name: c.clientName, redirect_uris: c.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }, 201);
  } catch (error) {
    return json({ error: "invalid_client_metadata", error_description: error instanceof Error ? error.message : "invalid" }, 400);
  }
});

const badClient = () => new Response("Unknown client or unregistered redirect_uri.", { status: 400, headers: { "content-type": "text/plain" } });

route("GET", "/authorize", async ({ url, env }) => {
  if (!env.OWNER_PASSPHRASE?.trim()) return html("<h1>OWNER_PASSPHRASE is not set on this Worker.</h1>", 503);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const client = await getClient(env.DB, clientId);
  if (!client || !isRegisteredRedirect(client, redirectUri)) return badClient();
  return html(
    approvalPage({
      instanceName: instanceName(env),
      clientName: client.clientName ?? client.clientId,
      claudeAi: isClaudeAiClient(client.redirectUris),
      params: {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: url.searchParams.get("state") ?? "",
        code_challenge: url.searchParams.get("code_challenge") ?? "",
        code_challenge_method: url.searchParams.get("code_challenge_method") ?? "",
        scope: url.searchParams.get("scope") ?? SCOPE,
      },
    }),
  );
});

route("POST", "/authorize", async ({ request, env }) => {
  if (!env.OWNER_PASSPHRASE?.trim()) return html("<h1>OWNER_PASSPHRASE is not set on this Worker.</h1>", 503);
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? "");
  const params = { client_id: f("client_id"), redirect_uri: f("redirect_uri"), state: f("state"), code_challenge: f("code_challenge"), code_challenge_method: f("code_challenge_method"), scope: f("scope") || SCOPE };
  const client = await getClient(env.DB, params.client_id);
  if (!client || !isRegisteredRedirect(client, params.redirect_uri)) return badClient();
  if (!(await timingSafeEqual(f("passphrase"), env.OWNER_PASSPHRASE))) {
    return html(approvalPage({ instanceName: instanceName(env), clientName: client.clientName ?? client.clientId, claudeAi: isClaudeAiClient(client.redirectUris), error: "That passphrase does not match · รหัสผ่านไม่ตรง ลองใหม่", params }), 401);
  }
  try {
    const code = await issueCode(env.DB, { clientId: params.client_id, redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, codeChallengeMethod: params.code_challenge_method, scope: params.scope });
    const target = new URL(params.redirect_uri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    return new Response(null, { status: 302, headers: { location: target.toString() } });
  } catch (error) {
    return new Response(error instanceof Error ? escapeHtml(error.message) : "Authorization failed.", { status: 400 });
  }
});

route("POST", "/oauth/token", async ({ request, env }) => {
  const form = await request.formData();
  if (String(form.get("grant_type")) !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
  try {
    const r = await exchangeCode(env.DB, { code: String(form.get("code") ?? ""), clientId: String(form.get("client_id") ?? ""), redirectUri: String(form.get("redirect_uri") ?? ""), codeVerifier: String(form.get("code_verifier") ?? "") });
    return json({ access_token: r.accessToken, token_type: "Bearer", expires_in: r.expiresIn, scope: r.scope });
  } catch {
    // One opaque error for every failure mode — no probing oracle.
    return json({ error: "invalid_grant" }, 400);
  }
});

// ── dashboard session ─────────────────────────────────────────────────────────

route("POST", "/api/session", async ({ request, env }) => {
  const body = (await request.json().catch(() => ({}))) as { passphrase?: unknown };
  const secret = env.OWNER_PASSPHRASE?.trim();
  if (!secret) return json({ error: "unconfigured" }, 503);
  if (typeof body.passphrase !== "string" || !(await timingSafeEqual(body.passphrase, secret))) return json({ error: "invalid_passphrase" }, 401);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(await issueSession(secret)) });
});
route("DELETE", "/api/session", () => json({ ok: true }, 200, { "set-cookie": clearSessionCookie() }));

// ── gated API ─────────────────────────────────────────────────────────────────

route("GET", "/api/overview", async (ctx) => {
  const g = await gate(ctx);
  if (g instanceof Response) return g;
  const [s, m, clients, calls, access, memories] = await Promise.all([
    summary(ctx.env.DB), stats(ctx.env.DB), listClients(ctx.env.DB, parseSince(ctx.url.searchParams.get("since"))), listCalls(ctx.env.DB, { limit: 50 }), listAccess(ctx.env.DB), listMemories(ctx.env.DB, { limit: 20 }),
  ]);
  return json({ name: instanceName(ctx.env), version: VERSION, you: g.principal.label, summary: s, stats: m, clients, calls, access, memories });
});
route("GET", "/api/clients", async (ctx) => {
  const g = await gate(ctx);
  if (g instanceof Response) return g;
  const since = parseSince(ctx.url.searchParams.get("since"));
  return json({ since, summary: await summary(ctx.env.DB), clients: await listClients(ctx.env.DB, since) });
});
route("GET", "/api/calls", async (ctx) => {
  const g = await gate(ctx);
  if (g instanceof Response) return g;
  const q = ctx.url.searchParams;
  return json({ calls: await listCalls(ctx.env.DB, { limit: Number(q.get("limit") ?? 50), method: q.get("method") ?? undefined, client: q.get("client") ?? undefined }) });
});
route("GET", "/api/memories", async (ctx) => {
  const g = await gate(ctx);
  if (g instanceof Response) return g;
  return json({ stats: await stats(ctx.env.DB), memories: await listMemories(ctx.env.DB, { limit: Number(ctx.url.searchParams.get("limit") ?? 50), tag: ctx.url.searchParams.get("tag") ?? undefined }) });
});
route("GET", "/api/access/clients", async (ctx) => {
  const g = await gate(ctx);
  if (g instanceof Response) return g;
  return json({ clients: await listAccess(ctx.env.DB) });
});
route("DELETE", "/api/access/clients/:id", async (ctx) => {
  const g = await gate(ctx);
  if (g instanceof Response) return g;
  // Only the owner in a browser (or the static token) may revoke — an OAuth client must not revoke its peers.
  if (g.auth.method === "oauth") return json({ error: "forbidden" }, 403);
  await revokeClient(ctx.env.DB, ctx.params.id!);
  return json({ revoked: ctx.params.id });
});

// ── MCP ───────────────────────────────────────────────────────────────────────

route("POST", "/mcp", async (ctx) => {
  const started = Date.now();
  const g = await gate(ctx, { count: false });
  if (g instanceof Response) return g;
  let body: JsonRpcRequest;
  try {
    body = (await ctx.request.json()) as JsonRpcRequest;
  } catch {
    ctx.exec.waitUntil(record(ctx.env.DB, g.principal, ctx.request, { rpcMethod: "parse-error", durationMs: Date.now() - started, ok: false, error: "parse error" }));
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const outcome = await handleMcp({ db: ctx.env.DB, instanceName: instanceName(ctx.env), principalLabel: g.principal.label }, body);
  ctx.exec.waitUntil(
    record(ctx.env.DB, g.principal, ctx.request, {
      rpcMethod: String(body.method ?? "?"),
      tool: outcome.tool,
      clientInfo: outcome.clientInfo,
      protocolVersion: outcome.protocolVersion,
      durationMs: Date.now() - started,
      ok: outcome.ok,
      error: outcome.error,
    }),
  );
  // A notification returns nothing: 202, empty body.
  if (outcome.response === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
  // claude.ai sends `Accept: application/json, text/event-stream` and, given plain JSON, shows "connected, no tools" (Arra, 2026-08-28).
  const accept = ctx.request.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) {
    return new Response(sseFrame(outcome.response), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...CORS_HEADERS },
    });
  }
  return json(outcome.response);
});
route("GET", "/mcp", () => mcpMethodNotAllowed());
route("DELETE", "/mcp", () => mcpMethodNotAllowed());

// ── the dashboard shell (public page; every data call is gated) ───────────────

route("GET", "/", ({ env }) => html(dashboardPage(instanceName(env))));
route("GET", "/index.html", ({ env }) => html(dashboardPage(instanceName(env))));

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const url = new URL(request.url);
    try {
      await ensureSchema(env.DB);
    } catch (error) {
      console.error("[memory-lab-2sep] schema", error instanceof Error ? error.message : String(error));
      return json({ error: "database_unavailable" }, 503);
    }
    let pathMatched = false;
    const allowed: string[] = [];
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      allowed.push(r.method);
      if (r.method !== request.method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        const response = await r.handler({ request, env, exec, url, params });
        // Housekeeping rides on ~1 % of requests; expired rows are ignored on read anyway.
        if (Math.random() < 0.01) exec.waitUntil(sweepExpired(env.DB).catch(() => undefined));
        return response;
      } catch (error) {
        console.error(`[memory-lab-2sep] ${request.method} ${url.pathname}`, error instanceof Error ? (error.stack ?? error.message) : String(error));
        return json({ error: "internal", message: "Request failed; see Worker logs." }, 500);
      }
    }
    if (pathMatched) return json({ error: "method_not_allowed", allow: allowed }, 405, { allow: allowed.join(", ") });
    return url.pathname.startsWith("/api/") ? json({ error: "not_found" }, 404) : new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
