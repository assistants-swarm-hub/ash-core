import {
  type InboundMessage,
  type PlatformAdapter,
  type PlatformConnection,
  type PlatformHooks,
  type ReplyDeliveryEvent,
  type SourceTrace,
  type TransportDesiredState,
  type TransportPackage,
  type TurnLifecycleEvent,
} from "@assistants-swarm-hub/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { hostedTransport } from "@/server/transports/hosted";

import { startTransportHost, type TransportHost } from "./host";

/**
 * The host, end to end inside one process, with the queue replaced by an
 * array, the trace store by a spy and the store by what the registration
 * would answer: a package is registered, its desired connections opened,
 * its sends go through the connection and are reported, its inbound
 * messages land on the queue as events, its tools are reachable in-process
 * with the turn binding, the pipeline's deliveries and lifecycle reach it
 * as direct calls, a config change reconciles, and close stops it all.
 *
 * The bus module offers the queue and nothing else: a host that opened a
 * publisher or a subscriber would fail here, which is the proof that a
 * hosted transport's deliveries, typing, traces and config changes never
 * touch Redis (step 6 of the item).
 */

const wires = vi.hoisted(() => ({
  queue: [] as Record<string, unknown>[],
  traces: [] as SourceTrace[],
  desired: null as TransportDesiredState | null,
  registerTransport: vi.fn(),
  getSourceMessage: vi.fn(),
  processCallbackPress: vi.fn(),
}));

vi.mock("@assistants-swarm-hub/bus", () => ({
  openQueue: () => ({
    add: async (_name: string, payload: Record<string, unknown>) => {
      wires.queue.push(payload);
    },
    close: async () => undefined,
  }),
}));

vi.mock("@/server/trace/ingest", () => ({
  ingestSourceTrace: (trace: SourceTrace) => {
    wires.traces.push(trace);
  },
}));

vi.mock("@/server/transports/packages", () => ({
  loadTransportPackages: async () => ({
    searched: [],
    loaded: [{ name: "@acme/transport-acme", version: "0.1.0", dir: "/fake", transport: acme }],
    failed: [],
  }),
}));

vi.mock("@/server/transports/service", () => ({
  registerTransport: (...args: unknown[]) => {
    wires.registerTransport(...args);
    return Promise.resolve(wires.desired);
  },
  desiredTransportState: async () => wires.desired,
  getTransport: async () => null,
}));

vi.mock("@/server/source-store/repository", () => ({
  getSourceMessage: (...args: unknown[]) => wires.getSourceMessage(...args),
}));

vi.mock("@/features/self-improvement/server/collect-flows", () => ({
  processCallbackPress: (...args: unknown[]) => wires.processCallbackPress(...args),
}));

// ---- The synthetic package ---------------------------------------------------

interface Raw {
  chatId: string;
  id: string;
  text: string;
}

let hooks: PlatformHooks<Raw> | null = null;
let connection: PlatformConnection & {
  sendMessage: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let sentCount = 0;
let connectShouldFail = false;

function makeConnection(): typeof connection {
  return {
    identity: () => ({
      id: "bot-1",
      identity: { botUsername: "acme_bot", botDisplayName: "Acme Bot" },
    }),
    sendMessage: vi.fn(async (_chatId: string, _text: string, opts?: { replyToSourceMessageId?: string | null }) => ({
      sourceMessageId: `m-${++sentCount}`,
      replyToSourceMessageId: opts?.replyToSourceMessageId ?? null,
    })),
    sendTyping: vi.fn(async () => undefined),
    isDirectChat: async () => false,
    close: vi.fn(async () => undefined),
  };
}

const adapter: PlatformAdapter<Raw> = {
  connect: vi.fn(async (_input, received) => {
    if (connectShouldFail) throw new Error("token rejected by the platform");
    hooks = received;
    connection = makeConnection();
    return connection;
  }),
};

const acme: TransportPackage<Raw> = {
  descriptor: {
    id: "acme",
    name: "Acme Chat",
    connectionConfigSchema: [{ key: "botToken", label: "Bot token", kind: "secret", required: true }],
    maxMessageLength: 2000,
    typingRefreshMs: 5000,
  },
  adapter,
  normalize: async (raw): Promise<InboundMessage> => ({
    chatId: raw.chatId,
    direct: false,
    sourceMessageId: raw.id,
    content: raw.text,
    sentAt: new Date().toISOString(),
    sender: { userId: "u-1", username: "someone", firstName: "Some", lastName: "One" },
  }),
  addressing: () => ({ addressed: true, source: "mention", needsAnalyzer: false }),
  tools: {
    platform: "Acme",
    register(server, runtime) {
      // An input schema, as every real tool has: without one the SDK hands the
      // handler `extra` as its FIRST argument.
      server.registerTool(
        "acme__ping",
        { description: "Echoes the binding.", inputSchema: { note: z.string().optional() } },
        async (_args, extra) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ source: runtime.descriptor.id, meta: extra?._meta ?? null }),
          },
        ],
      }));
    },
  },
};

