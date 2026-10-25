import { defineRoute, ok } from "@/server/http";
import { hostedTransport } from "@/server/transports/hosted";
import { listTransports, previewConfig } from "@/server/transports/service";

/**
 * The registered transports, for the dashboard's schema-driven sections:
 * each row carries the config field schemas the forms render from. Secret
 * config values are reduced to hints.
 */
// Account level (Phase 9): the assistant editor renders these sections for
// every owner; secrets are already reduced to hints.
export const GET = defineRoute(async () => {
  const rows = await listTransports();
  return ok({
    transports: rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      /** Whether this core runs the transport now (its package loaded at boot). */
      hosted: hostedTransport(row.id) !== null,
      lastSeenAt: row.lastSeenAt.toISOString(),
      connectionConfigSchema: row.connectionConfigSchema,
      transportConfigSchema: row.transportConfigSchema,
      configPreview: previewConfig(row.config, row.transportConfigSchema),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}, { access: "account" });
