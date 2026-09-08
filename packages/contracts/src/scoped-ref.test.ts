import { describe, expect, it } from "vitest";

import {
  formatScopedRef,
  isScopedRef,
  isSourceId,
  parseScopedRef,
  scopedRef,
  scopedRefSchema,
  tryParseScopedRef,
} from "./scoped-ref";

describe("scoped refs", () => {
  it("round-trips format -> parse", () => {
    const s = scopedRef("acme", "user", "12345");
    expect(s).toBe("acme:user:12345");
    expect(parseScopedRef(s)).toEqual({ source: "acme", kind: "user", id: "12345" });
  });

  it("keeps colons inside the id", () => {
    const parsed = parseScopedRef("chat:thread:a:b:c");
    expect(parsed.id).toBe("a:b:c");
    expect(formatScopedRef(parsed)).toBe("chat:thread:a:b:c");
  });

  it("accepts negative chat ids", () => {
    expect(parseScopedRef("acme:chat:-1009876")).toEqual({
      source: "acme",
      kind: "chat",
      id: "-1009876",
    });
  });

  it("accepts any well-formed source slug — a transport picks its own id", () => {
    expect(parseScopedRef("signal:user:1")).toEqual({ source: "signal", kind: "user", id: "1" });
    expect(scopedRefSchema.parse("beta-eu:chat:42")).toBe("beta-eu:chat:42");
    expect(isSourceId("matrix")).toBe(true);
  });

  it("rejects malformed sources, unknown kinds, missing parts, empty ids", () => {
    for (const bad of [
      "Signal:user:1",
      "1tg:user:1",
      "tg_x:user:1",
      ":user:1",
      "acme:project:1",
      "acme:user:",
      "acme:user",
      "acme",
      "",
      "user:acme:1",
    ]) {
      expect(tryParseScopedRef(bad), bad).toBeNull();
      expect(isScopedRef(bad), bad).toBe(false);
      expect(() => parseScopedRef(bad), bad).toThrow();
      expect(scopedRefSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("refuses to format an empty id or a malformed source", () => {
    expect(() => formatScopedRef({ source: "acme", kind: "user", id: "" })).toThrow();
    expect(() => formatScopedRef({ source: "Signal", kind: "user", id: "1" })).toThrow();
  });

  it("validates through the zod schema", () => {
    expect(scopedRefSchema.parse("chat:user:uuid-1")).toBe("chat:user:uuid-1");
  });
});
