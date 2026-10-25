import "server-only";

import {
  BUS_EVENTS_CHANNEL,
  parseScopedRef,
  type ReplyDeliveryEvent,
  type TurnLifecycleEvent,
} from "@assistants-swarm-hub/contracts";

import { releaseHold } from "@/server/ingest/consumer";
import { hostedTransport } from "@/server/transports/hosted";

/**
 * Where a turn's outbound events go: the finished reply to deliver and the
 * lifecycle to render as typing / thread progress, for whichever source owns
 * the turn.
 *
 * A source this process hosts gets them as direct calls into its host — the
 * send is performed right here, no Redis in between — and a settled turn
 * releases its mirror row's live-processing hold in the same breath (the
 * hold is the ingest's, not the transport's). Any other source gets the very
 * same events on the bus, where it consumes its own: the web chat through
 * `server/source/events-consumer.ts`, a transport run as its own service
 * through its delivery consumer. One router, so the pipeline never asks
 * which kind of source it is talking to.
 */

export interface TurnEventBus {
  publish(channel: string, payload: unknown): Promise<void>;
}

export async function publishTurnEvent(
  event: ReplyDeliveryEvent | TurnLifecycleEvent,
  bus: TurnEventBus,
): Promise<void> {
  const hosted = hostedTransport(event.source);
  if (!hosted) {
    await bus.publish(BUS_EVENTS_CHANNEL, event);
    return;
  }
  if (event.type === "reply.delivery") {
    // Detached, as the bus consumer was: the pipeline's job ends when the
    // reply is handed over, and the send's outcome lands in its own deliver
    // trace on the turn's correlation.
    void hosted.turns.deliver(event).catch((err) => {
      console.error(
        `[${event.source} delivery] reply ${event.correlationId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return;
  }
  hosted.turns.lifecycle(event);
  if (event.phase === "settled") {
    await releaseHold(
      event.source,
      parseScopedRef(event.chatRef).id,
      event.sourceMessageId,
      event.assistantId ?? null,
    );
  }
}
