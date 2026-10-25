import "server-only";

import {
  type SendContext,
  type TransportPackage,
  type TransportRuntime,
} from "@assistants-swarm-hub/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { describeError } from "@/lib/describe-error";
import { getEnv } from "@/server/env";
import { InProcessTransport } from "@/server/mcp/in-process-transport";
import { toToolCallResult, type McpListedTool } from "@/server/mcp/openai-tools";
import {
  recordTransportLoadFailures,
  registerHostedTransport,
  unregisterHostedTransport,
  type HostedTransportTools,
} from "@/server/transports/hosted";
import { loadTransportPackages, type LoadedTransportPackage } from "@/server/transports/packages";

import { ConnectionManager } from "./connections";
import { inProcessCoreApi, registerHostedTransportRow } from "./core-api";
import { startDelivery } from "./delivery";
import { registerDeliveryTools } from "./delivery-tools";
import { hostedMenus, hostedOutboundPort } from "./outbound";
import { hostedTraceClient } from "./traces";
import { openUpdatePublisher } from "./updates";

/**
 * The host: runs every transport package installed into this core
 * (`docs/TODO.md`, "Transports as packages the core hosts in-process").
 *
 * For each package it does what `startTransportService` did for a transport
 * run as its own service, minus the wire: register (a row, not a request),
 * reconcile the connections from the desired state and again on every
 * change, dedupe shared chats, assemble and publish every event, perform
 * deliveries and drive typing, perform the sends the core drives, host the
 * delivery tools and the transport's own on a server of its own, and shut
 * it all down in order. Everything the core says to a hosted transport is a
 * direct call through the registry (`server/transports/hosted.ts`): the
 * pipeline hands over each reply and lifecycle phase, a settings write hands
 * over the reconcile, and the transport's traces settle straight into the
 * trace store. The transport-updates queue stays the ingest's entrance — a
 * durable, ordered buffer in front of the store, not a boundary.
 *
 * One package failing to start is logged and skipped: the rest run, and the
 * roster says what is missing. Nothing here names a platform.
 */

export interface TransportHost {
  /** The source ids running. */
  sources: string[];
  close(): Promise<void>;
}

interface HostedRuntime {
  close(): Promise<void>;
}

/**
 * Env-gated starter for boot: the host needs the store (its registration
 * row, the desired state) and Redis (the transport-updates queue), like the
 * ingest.
 */
export async function startTransportHostFromEnv(): Promise<TransportHost | null> {
  const env = getEnv();
  if (!env.REDIS_URL || !env.DATABASE_URL) return null;
  return startTransportHost({ redisUrl: env.REDIS_URL });
}

export async function startTransportHost(input: { redisUrl: string }): Promise<TransportHost> {
  const packages = await loadTransportPackages();
  for (const pkg of packages.failed) {
    console.error(`Transport package ${pkg.name} in ${pkg.dir} not loaded: ${pkg.error}`);
  }
  // The roster names each by package, with the reason, next to what runs.
  recordTransportLoadFailures(packages.failed.map(({ name, error }) => ({ name, error })));
  if (packages.loaded.length === 0 && packages.failed.length === 0) {
    console.log(`No transport packages installed (searched ${packages.searched.join(", ")})`);
  }

  const running: { source: string; runtime: HostedRuntime }[] = [];
  for (const pkg of packages.loaded) {
    try {
      running.push({ source: pkg.transport.descriptor.id, runtime: await hostTransport(pkg, input) });
    } catch (err) {
      console.error(
        `Transport ${pkg.transport.descriptor.id} (${pkg.name}@${pkg.version}) could not start: ` +
          describeError(err),
      );
    }
  }

  return {
    sources: running.map((entry) => entry.source),
    async close() {
      for (const entry of running) {
        await entry.runtime.close().catch((err) => {
          console.error(`Transport ${entry.source} did not stop cleanly:`, describeError(err));
        });
      }
    },
  };
}

