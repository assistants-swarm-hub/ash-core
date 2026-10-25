import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import {
  type SourceId,
  type TransportConfigChangedEvent,
  type TransportDesiredState,
  type TransportRegistration,
} from "@assistants-swarm-hub/contracts";

import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishBusEvent } from "@/server/bus/publisher";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import { silencedAssistantIds } from "@/server/ownership";
import { hostedTransport } from "@/server/transports/hosted";

import {
  assistantTransports,
  transports,
  type AssistantTransportRow,
  type TransportRow,
} from "../../store/schema";

/**
 * Transport registrations and per-assistant connections: the host registers
 * every transport package it loads at boot — its id, name and config schemas,
 * from the package's descriptor — and the opaque config blobs the row and
 * its connections carry (an owner identity, say; bot tokens) are the
 * transport's to interpret, never the core's. Desired-state changes are
 * announced to the host (a direct reconcile for a hosted transport, the
 * `transport.config.changed` bus event for one run elsewhere); the host
 * refetches and reconciles. A row outlives its package: a transport that was
 * installed once stays listed, with no connections tracked, until its
 * package is back.
 */

const FEATURE = FEATURES["tool-connections"];

/** Registration: upsert the package's identity, keep the admin's decisions. */
export async function registerTransport(
  request: TransportRegistration,
  db: StoreDb = getStoreDb(),
): Promise<TransportDesiredState> {
  await db
    .insert(transports)
    .values({
      id: request.id,
      name: request.name,
      connectionConfigSchema: request.connectionConfigSchema,
      transportConfigSchema: request.transportConfigSchema,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: transports.id,
      // The identity follows the code; `enabled` and `config` are the
      // admin's and survive every re-registration.
      set: {
        name: request.name,
        connectionConfigSchema: request.connectionConfigSchema,
        transportConfigSchema: request.transportConfigSchema,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });
  publishEvent("status");
  return desiredTransportState(request.id, db);
}

/** The desired state one transport reconciles from. */
export async function desiredTransportState(
  id: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<TransportDesiredState> {
  const row = await getTransport(id, db);
  if (!row) throw ApiError.notFound(`transport "${id}" is not registered`);
  const connections = await db
    .select()
    .from(assistantTransports)
    .where(eq(assistantTransports.transport, id))
    .orderBy(asc(assistantTransports.createdAt));
  // Offboarding (Phase 9): a deactivated account's assistants run nothing.
  // Computed, not stored, so reactivation restores the exact prior state.
  const silenced = await silencedAssistantIds(db);
  return {
    transport: { enabled: row.enabled, config: row.config },
    connections: connections.map((connection) => ({
      id: connection.id,
      assistantId: connection.assistantId,
      config: connection.config,
      // A disabled transport runs nothing, whatever its connections say.
      enabled: row.enabled && connection.enabled && !silenced.has(connection.assistantId),
    })),
  };
}

export async function getTransport(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow | null> {
  const rows = await db.select().from(transports).where(eq(transports.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Every registered transport, oldest first (the dashboard's roster). */
export async function listTransports(db: StoreDb = getStoreDb()): Promise<TransportRow[]> {
  return db.select().from(transports).orderBy(asc(transports.registeredAt));
}

/**
 * Whether events tagged with this source may be ingested. Every runtime
 * lookup over "the sources" (managed tool connections, the directory roster,
 * the media fan-out, this check) reads the registration table — a source id
 * is whatever registered, never a compiled-in list.
 */
export async function isRegisteredTransport(
  source: string,
  db: StoreDb = getStoreDb(),
): Promise<boolean> {
  return (await getTransport(source, db)) !== null;
}

/**
 * Announce a desired-state change; the transport refetches and reconciles.
 * A hosted transport is told directly (`hosted.reconcile`, serialized by
 * the host); one this process does not host hears it on the bus.
 */
export async function announceTransportChange(transport: SourceId): Promise<void> {
  const hosted = hostedTransport(transport);
  if (hosted) {
    hosted.reconcile("transport.config.changed");
    publishEvent("status");
    return;
  }
  const event: TransportConfigChangedEvent = {
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: `transport:${transport}`,
    type: "transport.config.changed",
    transport,
  };
  const published = await publishBusEvent(event).catch(() => false);
  if (!published) {
    console.error(
      `transport.config.changed for '${transport}' was NOT published (bus unconfigured?) — ` +
        "the transport will not pick the change up until restart",
    );
  }
  publishEvent("status");
}

/**
 * Merge a transport-side config writeback (a transport persisting a resolved
 * owner id) into the transport-level blob. Shallow merge — the transport
 * owns the keys.
 */
export async function mergeTransportConfig(
  id: SourceId,
  patch: Record<string, unknown>,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow> {
  const row = await getTransport(id, db);
  if (!row) throw ApiError.notFound(`transport "${id}" is not registered`);
  const updated = await db
    .update(transports)
    .set({ config: { ...row.config, ...patch }, updatedAt: new Date() })
    .where(eq(transports.id, id))
    .returning();
  publishEvent("status");
  return updated[0];
}

/** The operator's transport-level settings write (traced; announces). */
export async function putTransportConfig(
  id: SourceId,
  config: Record<string, unknown>,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "transport-config",
      trigger,
      inputSummary: `${id} settings`,
    },
    async (trace) => {
      const row = await getTransport(id, db);
      if (!row) throw ApiError.notFound(`transport "${id}" is not registered`);
      const updated = await db
        .update(transports)
        .set({ config, updatedAt: new Date() })
        .where(eq(transports.id, id))
        .returning();
      await trace.event({ type: "db", message: `${id} transport config replaced` });
      await announceTransportChange(id);
      await trace.succeed({ outputSummary: `${id} config saved` });
      return updated[0];
    },
  );
}

/** Toggle a transport (a disabled one gets no state and its events are stale). */
export async function setTransportEnabled(
  id: SourceId,
  enabled: boolean,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<TransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "transport-toggle",
      trigger,
      inputSummary: `${id} → ${enabled ? "enabled" : "disabled"}`,
    },
    async (trace) => {
      const rows = await db
        .update(transports)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(transports.id, id))
        .returning();
      if (!rows[0]) throw ApiError.notFound(`transport "${id}" is not registered`);
      await announceTransportChange(id);
      await trace.succeed();
      return rows[0];
    },
  );
}

// ---- Per-assistant connections ---------------------------------------------

/** One assistant's connection on one transport, or null. */
/** One connection row by its id, or null — the ownership gates read this. */
export async function getAssistantTransportById(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow | null> {
  const rows = await db
    .select()
    .from(assistantTransports)
    .where(eq(assistantTransports.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAssistantTransport(
  transport: SourceId,
  assistantId: string,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow | null> {
  const rows = await db
    .select()
    .from(assistantTransports)
    .where(
      and(
        eq(assistantTransports.transport, transport),
        eq(assistantTransports.assistantId, assistantId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Every connection on one transport, oldest first. */
export async function listAssistantTransports(
  transport: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow[]> {
  return db
    .select()
    .from(assistantTransports)
    .where(eq(assistantTransports.transport, transport))
    .orderBy(asc(assistantTransports.createdAt));
}

/**
 * Connect an assistant to a transport. Enabled on creation: a saved config
 * means "run this" (v1 autostart semantics); Stop is the explicit way to
 * keep it parked. One connection per assistant per transport.
 */
export async function createAssistantTransport(
  input: { transport: SourceId; assistantId: string; config: Record<string, unknown> },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "connection-create",
      assistantId: input.assistantId,
      trigger,
      inputSummary: `${input.transport} connection`,
    },
    async (trace) => {
      const existing = await getAssistantTransport(input.transport, input.assistantId, db);
      if (existing) {
        throw ApiError.conflict("this assistant already has a connection on this transport");
      }
      const rows = await db
        .insert(assistantTransports)
        .values({
          id: randomUUID(),
          transport: input.transport,
          assistantId: input.assistantId,
          config: input.config,
          enabled: true,
        })
        .returning();
      await trace.event({ type: "db", message: "connection stored (config is the transport's)" });
      await announceTransportChange(input.transport);
      await trace.succeed({ outputSummary: "connection created" });
      return rows[0];
    },
  );
}

/** Desired-state change (re-config, start/stop); the transport reconciles. */
export async function updateAssistantTransport(
  id: string,
  patch: { config?: Record<string, unknown>; enabled?: boolean },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<AssistantTransportRow> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "connection-update",
      trigger,
      inputSummary: Object.keys(patch).join(", "),
    },
    async (trace) => {
      const current = await db
        .select()
        .from(assistantTransports)
        .where(eq(assistantTransports.id, id))
        .limit(1);
      if (!current[0]) throw ApiError.notFound("connection not found");
      const rows = await db
        .update(assistantTransports)
        .set({
          ...(patch.config ? { config: { ...current[0].config, ...patch.config } } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(eq(assistantTransports.id, id))
        .returning();
      await announceTransportChange(rows[0].transport as SourceId);
      await trace.succeed();
      return rows[0];
    },
  );
}

/** Remove a connection: the row, its stored config, and (via the announce) its runtime. */
export async function deleteAssistantTransport(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "connection-delete", trigger, inputSummary: id },
    async (trace) => {
      const rows = await db
        .delete(assistantTransports)
        .where(eq(assistantTransports.id, id))
        .returning();
      if (!rows[0]) throw ApiError.notFound("connection not found");
      await announceTransportChange(rows[0].transport as SourceId);
      await trace.succeed({ outputSummary: "connection removed" });
    },
  );
}

// ---- Operator views --------------------------------------------------------

/**
 * Live connection state one transport reports for one connection.
 * `starting` is a connection the platform is still handshaking — it has no
 * identity to send as yet, and the dashboard says so rather than "stopped".
 */
export interface TransportConnectionStatus {
  state: "starting" | "running" | "error" | "stopped";
  username: string | null;
  since: string | null;
  error: string | null;
}

/** One connection as the dashboard renders it (config as masked preview). */
export interface TransportConnectionView {
  id: string;
  assistantId: string;
  enabled: boolean;
  /** Per schema field: the stored value, secrets reduced to a hint. */
  configPreview: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  status: TransportConnectionStatus | null;
}

/**
 * The live statuses of a transport's connections, keyed by connection id,
 * from the host. A transport this process does not run — its package is
 * gone, or failed to load — has none: an enabled connection with no status
 * is what the dashboard flags as not tracked.
 */
export function fetchTransportStatuses(
  row: Pick<TransportRow, "id">,
): Map<string, TransportConnectionStatus> {
  const hosted = hostedTransport(row.id);
  if (!hosted) return new Map();
  return new Map(
    hosted.statuses().map((status) => [
      status.connectionId,
      {
        state: status.state,
        username: status.username,
        since: status.since,
        error: status.error,
      },
    ]),
  );
}

/** Mask one config blob against the transport's field schema. */
export function previewConfig(
  config: Record<string, unknown>,
  fields: TransportRow["connectionConfigSchema"],
): Record<string, string> {
  const preview: Record<string, string> = {};
  for (const field of fields) {
    const value = config[field.key];
    if (value == null || value === "") continue;
    preview[field.key] =
      field.kind === "secret" ? `…${String(value).slice(-4)}` : String(value);
  }
  return preview;
}

/** One transport's connections joined with its live poller state. */
export async function listConnectionViews(
  transport: SourceId,
  assistantId?: string,
  db: StoreDb = getStoreDb(),
): Promise<TransportConnectionView[]> {
  const row = await getTransport(transport, db);
  if (!row) return [];
  const connections = await listAssistantTransports(transport, db);
  const statuses = fetchTransportStatuses(row);
  return connections
    .filter((connection) => !assistantId || connection.assistantId === assistantId)
    .map((connection) => ({
      id: connection.id,
      assistantId: connection.assistantId,
      enabled: connection.enabled,
      configPreview: previewConfig(connection.config, row.connectionConfigSchema),
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
      status: statuses.get(connection.id) ?? null,
    }));
}
