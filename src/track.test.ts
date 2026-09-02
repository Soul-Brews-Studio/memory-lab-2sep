import { describe, expect, test } from "bun:test";
import { uaFamily, parseSince } from "./track";
import { isClaudeAiClient } from "./oauth";

describe("uaFamily", () => {
  test("names the callers that use the static token", () => {
    expect(uaFamily("claude-code/2.1.257")).toBe("Claude Code");
    expect(uaFamily("Codex/0.152.0")).toBe("Codex");
    expect(uaFamily("curl/8.7.1")).toBe("curl");
    expect(uaFamily("python-httpx/0.27")).toBe("python");
    expect(uaFamily("Mozilla/5.0 (X11)")).toBe("Mozilla");
    expect(uaFamily("")).toBe("unknown");
  });
});

describe("isClaudeAiClient", () => {
  test("only a claude.ai / anthropic callback names claude.ai", () => {
    expect(isClaudeAiClient(["https://claude.ai/api/mcp/auth_callback"])).toBe(true);
    expect(isClaudeAiClient(["https://claude.com/api/mcp/auth_callback"])).toBe(true);
    expect(isClaudeAiClient(["http://localhost:6274/oauth/callback"])).toBe(false);
    expect(isClaudeAiClient(["not a url"])).toBe(false);
  });
});

describe("parseSince", () => {
  test("defaults to 24h", () => {
    expect(parseSince(null)).toBe("24h");
    expect(parseSince("7d")).toBe("7d");
    expect(parseSince("all")).toBe("all");
    expect(parseSince("x")).toBe("24h");
  });
});
