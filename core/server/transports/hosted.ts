import "server-only";

import type {
  ConnectionStatus,
  ReplyDeliveryEvent,
  TransportDescriptor,
  TurnLifecycleEvent,
} from "@assistants-swarm-hub/contracts";

import type { CollectTransport } from "@/features/self-improvement/server/collect-flows";
import type { DiscoveredTool } from "@/server/mcp/http-client";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import type { SourceOutboundPort } from "@/server/turn/source-outbound";

/**
 * The transports this process hosts, by source id (`docs/TODO.md`,
 * "Transports as packages the core hosts in-process").
 *
 * Every place the core used to reach a transport over its internal HTTP
 * API or the bus — the outbound port, the feedback menus, the live
 * connection statuses, the transport's own MCP tools, the turn's deliveries
 * and lifecycle, a desired-state change — asks here first. A source that is
 * hosted answers in-process; one that is not falls through to whatever the
 * registration row says and to the bus, which keeps a transport still run
 * as its own service working until that form is retired.
 *
 * Process-global like every boot-bound singleton here: Next.js evaluates
 * several bundles per process, and the host registers once.
 */

/**
 * Where a turn's outbound events go for one source: the finished reply to
 * perform and the lifecycle to render (typing). The pipeline calls this
 * in-process for a hosted source and publishes the very same events on the
 * bus for one it does not host (`server/turn/turn-events.ts`).
 */
export interface TurnEventSink {
  deliver(event: ReplyDeliveryEvent): Promise<void>;
  lifecycle(event: TurnLifecycleEvent): void;
}

/** A hosted transport's own MCP server, reached without a socket. */
export interface HostedTransportTools {
  listTools(): Promise<DiscoveredTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolCallResult>;
}

export interface HostedTransport {
  descriptor: TransportDescriptor;
  /** The sends the core drives: text, voice, photos, files, deletes, titles. */
  outbound: SourceOutboundPort;
  /** The feedback-menu operations the collection flow calls. */
  menus: CollectTransport;
  /** What each connection is doing right now. */
  statuses(): ConnectionStatus[];
  /** The transport's tools, or null when it hosts none. */
  tools: HostedTransportTools | null;
  /** The turn's deliveries and lifecycle, performed by the host. */
  turns: TurnEventSink;
  /**
   * The desired state changed (a connection edited, an assistant deleted):
   * refetch and reconcile. Serialized by the host, so a burst collapses.
   */
  reconcile(reason: string): void;
}

const KEY = Symbol.for("assistants-swarm-hub.core.transports.hosted");

function registry(): Map<string, HostedTransport> {
  const g = globalThis as typeof globalThis & { [KEY]?: Map<string, HostedTransport> };
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY];
}

/** The hosted transport behind a source id, or null when this process does not host it. */
export function hostedTransport(source: string): HostedTransport | null {
  return registry().get(source) ?? null;
}

/** Every transport this process hosts, in registration order. */
export function listHostedTransports(): HostedTransport[] {
  return [...registry().values()];
}

export function registerHostedTransport(transport: HostedTransport): void {
  registry().set(transport.descriptor.id, transport);
}

export function unregisterHostedTransport(source: string): void {
  registry().delete(source);
}

/** A package the host found but could not run, as the roster reports it. */
export interface TransportLoadFailure {
  /** The npm package name. */
  name: string;
  error: string;
}

const FAILURES_KEY = Symbol.for("assistants-swarm-hub.core.transports.load-failures");

/** What the host could not load at its last start; the roster shows each by name. */
export function transportLoadFailures(): TransportLoadFailure[] {
  const g = globalThis as typeof globalThis & { [FAILURES_KEY]?: TransportLoadFailure[] };
  return g[FAILURES_KEY] ?? [];
}

export function recordTransportLoadFailures(failures: TransportLoadFailure[]): void {
  const g = globalThis as typeof globalThis & { [FAILURES_KEY]?: TransportLoadFailure[] };
  g[FAILURES_KEY] = failures;
}
