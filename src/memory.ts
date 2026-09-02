import { clampLimit, likePattern, nowIso, parseTags, shortId } from "./utils";

/**
 * The memory itself: authoritative rows, keyword recall.
 *
 * Simple first (Nat, 2026-09-02): no embeddings, no chunks. Recall is a
 * case-insensitive substring match over title, content and tags. Substring
 * is the Thai-safe choice — no tokenizer, no word boundary, so "ความจำ"
 * matches inside "หน่วยความจำ" — the same reason digger-wiki and session-search
 * run trigram FTS for Thai. Measured in REPORT.md.
 */

export interface Memory {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

interface Row {
  id: string;
  title: string;
  content: string;
  tags: string;
  created_by: string;
  created_at: string;
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  title: r.title,
  content: r.content,
  tags: parseTags(r.tags),
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export async function remember(
  db: D1Database,
  input: { content: unknown; title?: unknown; tags?: unknown; createdBy?: unknown },
): Promise<Memory> {
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) throw new Error("content is required");
  if (content.length > 12000) throw new Error("content must be 12000 characters or fewer");
  const memory: Memory = {
    id: shortId(),
    title: typeof input.title === "string" ? input.title.trim().slice(0, 160) : "",
    content,
    tags: parseTags(input.tags),
    createdBy: typeof input.createdBy === "string" ? input.createdBy.trim().slice(0, 80) : "",
    createdAt: nowIso(),
  };
  await db
    .prepare("INSERT INTO memories (id, title, content, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(memory.id, memory.title, memory.content, JSON.stringify(memory.tags), memory.createdBy, memory.createdAt)
    .run();
  return memory;
}

export async function recall(
  db: D1Database,
  input: { query: unknown; limit?: unknown; tag?: unknown; createdBy?: unknown },
): Promise<{ query: string; hits: Memory[]; scanned: number }> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) throw new Error("query is required");
  const limit = clampLimit(input.limit, 10, 50);
  const where = ["(lower(title) LIKE lower(?) ESCAPE '\\' OR lower(content) LIKE lower(?) ESCAPE '\\' OR lower(tags) LIKE lower(?) ESCAPE '\\')"];
  const pattern = likePattern(query);
  const args: unknown[] = [pattern, pattern, pattern];
  if (typeof input.tag === "string" && input.tag.trim()) {
    where.push("lower(tags) LIKE lower(?) ESCAPE '\\'");
    args.push(likePattern(`"${input.tag.trim()}"`));
  }
  if (typeof input.createdBy === "string" && input.createdBy.trim()) {
    where.push("created_by = ?");
    args.push(input.createdBy.trim());
  }
  const [hits, total] = await Promise.all([
    db.prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).bind(...args, limit).all<Row>(),
    db.prepare("SELECT COUNT(*) AS n FROM memories").first<{ n: number }>(),
  ]);
  return { query, hits: hits.results.map(toMemory), scanned: Number(total?.n ?? 0) };
}

export async function getMemory(db: D1Database, id: string): Promise<Memory | null> {
  const row = await db.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first<Row>();
  return row ? toMemory(row) : null;
}

export async function forget(db: D1Database, id: string): Promise<Memory | null> {
  const existing = await getMemory(db, id);
  if (!existing) return null;
  await db.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
  return existing;
}

export async function listMemories(db: D1Database, input: { limit?: unknown; tag?: unknown } = {}): Promise<Memory[]> {
  const limit = clampLimit(input.limit, 20, 100);
  if (typeof input.tag === "string" && input.tag.trim()) {
    const { results } = await db
      .prepare("SELECT * FROM memories WHERE lower(tags) LIKE lower(?) ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
      .bind(likePattern(`"${input.tag.trim()}"`), limit)
      .all<Row>();
    return results.map(toMemory);
  }
  const { results } = await db.prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?").bind(limit).all<Row>();
  return results.map(toMemory);
}

export interface Stats {
  memories: number;
  firstAt: string | null;
  lastAt: string | null;
  tags: Array<{ tag: string; n: number }>;
  createdBy: Array<{ createdBy: string; n: number }>;
}

export async function stats(db: D1Database): Promise<Stats> {
  const [countRes, byRes, tagRes] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM memories"),
    db.prepare("SELECT created_by, COUNT(*) AS n FROM memories GROUP BY created_by ORDER BY n DESC LIMIT 20"),
    db.prepare("SELECT tags FROM memories"),
  ]);
  const c = countRes!.results[0] as { n: number; first_at: string | null; last_at: string | null } | undefined;
  const tagCounts = new Map<string, number>();
  for (const r of tagRes!.results as Array<{ tags: string }>) for (const t of parseTags(r.tags)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  return {
    memories: Number(c?.n ?? 0),
    firstAt: c?.first_at ?? null,
    lastAt: c?.last_at ?? null,
    tags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([tag, n]) => ({ tag, n })),
    createdBy: (byRes!.results as Array<{ created_by: string; n: number }>).map((r) => ({ createdBy: r.created_by, n: Number(r.n) })),
  };
}
