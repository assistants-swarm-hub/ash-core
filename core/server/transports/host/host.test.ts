import {
  CONTRACT_MAJOR,
  type InboundMessage,
  type PlatformAdapter,
  type PlatformConnection,
  type PlatformHooks,
  type TransportDesiredState,
  type TransportPackage,
} from "@assistants-swarm-hub/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { hostedTransport } from "@/server/transports/hosted";

import { startTransportHost, type TransportHost } from "./host";

/**
 * The host, end to end inside one process, with the bus and the queue
 * replaced by arrays and the store by what the registration would answer:
 * a package is registered, its desired connections opened, its sends go
 * through the connection and are reported, its inbound messages land on the
 * queue as events, its tools are reachable in-process with the turn
 * binding, a config change reconciles, and close stops it all.
 */

const wires = vi.hoisted(() => ({
  queue: [] as Record<string, unknown>[],
  bus: [] as Record<string, unknown>[],
  subscribers: [] as ((payload: unknown) => void)[],
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
  openPublisher: () => ({
    publish: async (_channel: string, payload: Record<string, unknown>) => {
      wires.bus.push(payload);
    },
    close: async () => undefined,
  }),
  openSubscriber: async (_url: string, _channel: string, onMessage: (payload: unknown) => void) => {
    wires.subscribers.push(onMessage);
    return { close: async () => undefined };
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
let connection: PlatformConnection & { sendMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
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

beforeEach(() => {
  wires.queue.length = 0;
  wires.bus.length = 0;
  wires.subscribers.length = 0;
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
  it("registers the package as the core's own, opens its desired connections and exposes it as hosted", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    expect(host.sources).toEqual(["acme"]);
    expect(wires.registerTransport).toHaveBeenCalledWith({
      id: "acme",
      name: "Acme Chat",
      contractMajor: CONTRACT_MAJOR,
      baseUrl: "",
      mcpPath: "in-process",
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

  it("reconciles against the fresh desired state when its config changes on the bus", async () => {
    host = await startTransportHost({ redisUrl: "redis://test" });
    wires.desired = {
      transport: { enabled: true, config: {} },
      connections: [{ ...desiredRunning.connections[0], enabled: false }],
    };
    for (const deliver of wires.subscribers) {
      deliver({ type: "transport.config.changed", transport: "acme" });
    }
    await vi.waitFor(() => {
      expect(connection.close).toHaveBeenCalled();
    });
    expect(hostedTransport("acme")!.statuses()).toEqual([]);
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
