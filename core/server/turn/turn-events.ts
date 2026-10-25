import "server-only";

import {
  BUS_EVENTS_CHANNEL,
  WEB_CHAT_SOURCE,
  parseScopedRef,
  type ReplyDeliveryEvent,
  type TurnLifecycleEvent,
} from "@assistants-swarm-hub/contracts";

import { webChatTurnSink } from "@/features/web-chat/server/delivery";
import { releaseHold } from "@/server/ingest/consumer";
import { hostedTransport, type TurnEventSink } from "@/server/transports/hosted";

/**
 * Where a turn's outbound events go: the finished reply to deliver and the
 * lifecycle to render as typing / thread progress, for whichever source owns
 * the turn.
 *
 * A source this process runs gets them as direct calls — a hosted transport
 * through its host (the send is performed right here, no Redis in between,
 * and a settled turn releases its mirror row's live-processing hold in the
 * same breath: the hold is the ingest's, not the transport's), the web chat
 * through its own sink (the reply stored in the thread, the lifecycle
 * rendered as progress). Any other source gets the very same events on the
 * bus, where a transport run as its own service consumes them. One router,
 * so the pipeline never asks which kind of source it is talking to.
 */

export interface TurnEventBus {
  publish(channel: string, payload: unknown): Promise<void>;
}

/** The in-process owner of a source's turns, or null when it runs elsewhere. */
function sinkFor(source: string): { sink: TurnEventSink; holdsMirror: boolean } | null {
  if (source === WEB_CHAT_SOURCE) return { sink: webChatTurnSink(), holdsMirror: false };
  const hosted = hostedTransport(source);
  return hosted ? { sink: hosted.turns, holdsMirror: true } : null;
}

export async function publishTurnEvent(
  event: ReplyDeliveryEvent | TurnLifecycleEvent,
  bus: TurnEventBus,
): Promise<void> {
  const owner = sinkFor(event.source);
  if (!owner) {
    await bus.publish(BUS_EVENTS_CHANNEL, event);
    return;
  }
  if (event.type === "reply.delivery") {
    // Detached, as the bus consumers were: the pipeline's job ends when the
    // reply is handed over, and the send's outcome lands in its own deliver
    // trace on the turn's correlation.
    void owner.sink.deliver(event).catch((err) => {
      console.error(
        `[${event.source} delivery] reply ${event.correlationId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return;
  }
  owner.sink.lifecycle(event);
  if (owner.holdsMirror && event.phase === "settled") {
    await releaseHold(
      event.source,
      parseScopedRef(event.chatRef).id,
      event.sourceMessageId,
      event.assistantId ?? null,
    );
  }
}
