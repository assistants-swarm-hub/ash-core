import { turnMetaEnvelope, type TurnToolMeta } from "@assistants-swarm-hub/contracts";
import { describe, expect, it } from "vitest";

import { toolRefusal, turnOf } from "./tools";

const turn: TurnToolMeta = {
  source: "acme",
  chatId: "chat-1",
  assistantId: "a1",
  threadId: null,
  userId: "u1",
  senderIsOwner: false,
  deliveryKind: "reply",
  replyToSourceMessageId: "m1",
};

describe("turnOf", () => {
  it("reads the turn a call is bound to, for this source only", () => {
    expect(turnOf(turnMetaEnvelope(turn), "acme")).toMatchObject({ chatId: "chat-1" });
    expect(turnOf(turnMetaEnvelope(turn), "other")).toBeNull();
    expect(turnOf(undefined, "acme")).toBeNull();
    expect(turnOf({ unrelated: true }, "acme")).toBeNull();
  });
});

describe("toolRefusal", () => {
  it("is an error result carrying the reason as its only text", () => {
    expect(toolRefusal("Nothing was sent.")).toEqual({
      content: [{ type: "text", text: "Nothing was sent." }],
      isError: true,
    });
  });
});
