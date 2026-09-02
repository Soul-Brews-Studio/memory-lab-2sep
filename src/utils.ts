/**
 * Pure helpers — no D1, no fetch. Ported from digger-wiki / Arra Memory (MIT,
 * same studio), rewritten for the Workers runtime (no Buffer).
 */

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
export const nowIso = (): string => new Date().toISOString();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Constant-time string compare via equal-length digests: no early exit, no length leak. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

/** URL-safe random token; 32 bytes is the floor for anything bearer-shaped. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** 8 hex chars, the same shape thor-memory ids have (dig.py follows these). */
export function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** RFC 7636 S256: base64url(SHA-256(verifier)), unpadded. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export function clampLimit(value: unknown, fallback: number, max = 100): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

/**
 * A LIKE pattern that matches the query as a literal substring. `%`, `_` and
 * `\` in the query are escaped; the statement must carry `ESCAPE '\'`.
 * Substring match is what makes Thai work: no tokenizer, no word boundary.
 */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 10);
  if (typeof raw === "string") {
    try {
      return parseTags(JSON.parse(raw));
    } catch {
      return raw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10);
    }
  }
  return [];
}