const desiredRunning: TransportDesiredState = {
  transport: { enabled: true, config: {} },
  connections: [{ id: "c1", assistantId: "a1", config: { botToken: "secret" }, enabled: true }],
};

let host: TransportHost | null = null;

/** The turn's events as the pipeline builds them, for the synthetic chat. */
const turn = {
  correlationId: "chat-1:in-1:a1",
  delivery(text: string): ReplyDeliveryEvent {
    return {
      v: 1,
      eventId: "evt-d",
      occurredAt: new Date().toISOString(),
      correlationId: this.correlationId,
      type: "reply.delivery",
      source: "acme",
      assistantId: "a1",
      chatRef: "acme:chat:chat-1",
      threadId: null,
      replyToSourceMessageId: "in-1",
      text,
      silent: false,
    };
  },
  lifecycle(phase: TurnLifecycleEvent["phase"]): TurnLifecycleEvent {
    return {
      v: 1,
      eventId: `evt-${phase}`,
      occurredAt: new Date().toISOString(),
      correlationId: this.correlationId,
      type: "turn.lifecycle",
      source: "acme",
      assistantId: "a1",
      chatRef: "acme:chat:chat-1",
      sourceMessageId: "in-1",
      threadId: null,
      phase,
    };
  },
};

beforeEach(() => {
  wires.queue.length = 0;
  wires.traces.length = 0;
  wires.desired = desiredRunning;
  wires.registerTransport.mockClear();
  vi.mocked(adapter.connect).mockClear();
  hooks = null;
  sentCount = 0;
  connectShouldFail = false;
});

afterEach(async () => {
  await host?.close();
  host = null;
});

