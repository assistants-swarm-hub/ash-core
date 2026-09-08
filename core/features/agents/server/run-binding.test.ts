import { describe, expect, it } from "vitest";

import type { AgentRun } from "../types";
import { runTurnBinding, shouldPostReport } from "./run-binding";

/**
 * The two pure decisions the runner takes about a run: which turn it acts in
 * (the assistant's, bound exactly as its starting turn was) and whether its
 * outcome is posted (a quiet run stays quiet unless it failed
 * or fetched a file).
 */

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    chatRef: "acme:chat:42",
    threadId: null,
    createdByUserRef: "acme:user:7",
    assistantId: "asst-1",
    isOwner: true,
    senderIsOwner: true,
    authorityIsOwner: false,
    correlationId: "corr-1",
    restricted: false,
    sourceUrls: ["https://example.com/a"],
    goal: "look it up",
    context: null,
    quiet: false,
    status: "queued",
    report: null,
    error: null,
    steps: 0,
    downloads: [],
    traceId: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("runTurnBinding", () => {
  it("rebuilds the starting turn: chat, assistant, sender, rights, links, correlation", () => {
    expect(runTurnBinding(run({ authorityIsOwner: true, threadId: "topic-9" }))).toEqual({
      source: "acme",
      chatId: "42",
      assistantId: "asst-1",
      userId: "7",
      correlationId: "corr-1",
      senderIsOwner: true,
      authorityIsOwner: true,
      messageUrls: ["https://example.com/a"],
      threadId: "topic-9",
      deliveryKind: "send",
      silentDelivery: true,
    });
  });

  it("speaks unprompted and silently: a send turn whose notes carry no ping", () => {
    const binding = runTurnBinding(run());
    expect(binding.deliveryKind).toBe("send");
    expect(binding.silentDelivery).toBe(true);
  });

  it("falls back to the run id as the correlation when the turn stamped none", () => {
    expect(runTurnBinding(run({ correlationId: null })).correlationId).toBe("run-1");
  });

  it("binds no user when the run has no sender", () => {
    expect(runTurnBinding(run({ createdByUserRef: null })).userId).toBeNull();
  });
});

describe("shouldPostReport", () => {
  const failed = { goalFailed: true };
  const achieved = { goalFailed: false };

  it("posts every ordinary run's outcome", () => {
    expect(shouldPostReport({ quiet: false }, achieved, 0)).toBe(true);
    expect(shouldPostReport({ quiet: false }, failed, 0)).toBe(true);
  });

  it("keeps a quiet run quiet when it achieved its goal without a file", () => {
    expect(shouldPostReport({ quiet: true }, achieved, 0)).toBe(false);
  });

  it("lets a quiet run speak when it failed, or when it fetched a file", () => {
    expect(shouldPostReport({ quiet: true }, failed, 0)).toBe(true);
    expect(shouldPostReport({ quiet: true }, achieved, 1)).toBe(true);
  });
});
