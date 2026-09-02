import { forget, getMemory, listMemories, recall, remember, stats } from "./memory";
import { listCalls, listClients, parseSince, summary, type Since } from "./track";
import { PRODUCT_NAME, VERSION } from "./version";

/**
 * The MCP surface — hand-rolled JSON-RPC over one stateless POST (the Arra /
 * digger-wiki pattern), because an SDK transport built for session management
 * is exactly what a stateless Worker does not want.
 */

/**
 * Newest first. A server MUST answer `initialize` with a version the CLIENT can
 * speak: echo the requested one when supported. Measured against claude.ai
 * 2026-08-28 (Arra): a hard-coded newer version = "connected, no tools".
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiateProtocol(requested: unknown): string {
  if (typeof requested !== "string") return PREFERRED_PROTOCOL_VERSION;
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) return requested;
  return /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PREFERRED_PROTOCOL_VERSION;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result });
const fail = (id: JsonRpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } });
const text = (value: string, structuredContent?: unknown) => ({
  content: [{ type: "text" as const, text: value }],
  ...(structuredContent !== undefined ? { structuredContent } : {}),
});
const toolError = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

const TAGS_PROP = { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 10, description: "Up to 10 short tags." };

export const TOOLS = [
  {
    name: "remember",
    description: "จดจำ · Write one memory (title, content, tags, createdBy). Returns its 8-char id.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 12000 },
        title: { type: "string", maxLength: 160 },
        tags: TAGS_PROP,
        createdBy: { type: "string", maxLength: 80, description: "Who wrote it — an oracle or person name. Shown by memory_stats." },
      },
      required: ["content"],
    },
  },
  {
    name: "recall",
    description:
      "ค้นหาความจำ (substring, ไทยได้) · Recall memories whose title, content or tags contain the query. " +
      "Case-insensitive substring: Thai matches mid-word (no tokenizer). Newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        tag: { type: "string", maxLength: 80 },
        createdBy: { type: "string", maxLength: 80 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_memory",
    description: "อ่านความจำหนึ่งรายการ · Read one memory by id.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "forget",
    description: "ลบความจำ · Delete one memory by id. Returns what was deleted.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: "list_memories",
    description: "รายการความจำล่าสุด · Newest memories (optionally one tag).",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, tag: { type: "string", maxLength: 80 } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_stats",
    description: "สถิติ · Counts: memories, by createdBy, by tag, first/last written.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_clients",
    description:
      "ใครเชื่อมต่ออยู่ · Who has connected: one row per client (OAuth client such as claude.ai, or a user-agent family on the " +
      "static token) with first/last seen, request and tool-call counts, the MCP clientInfo it announced, and the last IP / " +
      "country / Cloudflare colo it came from. `since`: 24h (default), 7d, all.",
    inputSchema: { type: "object", properties: { since: { type: "string", enum: ["24h", "7d", "all"] } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_calls",
    description:
      "เมธอดอะไรถูกเรียก จากไหน · The method-call log: every JSON-RPC method (and tool) with who called it, from which IP / " +
      "country / colo, how long it took, and whether it succeeded. Newest first. Stateless: written per request, read on demand.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
        method: { type: "string", maxLength: 64, description: "e.g. tools/call, initialize, tools/list" },
        client: { type: "string", maxLength: 120, description: "substring of the client id, e.g. oauth: or token:Claude Code" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "status",
    description:
      "สถานะ · What this instance is: name, version, memory count, connections in 24 h by door, claude.ai standing " +
      "(connected / idle / none), top methods and countries in 24 h.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export interface McpContext {
  db: D1Database;
  instanceName: string;
  /** Who is calling, for the two tracking tools' own bookkeeping. */
  principalLabel: string;
}

const line = (m: { id: string; title: string; createdAt: string; createdBy: string; tags: string[]; content: string }, full = false) =>
  `${m.id} · ${m.title || "(untitled)"} · ${m.createdAt.slice(0, 16).replace("T", " ")}${m.createdBy ? ` · by ${m.createdBy}` : ""}` +
  `${m.tags.length ? ` · #${m.tags.join(" #")}` : ""}\n   ${full ? m.content : m.content.replace(/\s+/g, " ").slice(0, 240)}`;