/** Run one loaded package: everything a transport service was, in this process. */
async function hostTransport(
  pkg: LoadedTransportPackage,
  input: { redisUrl: string },
): Promise<HostedRuntime> {
  const transport = pkg.transport as TransportPackage<unknown>;
  const { descriptor } = transport;
  const source = descriptor.id;
  const errorText = (err: unknown): string => transport.adapter.errorText?.(err) ?? describeError(err);

  const updates = openUpdatePublisher(input.redisUrl);
  // One trace client for everything this transport records; the delivery
  // and every hosted tool share it.
  const traces = hostedTraceClient(source);
  const core = inProcessCoreApi(descriptor);
  const manager = new ConnectionManager<unknown>({
    descriptor,
    adapter: transport.adapter,
    normalize: transport.normalize,
    addressing: transport.addressing,
    updates,
    core,
  });

  const send: SendContext = {
    descriptor,
    publisher: updates,
    running: () => manager.running(),
    connectionFor: (assistantId) => manager.connectionFor(assistantId),
  };

  /**
   * Whether a chat is direct, for the consumers that only have a ref. Asked
   * of whichever connection runs; with none running the answer is `false`,
   * which is the safe way to be wrong — it keeps two people's direct chats in
   * separate dedupe streams rather than merging them into a shared one.
   */
  const isDirect = async (chatId: string): Promise<boolean> => {
    try {
      return await manager.connectionFor(null).isDirectChat(chatId);
    } catch {
      return false;
    }
  };

  const runtime: TransportRuntime = {
    descriptor,
    core,
    updates,
    send,
    traces,
    statuses: () => manager.statuses(),
    connectionFor: (assistantId) => manager.connectionFor(assistantId),
  };

  // The transport's own MCP server — the delivery tools plus whatever the
  // package registers — joined to a client over the in-process pair, the
  // way the core's own tools are. The managed tool connection calls it.
  const server = new McpServer({ name: `${source}-transport`, version: "1.0.0" });
  registerDeliveryTools(server, {
    descriptor,
    send,
    errorText,
    traces,
    texts: transport.tools ?? { platform: descriptor.name },
  });
  transport.tools?.register?.(server, runtime);
  const [serverSide, clientSide] = InProcessTransport.createLinkedPair();
  const client = new Client({ name: "assistants-swarm-hub-host", version: "1.0.0" });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const tools: HostedTransportTools = {
    async listTools() {
      const { tools: listed } = await client.listTools();
      return listed.map((tool) => {
        const entry = tool as McpListedTool;
        return {
          name: entry.name,
          description: entry.description ?? "",
          inputSchema: entry.inputSchema ?? { type: "object", properties: {} },
        };
      });
    },
    async callTool(name, args, meta) {
      const result = await client.callTool({
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      });
      return toToolCallResult(result);
    },
  };

  const delivery = startDelivery({ descriptor, send, traces, isDirect });

  let closed = false;
  /**
   * Every desired-state application, serialized: the initial one from the
   * registration and each reconcile a change asks for, in order — a burst of
   * changes collapses into reconciles that each see the freshest state, and
   * none overlaps the start.
   */
  let applying: Promise<void> = Promise.resolve();
  const serialized = (work: () => Promise<void>): Promise<void> => {
    const next = applying.then(work);
    applying = next.catch(() => undefined);
    return next;
  };
  const reconcile = (reason: string): void => {
    void serialized(async () => {
      if (closed) return;
      try {
        await manager.applyDesiredState(await core.desiredState());
        console.log(`${source}: desired state reconciled (${reason})`);
      } catch (err) {
        console.error(`${source}: desired-state reconcile failed (${reason}):`, errorText(err));
      }
    });
  };

  // Reachable from the first moment: a turn that starts before the
  // connections are up fails its send audibly rather than finding no port,
  // and a change made while they come up is reconciled right after.
  registerHostedTransport({
    descriptor,
    outbound: hostedOutboundPort({ send, errorText }),
    menus: hostedMenus({ send, errorText }),
    statuses: () => manager.statuses(),
    tools,
    turns: delivery,
    reconcile,
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    unregisterHostedTransport(source);
    delivery.close();
    await manager.close().catch(() => undefined);
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await updates.close().catch(() => undefined);
  };

  try {
    await serialized(async () => {
      const desired = await registerHostedTransportRow(descriptor);
      console.log(
        `Transport ${source} (${pkg.name}@${pkg.version}) registered — ` +
          `${desired.connections.length} connection(s) desired` +
          (desired.transport.enabled ? "" : " (transport disabled)"),
      );
      for (const status of await manager.applyDesiredState(desired)) {
        console.log(
          `connection ${status.connectionId} (assistant ${status.assistantId}): ${status.state}` +
            (status.username ? ` as ${status.username}` : "") +
            (status.error ? ` — ${status.error}` : ""),
        );
      }
      if (manager.statuses().length === 0) {
        console.log(`No enabled ${descriptor.name} connections — idle until one is added.`);
      }
    });
  } catch (err) {
    await close();
    throw err;
  }

  return { close };
}
