import {
  BUS_EVENTS_CHANNEL,
  type ReplyDeliveryEvent,
  type TurnLifecycleEvent,
} from "@assistants-swarm-hub/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerHostedTransport,
  unregisterHostedTransport,
  type TurnEventSink,
} from "@/server/transports/hosted";

import { publishTurnEvent } from "./turn-events";

/**
 * The router between the pipeline and whoever renders a turn: a source this
 * process runs gets the events as direct calls — a hosted transport through
 * its host (its settle releases the mirror hold here), the web chat through
 * its own sink — and any other gets the same events on the bus.
 */

const releaseHold = vi.hoisted(() => vi.fn(async () => undefined));
const webChat = vi.hoisted(() => ({
  deliver: vi.fn(async () => undefined),
  lifecycle: vi.fn(() => undefined),
}));

vi.mock("@/server/ingest/consumer", () => ({ releaseHold }));
vi.mock("@/features/web-chat/server/delivery", () => ({ webChatTurnSink: () => webChat }));

function delivery(source: string): ReplyDeliveryEvent {
  return {
    v: 1,
    eventId: "evt-1",
    occurredAt: new Date().toISOString(),
    correlationId: "chat-1:11:a1",
    type: "reply.delivery",
    source,
    assistantId: "a1",
    chatRef: `${source}:chat:chat-1`,
    replyToSourceMessageId: "11",
    text: "the answer",
    silent: false,
  };
}

function lifecycle(source: string, phase: TurnLifecycleEvent["phase"]): TurnLifecycleEvent {
  return {
    v: 1,
    eventId: `evt-${phase}`,
    occurredAt: new Date().toISOString(),
    correlationId: "chat-1:11:a1",
    type: "turn.lifecycle",
    source,
    assistantId: "a1",
    chatRef: `${source}:chat:chat-1`,
    sourceMessageId: "11",
    phase,
  };
}

let bus: { channel: string; payload: unknown }[];
let sink: TurnEventSink & { deliver: ReturnType<typeof vi.fn>; lifecycle: ReturnType<typeof vi.fn> };
const publisher = { publish: async (channel: string, payload: unknown) => void bus.push({ channel, payload }) };

beforeEach(() => {
  bus = [];
  releaseHold.mockClear();
  webChat.deliver.mockClear();
  webChat.lifecycle.mockClear();
  sink = { deliver: vi.fn(async () => undefined), lifecycle: vi.fn(() => undefined) };
  registerHostedTransport({
    descriptor: { id: "acme", name: "Acme", connectionConfigSchema: [], maxMessageLength: 1, typingRefreshMs: 1 },
    outbound: {} as never,
    menus: {} as never,
    statuses: () => [],
    tools: null,
    turns: sink,
    reconcile: () => undefined,
  });
});

afterEach(() => unregisterHostedTransport("acme"));

describe("publishTurnEvent", () => {
  it("hands a hosted source's reply to its host directly and nothing to the bus", async () => {
    const event = delivery("acme");
    await publishTurnEvent(event, publisher);
    await vi.waitFor(() => expect(sink.deliver).toHaveBeenCalledWith(event));
    expect(bus).toEqual([]);
  });

  it("keeps a failed direct delivery out of the pipeline (it is the deliver trace's)", async () => {
    sink.deliver.mockRejectedValueOnce(new Error("platform said no"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(publishTurnEvent(delivery("acme"), publisher)).resolves.toBeUndefined();
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/\[acme delivery\]/), "platform said no"));
    } finally {
      error.mockRestore();
    }
  });

  it("renders a hosted source's lifecycle directly and releases the mirror hold on settle", async () => {
    await publishTurnEvent(lifecycle("acme", "accepted"), publisher);
    expect(sink.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ phase: "accepted" }));
    expect(releaseHold).not.toHaveBeenCalled();

    await publishTurnEvent(lifecycle("acme", "settled"), publisher);
    expect(sink.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ phase: "settled" }));
    expect(releaseHold).toHaveBeenCalledWith("acme", "chat-1", "11", "a1");
    expect(bus).toEqual([]);
  });

  it("hands the web chat's reply and lifecycle to its own sink, with no hold and no bus", async () => {
    const reply = delivery("chat");
    await publishTurnEvent(reply, publisher);
    await vi.waitFor(() => expect(webChat.deliver).toHaveBeenCalledWith(reply));
    await publishTurnEvent(lifecycle("chat", "settled"), publisher);
    expect(webChat.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ phase: "settled" }));
    // A web thread has no mirror row to release, and nothing of it reaches
    // the transports' sink or the bus.
    expect(releaseHold).not.toHaveBeenCalled();
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(bus).toEqual([]);
  });

  it("publishes a source run elsewhere's events on the bus, untouched", async () => {
    const reply = delivery("beta");
    const settled = lifecycle("beta", "settled");
    await publishTurnEvent(reply, publisher);
    await publishTurnEvent(settled, publisher);
    expect(bus).toEqual([
      { channel: BUS_EVENTS_CHANNEL, payload: reply },
      { channel: BUS_EVENTS_CHANNEL, payload: settled },
    ]);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(sink.lifecycle).not.toHaveBeenCalled();
    expect(webChat.deliver).not.toHaveBeenCalled();
    // The hold of a source run elsewhere is released by the bus consumer.
    expect(releaseHold).not.toHaveBeenCalled();
  });
});
