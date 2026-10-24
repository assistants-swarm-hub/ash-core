import { describe, expect, it } from "vitest";

import { describeError } from "./errors";

/**
 * The shape Node's fetch actually throws when nothing is listening: a
 * `TypeError` whose message is the useless part and whose `cause` is the
 * whole answer.
 */
const fetchFailure = (cause: unknown): Error =>
  Object.assign(new TypeError("fetch failed"), { cause });

const connectionRefused = (address: string, port: number): Error =>
  Object.assign(new Error(`connect ECONNREFUSED ${address}:${port}`), {
    code: "ECONNREFUSED",
    address,
    port,
  });

describe("describeError", () => {
  it("keeps a plain error's message as it is", () => {
    expect(describeError(new Error("registration refused"))).toBe("registration refused");
  });

  it("names anything that is not an Error at all", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(null)).toBe("null");
    expect(describeError({ status: 500 })).toBe("[object Object]");
  });

  it("unwraps the cause fetch hides its reason in", () => {
    const described = describeError(fetchFailure(connectionRefused("127.0.0.1", 3200)));
    expect(described).toContain("fetch failed");
    expect(described).toContain("connect ECONNREFUSED 127.0.0.1:3200");
  });

  it("reports every address an AggregateError collected, not just the first", () => {
    // What a transport that cannot reach its core actually gets: one entry
    // per address the name resolved to, and no message of its own.
    const aggregate = Object.assign(
      new AggregateError([connectionRefused("::1", 3200), connectionRefused("127.0.0.1", 3200)], ""),
      { code: "ECONNREFUSED" },
    );
    expect(describeError(fetchFailure(aggregate))).toBe(
      "TypeError: fetch failed <- AggregateError (ECONNREFUSED) " +
        "[connect ECONNREFUSED ::1:3200; connect ECONNREFUSED 127.0.0.1:3200]",
    );
  });

  it("adds the error code when the message does not already spell it out", () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    expect(describeError(timeout)).toBe("TimeoutError: The operation was aborted due to timeout");

    const coded = Object.assign(new Error("Socket closed"), { code: "UND_ERR_SOCKET" });
    expect(describeError(coded)).toBe("Socket closed (UND_ERR_SOCKET)");
    // Already in the message: said once, not twice.
    expect(describeError(connectionRefused("127.0.0.1", 3200))).toBe(
      "connect ECONNREFUSED 127.0.0.1:3200",
    );
  });

  it("stops on a cause chain that points back at itself", () => {
    const outer = new Error("outer");
    const inner = new Error("inner");
    Object.assign(outer, { cause: inner });
    Object.assign(inner, { cause: outer });
    const described = describeError(outer);
    expect(described.startsWith("outer <- inner <- outer")).toBe(true);
    expect(described.length).toBeLessThan(200);
  });

  it("describes an error-shaped thing that is not an Error instance", () => {
    // A DOMException, a structured-cloned error, a platform SDK's reject value.
    expect(describeError({ name: "TimeoutError", message: "timed out", code: "ETIMEDOUT" })).toBe(
      "TimeoutError: timed out (ETIMEDOUT)",
    );
  });
});
