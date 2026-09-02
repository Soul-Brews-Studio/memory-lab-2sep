import { describe, expect, test } from "bun:test";
import { negotiateProtocol, TOOLS } from "./mcp";

describe("negotiateProtocol", () => {
  test("echoes a supported version the client asked for (claude.ai speaks 2025-11-25)", () => {
    expect(negotiateProtocol("2025-11-25")).toBe("2025-11-25");
    expect(negotiateProtocol("2025-06-18")).toBe("2025-06-18");
  });
  test("accepts any well-formed revision, falls back otherwise", () => {
    expect(negotiateProtocol("2027-01-01")).toBe("2027-01-01");
    expect(negotiateProtocol("garbage")).toBe("2026-07-28");
    expect(negotiateProtocol(undefined)).toBe("2026-07-28");
  });
});

describe("tools", () => {
  test("nine tools, unique names, every schema is an object", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(["remember", "recall", "read_memory", "forget", "list_memories", "memory_stats", "list_clients", "list_calls", "status"]);
    for (const t of TOOLS) expect(t.inputSchema.type).toBe("object");
  });
});
