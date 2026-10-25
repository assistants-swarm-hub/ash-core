import type { SourceId } from "@assistants-swarm-hub/contracts";

import { registerTransport } from "@/server/transports/service";
import type { StoreDb } from "@/server/store/db";

/**
 * Register a transport in a test store, the way the host does for a package
 * it loaded at boot. Every read that walks the registered roster — the content plane,
 * the directory, the media sources — sees nothing until one exists, so an
 * integration suite that seeds `source_*` rows under a source id registers
 * that id first.
 */
export async function registerTestTransport(
  db: StoreDb,
  id: SourceId = "acme",
  name = "Acme Chat",
): Promise<void> {
  await registerTransport(
    {
      id,
      name,
      connectionConfigSchema: [],
      transportConfigSchema: [],
    },
    db,
  );
}
