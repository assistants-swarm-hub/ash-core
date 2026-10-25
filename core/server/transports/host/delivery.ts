import "server-only";

import {
  parseScopedRef,
  type PlatformConnection,
  type ReplyDeliveryEvent,
  type SendContext,
  type SourceTraceClient,
  type TransportDescriptor,
  type TurnLifecycleEvent,
} from "@assistants-swarm-hub/contracts";

import { describeError } from "@/lib/describe-error";
import type { TurnEventSink } from "@/server/transports/hosted";

import { sendChatMessage } from "./send";

/**
 * The outbound half of the contract, called by the pipeline in-process: a
 * finished reply to perform (the send, reported back — the core mirrors and
 * cross-feeds) and the turn's lifecycle to render as the platform's typing
 * indicator. The pipeline hands both over through {@link TurnEventSink}
 * (`server/turn/turn-events.ts`), the same events it publishes on the bus
 * for a source this process does not host.
 *
 * The model never has to remember to deliver its own answer, and typing is
 * never a tool. Both were written identically in every transport.
 */

export interface HostedDelivery extends TurnEventSink {
  close(): void;
}

/**
 * Typing runs from `accepted` until `settled`. Keyed per turn so concurrent
 * chats never share a loop, and unref'd so it never holds the process open.
 */
class TypingLoops {
  private loops = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly connectionFor: (assistantId: string | null) => PlatformConnection,
    private readonly refreshMs: number,
  ) {}

  start(key: string, chatId: string, threadId: string | null, assistantId: string | null): void {
    if (this.loops.has(key)) return;
    const tick = () => {
      try {
        this.connectionFor(assistantId).sendTyping?.(chatId, threadId);
      } catch {
        // No running connection for this assistant right now.
      }
    };
    tick();
    const interval = setInterval(tick, this.refreshMs);
    interval.unref?.();
    this.loops.set(key, interval);
  }

  stop(key: string): void {
    const interval = this.loops.get(key);
    if (!interval) return;
    clearInterval(interval);
    this.loops.delete(key);
  }

  stopAll(): void {
    for (const key of [...this.loops.keys()]) this.stop(key);
  }
}

export function startDelivery(input: {
  descriptor: TransportDescriptor;
  send: SendContext;
  /**
   * The transport's one trace client — the same one the hosted tools use, so
   * a turn's delivery and its tool calls are recorded the same way.
   */
  traces: SourceTraceClient;
  /** Whether a chat is direct; the core's refs do not carry the kind. */
  isDirect: (chatId: string) => Promise<boolean>;
  onError?: (context: string, error: unknown) => void;
}): HostedDelivery {
  const source = input.descriptor.id;
  const onError =
    input.onError ??
    ((context: string, error: unknown) => console.error(`[${source} delivery] ${context}:`, error));
  const typing = new TypingLoops(input.send.connectionFor, input.descriptor.typingRefreshMs);

  return {
    async deliver(event: ReplyDeliveryEvent): Promise<void> {
      const chatId = parseScopedRef(event.chatRef).id;
      // The delivery half of the turn, on the turn's own correlation — in
      // Debug it lines up right after the core's reply trace.
      const trace = input.traces.startTrace({
        feature: "bot-messaging",
        action: "deliver",
        assistantId: event.assistantId,
        trigger: { kind: "transport", actor: event.chatRef, correlationId: event.correlationId },
        inputSummary: event.text,
      });
      try {
        const direct = await input.isDirect(chatId).catch(() => false);
        const sent = await sendChatMessage(
          {
            ...input.send,
            onReportFailure: (sourceMessageId, error) => {
              onError(`delivered report ${chatId}:${sourceMessageId}`, error);
              trace.event({
                message: "delivered report failed (message already delivered)",
                type: "db",
                level: "warn",
                data: {
                  sourceMessageId,
                  error: describeError(error),
                },
              });
            },
          },
          {
            chatId,
            assistantId: event.assistantId,
            text: event.text,
            direct,
            replyToSourceMessageId: event.replyToSourceMessageId ?? null,
            threadId: event.threadId ?? null,
            silent: event.silent,
            linkableSourceMessageIds: event.linkableSourceMessageIds ?? [],
          },
        );
        // A platform that cannot attach the reply target delivers the message
        // anyway rather than losing it; said out loud here.
        const replyTargetDropped =
          event.replyToSourceMessageId != null && sent.replyToSourceMessageId == null;
        const parts =
          sent.sourceMessageIds.length > 1 ? ` as ${sent.sourceMessageIds.length} messages` : "";
        trace.event({
          message: replyTargetDropped
            ? `reply sent${parts} — the platform did not attach the reply target`
            : `reply sent${parts}`,
          type: "external_call",
          level: replyTargetDropped ? "warn" : "success",
          data: {
            sourceMessageId: sent.sourceMessageId,
            sourceMessageIds: sent.sourceMessageIds,
            silent: event.silent,
            requestedReplyToSourceMessageId: event.replyToSourceMessageId ?? null,
            replyToSourceMessageId: sent.replyToSourceMessageId,
          },
        });
        await trace.succeed({
          outputSummary: `delivered ${chatId}:${sent.sourceMessageIds.join(",")}`,
        });
      } catch (error) {
        await trace.fail(error);
        throw error;
      }
    },

    lifecycle(event: TurnLifecycleEvent): void {
      const chatId = parseScopedRef(event.chatRef).id;
      const key = `${chatId}:${event.sourceMessageId}`;
      if (event.phase === "settled") {
        typing.stop(key);
      } else {
        typing.start(key, chatId, event.threadId ?? null, event.assistantId ?? null);
      }
    },

    close(): void {
      typing.stopAll();
    },
  };
}
