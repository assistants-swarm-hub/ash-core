import "server-only";

import type { SourceId } from "@assistants-swarm-hub/contracts";

import { hostedTransport } from "@/server/transports/hosted";

import type { CollectTransport } from "./collect-flows";

/**
 * The menu operations of the owning transport — how the core-owned feedback
 * flow posts, edits and removes its option menus in the platform chat. Which
 * transport answers is resolved from the source id, as every other transport
 * call is: the web chat has none (no reactions there), and a source this
 * core does not host has none either, so the flows degrade audibly.
 */
export function collectTransport(source: SourceId): CollectTransport | null {
  if (source === "chat") return null;
  return hostedTransport(source)?.menus ?? null;
}
