import { base64UrlEncode, nowSeconds, randomToken, timingSafeEqual } from "./utils";

/**
 * The owner's browser session for the dashboard: `<issuedAt>.<id>.<HMAC>`
 * signed with the owner passphrase. Simple first: 12 h expiry, no revocation
 * store (logging out clears the cookie; changing the passphrase invalidates
 * every session at once because the key changes).
 */
export const SESSION_COOKIE = "mls_session";
const MAX_AGE_SECONDS = 12 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const PREFIX = "memory-lab-2sep-owner-session-v1";

async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function issueSession(secret: string): Promise<string> {
  const issuedAt = nowSeconds();
  const id = randomToken(18);
  return `${issuedAt}.${id}.${await sign(secret, `${PREFIX}:${issuedAt}:${id}`)}`;
}

/** Every failure is false — a caller must never learn which check failed. */
export async function verifySession(secret: string, token: string | null): Promise<boolean> {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [issuedAtRaw, id, signature] = parts as [string, string, string];
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAt)) return false;
  const age = nowSeconds() - issuedAt;
  if (age < -CLOCK_SKEW_SECONDS || age > MAX_AGE_SECONDS) return false;
  return timingSafeEqual(signature, await sign(secret, `${PREFIX}:${issuedAt}:${id}`));
}

export function sessionCookie(value: string): string {
  return [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", "Secure", `Max-Age=${MAX_AGE_SECONDS}`].join("; ");
}

export function clearSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Secure", "Max-Age=0"].join("; ");
}
