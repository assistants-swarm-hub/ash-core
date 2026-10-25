import "server-only";

import {
  createSourceTraceRecorder,
  type SourceId,
  type SourceTraceClient,
} from "@assistants-swarm-hub/contracts";

import { ingestSourceTrace } from "@/server/trace/ingest";

/**
 * A hosted transport's trace client: the contract's recorder (a whole trace
 * buffered locally, handed over once on settle — the shape every source-side
 * trace has), settled straight into the core's trace store through the same
 * ingest a `trace.recorded` bus event goes through. Same trace, same store,
 * same Debug rendering; the Redis hop is gone because the recorder and the
 * store share a process now.
 *
 * Noise rule carried over: plain chatter that only got mirrored leaves
 * nothing behind. Callers achieve that by simply not settling the recorder
 * for boring outcomes — an unsettled recorder never records.
 */
export function hostedTraceClient(source: SourceId): SourceTraceClient {
  return createSourceTraceRecorder({
    source,
    publish: async (event) => {
      ingestSourceTrace(event.trace);
    },
  });
}