describe("startTransportHost", () => {
  it("registers the package from its descriptor, opens its desired connections and exposes it as hosted", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    expect(host.sources).toEqual(["acme"]);
    expect(wires.registerTransport).toHaveBeenCalledWith({
      id: "acme",
      name: "Acme Chat",
      connectionConfigSchema: acme.descriptor.connectionConfigSchema,
      transportConfigSchema: [],
    });
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapter.connect).mock.calls[0][0]).toEqual({
      connectionId: "c1",
      assistantId: "a1",
      config: { botToken: "secret" },
    });
    const hosted = hostedTransport("acme");
    expect(hosted?.statuses()).toEqual([
      expect.objectContaining({ connectionId: "c1", assistantId: "a1", state: "running", username: "acme_bot" }),
    ]);
  });

  it("sends through the running connection from the outbound port and reports the delivery", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    const hosted = hostedTransport("acme")!;
    await expect(hosted.outbound.sendMessage("chat-1", { text: "hello", assistantId: "a1" })).resolves.toEqual({
      sourceMessageId: "m-1",
    });
    expect(connection.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "hello",
      expect.objectContaining({ replyToSourceMessageId: null, silent: false }),
    );
    const delivered = wires.queue.find((event) => event.type === "message.delivered");
    expect(delivered).toMatchObject({
      source: "acme",
      chat: { id: "chat-1", kind: "group" },
      assistantId: "a1",
      sourceMessageId: "m-1",
      content: "hello",
      running: [{ assistantId: "a1", botId: "bot-1" }],
    });
  });

  it("forwards an inbound message as a transport.message event with the receiver's verdict", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    hooks!.message({ chatId: "chat-1", id: "in-1", text: "hey bot" });
    await vi.waitFor(() => {
      expect(wires.queue.some((event) => event.type === "transport.message")).toBe(true);
    });
    const event = wires.queue.find((e) => e.type === "transport.message")!;
    expect(event).toMatchObject({
      source: "acme",
      receivedBy: "a1",
      chat: { id: "chat-1", kind: "group" },
      message: { sourceMessageId: "in-1", content: "hey bot" },
      receivers: [{ assistantId: "a1", addressing: { addressed: true, source: "mention" } }],
    });
  });

  it("offers the delivery tools plus the package's own, reached in-process with the turn binding", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    const tools = hostedTransport("acme")!.tools!;
    const names = (await tools.listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual(["acme__ping", "reply_to_message", "send_message"]);

    const pinged = await tools.callTool("acme__ping", {}, { binding: "here" });
    expect(JSON.parse(pinged.text)).toEqual({ source: "acme", meta: { binding: "here" } });

    const unbound = await tools.callTool("reply_to_message", { text: "hi" });
    expect(unbound.isError).toBe(true);
    expect(unbound.text).toMatch(/carries no turn binding/);
    expect(connection.sendMessage).not.toHaveBeenCalled();
  });

  it("performs a reply the pipeline hands it directly, reports it and traces it on the turn's correlation", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    const hosted = hostedTransport("acme")!;
    await hosted.turns.deliver(turn.delivery("the answer"));
    expect(connection.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "the answer",
      expect.objectContaining({ replyToSourceMessageId: "in-1", silent: false }),
    );
    expect(wires.queue.find((event) => event.type === "message.delivered")).toMatchObject({
      source: "acme",
      sourceMessageId: "m-1",
      content: "the answer",
      replyToSourceMessageId: "in-1",
    });
    // The deliver trace lands in the store without a bus in between, on the
    // same correlation as the core's inbound and reply traces.
    expect(wires.traces).toEqual([
      expect.objectContaining({
        feature: "bot-messaging",
        action: "deliver",
        assistantId: "a1",
        status: "success",
        trigger: { kind: "transport", actor: "acme:chat:chat-1", correlationId: turn.correlationId },
        outputSummary: "delivered chat-1:m-1",
      }),
    ]);
  });

  it("records a failed delivery as a failed trace and rethrows to the caller", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    connection.sendMessage.mockRejectedValueOnce(new Error("platform said no"));
    await expect(hostedTransport("acme")!.turns.deliver(turn.delivery("the answer"))).rejects.toThrow(
      /platform said no/,
    );
    expect(wires.traces).toEqual([
      expect.objectContaining({
        action: "deliver",
        status: "error",
        error: { message: "platform said no" },
      }),
    ]);
  });

  it("shows typing from the accepted lifecycle until the turn settles", async () => {
    vi.useFakeTimers();
    try {
      host = await startTransportHost({ redisUrl: "redis://test" });
      const hosted = hostedTransport("acme")!;
      hosted.turns.lifecycle(turn.lifecycle("accepted"));
      expect(connection.sendTyping).toHaveBeenCalledTimes(1);
      expect(connection.sendTyping).toHaveBeenCalledWith("chat-1", null);
      // A progress phase keeps the one loop; the refresh interval re-sends.
      hosted.turns.lifecycle({ ...turn.lifecycle("progress"), activity: "memory_search" });
      await vi.advanceTimersByTimeAsync(acme.descriptor.typingRefreshMs);
      expect(connection.sendTyping).toHaveBeenCalledTimes(2);
      hosted.turns.lifecycle(turn.lifecycle("settled"));
      await vi.advanceTimersByTimeAsync(acme.descriptor.typingRefreshMs * 2);
      expect(connection.sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles against the fresh desired state when the core tells it the config changed", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    wires.desired = {
      transport: { enabled: true, config: {} },
      connections: [{ ...desiredRunning.connections[0], enabled: false }],
    };
    hostedTransport("acme")!.reconcile("transport.config.changed");
    await vi.waitFor(() => {
      expect(connection.close).toHaveBeenCalled();
    });
    expect(hostedTransport("acme")!.statuses()).toEqual([]);
  });

  it("collapses a burst of reconciles into serialized applications of the latest state", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    const hosted = hostedTransport("acme")!;
    wires.desired = {
      transport: { enabled: true, config: {} },
      connections: [{ ...desiredRunning.connections[0], config: { botToken: "rotated" } }],
    };
    hosted.reconcile("transport.config.changed");
    hosted.reconcile("transport.config.changed");
    hosted.reconcile("assistant.deleted");
    await vi.waitFor(() => {
      expect(vi.mocked(adapter.connect).mock.calls.at(-1)?.[0]).toEqual({
        connectionId: "c1",
        assistantId: "a1",
        config: { botToken: "rotated" },
      });
    });
    // Restarted once for the rotation; the two later reconciles saw the same
    // state and changed nothing.
    expect(adapter.connect).toHaveBeenCalledTimes(2);
    expect(hosted.statuses()).toEqual([
      expect.objectContaining({ connectionId: "c1", state: "running" }),
    ]);
  });

  it("stops the connections and unregisters the transport on close", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    const live = connection;
    await host.close();
    host = null;
    expect(live.close).toHaveBeenCalled();
    expect(hostedTransport("acme")).toBeNull();
  });

  it("keeps a package whose platform refuses the connection, with the connection in error", async () => {
    connectShouldFail = true;
    host = await startTransportHost({ redisUrl: "redis://test" });
    expect(host.sources).toEqual(["acme"]);
    expect(hostedTransport("acme")!.statuses()).toEqual([
      expect.objectContaining({
        connectionId: "c1",
        state: "error",
        error: expect.stringMatching(/token rejected by the platform/),
      }),
    ]);
  });
});
