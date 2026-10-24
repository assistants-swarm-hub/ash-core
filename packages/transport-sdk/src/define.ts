import type { TransportPackage } from "@assistants-swarm-hub/contracts";

/**
 * Declare a transport package. The default export of your package is what
 * the core loads — a descriptor, a platform adapter, a normalizer, an
 * addressing rule, and the words and tools of your own — and this is how
 * you say so with the types attached:
 *
 * ```ts
 * export default defineTransport({ descriptor, adapter, normalize, addressing, tools });
 * ```
 *
 * It does nothing at runtime: it exists so the editor checks the four pieces
 * against the interface and ties their raw-update type together, and so the
 * package reads as what it is.
 */
export function defineTransport<TRaw>(transport: TransportPackage<TRaw>): TransportPackage<TRaw> {
  return transport;
}
