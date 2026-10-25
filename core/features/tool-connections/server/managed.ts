import "server-only";

import { randomUUID } from "node:crypto";

import type { SourceId } from "@assistants-swarm-hub/contracts";

import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { listTransports } from "@/server/transports/service";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";
import type { TraceRecorder } from "@/server/trace/recorder";
import { hostedTransport } from "@/server/transports/hosted";
import { toolConnectionClient } from "./client";
import { describeDiff, diffToolsets } from "./diff";
import {
  getToolConnectionBySlug,
  insertToolConnection,
  recordDiscovery,
  replaceSnapshot,
  updateToolConnection,
  type ToolConnectionRecord,
} from "./repository";
import type { ToolTransport } from "./schema";
import { appliedTools } from "./service";

/**
 * The transports' own MCP servers, as tool connections: the host builds one
 * per transport (the delivery tools plus the platform's own actions), and
 * the core registers it as a managed connection reached in-process.
 *
 * The web chat is not among them: its delivery tools are in-process registry
 * tools since the dissolve (Phase 6), and its old managed row is deleted by
 * store migration 0006.
 *
 * They are reconciled from what is hosted rather than typed in by an
 * operator: their endpoint is a marker for the host's server, their scope is
 * the transport itself, and **their snapshot follows the code**. That is the one place the
 * discover-then-apply rule does not apply, and deliberately so: the rule
 * exists to keep a third party from changing what the model is offered
 * mid-conversation, while these tools ship with the release and change when it
 * is deployed. Asking an operator to press Apply after every upgrade would
 * mean an assistant that silently lost the ability to react.
 *
 * The operator still owns the parts that are judgment: enabling, and which
 * assistants may call them. Identity and endpoint are refused as edits.
 */

const FEATURE = FEATURES["tool-connections"];

/** What a source app's connection looks like when configuration is complete. */
interface ManagedDesired {
  source: SourceId;
  slug: string;
  name: string;
  transport: ToolTransport;
  endpointUrl: string;
  authHeaders: Record<string, string>;
}

/**
 * The desired connection for one source, or null when this core does not
 * host it (or it hosts no tools). The endpoint is a marker, not an address:
 * the connection is reached through the host's in-process server.
 */
export function desiredManagedConnection(source: SourceId): ManagedDesired | null {
  const hosted = hostedTransport(source);
  if (!hosted?.tools) return null;
  return {
    source,
    slug: source,
    name: `${hosted.descriptor.name} tools`,
    transport: "in-process",
    endpointUrl: `in-process://${source}`,
    authHeaders: {},
  };
}

/** One source's row brought in line with configuration; null if not deployed. */
async function reconcileOne(
  db: StoreDb,
  source: SourceId,
  trace: Pick<TraceRecorder, "event">,
): Promise<ToolConnectionRecord | null> {
  const desired = desiredManagedConnection(source);
  const existing = await getToolConnectionBySlug(db, source);

  if (!desired) {
    // The transport is not hosted here. The row stays (its scope and
    // assistant selection are the operator's), but nothing may be offered
    // from a server that does not exist.
    if (existing?.enabled) {
      await updateToolConnection(db, existing.id, { enabled: false });
      await trace.event({
        type: "step",
        level: "warn",
        message: `${source} is not hosted by this core — its tools are disabled`,
      });
    }
    return null;
  }

  if (!existing) {
    const created = await insertToolConnection(db, randomUUID(), {
      slug: desired.slug,
      name: desired.name,
      transport: desired.transport,
      endpointUrl: desired.endpointUrl,
      authHeaders: desired.authHeaders,
      enabled: true,
      // Hub-provisioned: nobody's, unrestricted (Phase 9 ownership).
      ownerAccountId: null,
      appScope: desired.source,
      allAssistants: true,
      managed: true,
    });
    await trace.event({ type: "db", message: `registered ${source}'s own MCP server` });
    return created;
  }

  const changed =
    existing.transport !== desired.transport ||
    existing.endpointUrl !== desired.endpointUrl ||
    existing.name !== desired.name ||
    existing.appScope !== desired.source ||
    !existing.managed ||
    JSON.stringify(existing.authHeaders) !== JSON.stringify(desired.authHeaders);
  if (!changed) return existing;

  const updated = await updateToolConnection(db, existing.id, {
    name: desired.name,
    transport: desired.transport,
    endpointUrl: desired.endpointUrl,
    authHeaders: desired.authHeaders,
    appScope: desired.source,
    managed: true,
  });
  await trace.event({ type: "db", message: `${source}'s connection re-pointed to configuration` });
  return updated;
}

/**
 * Bring every transport's connection in line with what is hosted and take
 * its current toolset — one trace for the whole pass, so a boot that could
 * not list a server says which one and why instead of failing silently.
 *
 * A server that does not answer keeps its last snapshot: the tools it
 * offered a minute ago are the ones this release ships, and dropping them
 * over a hiccup would make the first turns after a restart quietly less
 * capable.
 */
export async function reconcileManagedConnections(
  trigger: TraceTrigger = { kind: "system" },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "reconcile-managed", trigger, inputSummary: "source apps" },
    async (trace) => {
      const summary: string[] = [];
      // Whatever registered — no compiled-in list.
      for (const { id: source } of await listTransports(db)) {
        const record = await reconcileOne(db, source, trace);
        if (!record) {
          summary.push(`${source}: not hosted`);
          continue;
        }
        try {
          const discovered = await toolConnectionClient(record).listTools();
          const diff = diffToolsets(appliedTools(record), discovered);
          await recordDiscovery(db, record.id, {
            at: new Date(),
            error: null,
            tools: discovered,
          });
          await replaceSnapshot(db, record.id, discovered);
          await trace.event({
            type: "external_call",
            message: `${source} offers ${discovered.length} tools — ${describeDiff(diff)}`,
            data: { tools: discovered.map((tool) => tool.name) },
          });
          summary.push(`${source}: ${discovered.length} tools`);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await recordDiscovery(db, record.id, {
            at: record.lastDiscoveredAt ? new Date(record.lastDiscoveredAt) : null,
            error,
          });
          await trace.event({
            type: "external_call",
            level: "warn",
            message: `${source}'s server did not answer — keeping the ${record.tools.length} tools it last offered`,
            data: { error },
          });
          summary.push(`${source}: unreachable`);
        }
      }
      await trace.succeed({ outputSummary: summary.join("; ") });
      publishEvent(FEATURE.realtimeTopic!);
    },
  );
}
