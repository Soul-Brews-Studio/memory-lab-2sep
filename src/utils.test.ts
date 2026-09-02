import { describe, expect, test } from "bun:test";
import { base64UrlEncode, likePattern, parseTags, sha256Base64Url, timingSafeEqual } from "./utils";

describe("likePattern", () => {
  test("wraps and escapes LIKE metacharacters; Thai passes through", () => {
    expect(likePattern("ความจำ")).toBe("%ความจำ%");
    expect(likePattern("100%_x\\")).toBe("%100\\%\\_x\\\\%");
  });
});

describe("pkce", () => {
  test("S256 of a known verifier (RFC 7636 appendix B)", async () => {
    expect(await sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  test("base64url has no padding or +/", () => {
    expect(base64UrlEncode(new Uint8Array([251, 255, 254]))).toBe("-__-");
  });
});

describe("timingSafeEqual", () => {
  test("equal and unequal", async () => {
    expect(await timingSafeEqual("abc", "abc")).toBe(true);
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
    expect(await timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("parseTags", () => {
  test("array, json string, csv; capped at 10", () => {
    expect(parseTags(["a", " b ", ""])).toEqual(["a", "b"]);
    expect(parseTags('["x","y"]')).toEqual(["x", "y"]);
    expect(parseTags("p, q")).toEqual(["p", "q"]);
    expect(parseTags(Array.from({ length: 12 }, (_, i) => `t${i}`)).length).toBe(10);
  });
});