async function callTool(ctx: McpContext, name: string, args: Record<string, unknown>) {
  const { db } = ctx;
  switch (name as ToolName) {
    case "remember": {
      const m = await remember(db, { content: args.content, title: args.title, tags: args.tags, createdBy: args.createdBy });
      return text(`Remembered ${m.id}\n${line(m)}`, m);
    }
    case "recall": {
      const r = await recall(db, { query: args.query, limit: args.limit, tag: args.tag, createdBy: args.createdBy });
      const body = r.hits.length
        ? r.hits.map((m, i) => `${i + 1}. ${line(m)}`).join("\n")
        : `No memory contains “${r.query}” (${r.scanned} memories scanned, substring match).`;
      return text(`${r.hits.length} of ${r.scanned} memories match “${r.query}”\n${body}`, r);
    }
    case "read_memory": {
      const m = await getMemory(db, String(args.id ?? ""));
      if (!m) throw new Error(`No memory with id ${String(args.id ?? "")}`);
      return text(line(m, true), m);
    }
    case "forget": {
      const m = await forget(db, String(args.id ?? ""));
      if (!m) throw new Error(`No memory with id ${String(args.id ?? "")}`);
      return text(`Forgot ${m.id} · ${m.title || "(untitled)"}`, { forgotten: m });
    }
    case "list_memories": {
      const items = await listMemories(db, { limit: args.limit, tag: args.tag });
      return text(items.length ? items.map((m) => line(m)).join("\n") : "No memories yet.", { memories: items });
    }
    case "memory_stats": {
      const s = await stats(db);
      const by = s.createdBy.map((b) => `${b.createdBy || "(anonymous)"} ${b.n}`).join(", ") || "none";
      const tags = s.tags.map((t) => `#${t.tag} ${t.n}`).join(", ") || "none";
      return text(`${s.memories} memories · first ${s.firstAt ?? "–"} · last ${s.lastAt ?? "–"}\nby: ${by}\ntags: ${tags}`, s);
    }
    case "list_clients": {
      const since: Since = parseSince(typeof args.since === "string" ? args.since : undefined);
      const rows = await listClients(db, since);
      const body = rows.length
        ? rows
            .map(
              (c) =>
                `${c.label} · ${c.requests} req / ${c.toolCalls} tool calls · last ${c.lastSeen.slice(0, 19).replace("T", " ")}` +
                `${c.clientName ? ` · clientInfo ${c.clientName}${c.clientVersion ? ` ${c.clientVersion}` : ""}` : ""}` +
                `${c.protocolVersion ? ` · proto ${c.protocolVersion}` : ""}` +
                `${c.lastCountry ? ` · from ${c.lastCountry}${c.lastColo ? `/${c.lastColo}` : ""}` : ""}` +
                `${c.lastTool ? ` · last tool ${c.lastTool}` : ""}`,
            )
            .join("\n")
        : `Nobody connected in the last ${since}.`;
      return text(`${rows.length} client(s) in ${since}\n${body}`, { since, clients: rows });
    }
    case "list_calls": {
      const rows = await listCalls(db, {
        limit: typeof args.limit === "number" ? args.limit : undefined,
        method: typeof args.method === "string" ? args.method : undefined,
        client: typeof args.client === "string" ? args.client : undefined,
      });
      const body = rows.length
        ? rows
            .map(
              (c) =>
                `${c.ts.slice(0, 19).replace("T", " ")} · ${c.rpcMethod}${c.tool ? ` ${c.tool}` : ""} · ${c.clientId}` +
                ` · from ${c.country ?? "?"}${c.colo ? `/${c.colo}` : ""} · ${c.durationMs} ms${c.ok ? "" : ` · ERROR ${c.error ?? ""}`}`,
            )
            .join("\n")
        : "No calls recorded.";
      return text(`${rows.length} call(s), newest first\n${body}`, { calls: rows });
    }
    case "status": {
      const [s, m] = await Promise.all([summary(db), stats(db)]);
      const doors = Object.entries(s.byMethod).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
      const methods = s.methods24h.map((x) => `${x.method}${x.tool ? ` ${x.tool}` : ""} ×${x.n}`).join(", ") || "none";
      const countries = s.countries24h.map((x) => `${x.country ?? "?"} ×${x.n}`).join(", ") || "none";
      const lines = [
        `${ctx.instanceName} ${VERSION} (${PRODUCT_NAME}) — ok`,
        `memories: ${m.memories}`,
        `connections (24h): ${s.total24h} — ${doors} · claude.ai: ${s.claudeAi}`,
        `calls (24h): ${s.calls24h} — ${methods}`,
        `from: ${countries}`,
        `you are: ${ctx.principalLabel}`,
      ];
      return text(lines.join("\n"), { name: ctx.instanceName, version: VERSION, memories: m.memories, ...s });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export interface McpOutcome {
  response: unknown | null;
  tool: string | null;
  clientInfo: { name?: string; version?: string } | null;
  protocolVersion: string | null;
  ok: boolean;
  error: string | null;
}

export async function handleMcp(ctx: McpContext, request: JsonRpcRequest): Promise<McpOutcome> {
  const { method, id, params = {} } = request;
  const base: McpOutcome = { response: null, tool: null, clientInfo: null, protocolVersion: null, ok: true, error: null };

  switch (method) {
    case "initialize": {
      const negotiated = negotiateProtocol(params.protocolVersion);
      const info = params.clientInfo as { name?: string; version?: string } | undefined;
      return {
        ...base,
        clientInfo: info ? { name: typeof info.name === "string" ? info.name.slice(0, 80) : undefined, version: typeof info.version === "string" ? info.version.slice(0, 40) : undefined } : null,
        protocolVersion: `${typeof params.protocolVersion === "string" ? params.protocolVersion : "?"}→${negotiated}`,
        response: ok(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: ctx.instanceName, version: VERSION },
          instructions:
            "One owner's memory on Cloudflare Workers + D1. remember/recall/forget for memories; " +
            "list_clients and list_calls show who is connected and which methods were called from where (stateless ledger).",
        }),
      };
    }
    // Notifications carry no id and MUST NOT be answered.
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
      return base;
    case "ping":
      return { ...base, response: ok(id, {}) };
    case "tools/list":
      return { ...base, response: ok(id, { tools: TOOLS }) };
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === name)) return { ...base, tool: name, ok: false, error: "unknown tool", response: ok(id, toolError(`Unknown tool: ${name}`)) };
      try {
        return { ...base, tool: name, response: ok(id, await callTool(ctx, name, args)) };
      } catch (error) {
        // Tool failures ride inside a successful JSON-RPC result so the model can reason about them.
        const message = error instanceof Error ? error.message : "tool failed";
        return { ...base, tool: name, ok: false, error: message.slice(0, 200), response: ok(id, toolError(message)) };
      }
    }
    default:
      return { ...base, ok: false, error: "method not found", response: fail(id, -32601, `Method not found: ${method}`) };
  }
}
