import "server-only";

import { transportLoadFailures } from "./hosted";
import { listConnectionViews, listTransports, type TransportConnectionView } from "./service";

/**
 * The dashboard's bot status over the transport registry: every registered
 * transport's connection roster (rows in the core store, live connection
 * state from the host), every package the host could not load, and the
 * one-card summary the shell and the Overview render. Nothing here knows
 * which platforms are installed — the roster is whatever loaded, and
 * whatever did not.
 */

/** Dashboard-facing bot status — the v1 `BotStatus` shape, kept. */
export interface BotStatus {
  state: "stopped" | "running" | "error";
  username: string | null;
  /** ISO time the current run started, or null when not running. */
  since: string | null;
  /** Last error message when `state` is `error`, else null. */
  error: string | null;
}

/**
 * One registered transport with its connections, as the Overview lists them
 * — or one installed package the host refused, named by its package name,
 * with the reason and nothing else.
 */
export interface TransportRoster {
  id: string;
  /** The name the transport announced, or the package name of a refused one. */
  name: string;
  /** Why this core refused the package, or null when it loaded. */
  refusedReason: string | null;
  connections: TransportConnectionView[];
  /** Why the connection listing failed, or null (the transport's rows are then empty). */
  error: string | null;
}

/**
 * Every registered transport's roster, in registration order, then every
 * package the host could not load, in the order it found them.
 */
export async function listTransportRosters(): Promise<TransportRoster[]> {
  const rows = await listTransports();
  const registered = await Promise.all(
    rows.map(async (row): Promise<TransportRoster> => {
      const base = { id: row.id, name: row.name, refusedReason: null };
      try {
        return { ...base, connections: await listConnectionViews(row.id), error: null };
      } catch (err) {
        return {
          ...base,
          connections: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const refused = transportLoadFailures().map(
    (failure): TransportRoster => ({
      id: failure.name,
      name: failure.name,
      refusedReason: failure.error,
      connections: [],
      error: null,
    }),
  );
  return [...registered, ...refused];
}

/** How a connection is named in an error: its bot's handle, else its transport and masked config. */
function connectionLabel(roster: TransportRoster, connection: TransportConnectionView): string {
  if (connection.status?.username) return `@${connection.status.username}`;
  const preview = Object.entries(connection.configPreview)
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
  return preview ? `${roster.name} ${preview}` : roster.name;
}

/**
 * Summarize every transport's connections into the shell's one Bot status
 * card. Errors win — a refused package, a transport whose listing failed,
 * a connection in error, or an enabled connection with no tracked state (its
 * package is not loaded) — then running, then stopped;
 * `configured` is simply "at least one connection exists".
 */
export function summarizeTransports(rosters: readonly TransportRoster[]): {
  status: BotStatus;
  configured: boolean;
} {
  const connections = rosters.flatMap((roster) => roster.connections);
  const configured = connections.length > 0;
  const error = (message: string, username: string | null = null) => ({
    status: { state: "error" as const, username, since: null, error: message },
    configured,
  });

  const refused = rosters.find((roster) => roster.refusedReason);
  if (refused) return error(refused.refusedReason!);
  const unlisted = rosters.find((roster) => roster.error);
  if (unlisted) return error(`${unlisted.name}: ${unlisted.error}`);

  for (const roster of rosters) {
    const failed = roster.connections.find(
      (c) => c.status?.state === "error" || (c.enabled && !c.status),
    );
    if (!failed) continue;
    const message =
      failed.status?.error ??
      `connection is enabled but nothing is tracked — is the ${roster.name} package installed and loaded?`;
    const label = connectionLabel(roster, failed);
    return error(
      connections.length > 1 ? `${label}: ${message}` : message,
      failed.status?.username ?? null,
    );
  }

  const running = connections.filter((c) => c.status?.state === "running");
  if (running.length > 0) {
    return {
      status: {
        state: "running",
        username: running.length === 1 ? (running[0].status?.username ?? null) : null,
        since: running.length === 1 ? (running[0].status?.since ?? null) : null,
        error: null,
      },
      configured: true,
    };
  }
  return {
    status: { state: "stopped", username: null, since: null, error: null },
    configured,
  };
}

/** The dashboard's bot status + whether any connection exists. */
export async function getTransportsStatus(): Promise<{
  status: BotStatus;
  configured: boolean;
}> {
  try {
    return summarizeTransports(await listTransportRosters());
  } catch (err) {
    return {
      status: {
        state: "error",
        username: null,
        since: null,
        error: `transport status unavailable: ${err instanceof Error ? err.message : String(err)}`,
      },
      configured: false,
    };
  }
}
