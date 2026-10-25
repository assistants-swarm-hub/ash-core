import "server-only";

import type { SourceId } from "@assistants-swarm-hub/contracts";

import { webChatOutbound } from "@/features/web-chat/server/outbound";
import { findMessageRefs } from "@/lib/message-refs";
import { hostedTransport } from "@/server/transports/hosted";
import {
  filterMirroredMessageIds,
  markSourceMessageDeleted,
} from "@/server/source-store/repository";

/**
 * Outbound sends to the owning source — the calls that need something back
 * (a delivered message id, a mirror-checked refusal) or carry bytes, which
 * the fire-and-forget bus events cannot do: browsing acknowledgements (their
 * id is registered for deletion), voice replies (TTS audio), generated
 * images, and deletes. Plain text replies keep travelling as reply-delivery
 * bus events; the source persists both kinds itself.
 *
 * ONE port, every source: which one answers is resolved from the source id,
 * so the sends below are written once and a new source needs nothing here.
 * An action a platform does not have at all is not a port method with an
 * "unsupported" answer: it is a tool that source's own MCP server simply
 * does not offer.
 */

/**
 * Every id crossing this port is the OWNING platform's own, verbatim, as a
 * string — never parsed into a number. A 64-bit snowflake id does not survive
 * `Number()`, and a web thread's uuid never did; the store keeps message ids
 * as text end to end, so the port that hands them back must too.
 */
export interface SourceOutboundPort {
  sendMessage(
    chatId: string,
    opts: {
      text: string;
      replyToSourceMessageId?: string | null;
      threadId?: string | null;
      silent?: boolean;
      /**
       * The assistant whose bot sends (Phase 3: one connection per
       * assistant). Absent → whichever connection runs, the transitional
       * single-bot convention.
       */
      assistantId?: string | null;
      /** Core-resolved whitelist for `#<id>` citation links in `text`. */
      linkableSourceMessageIds?: readonly string[];
    },
  ): Promise<{ sourceMessageId: string }>;
  /** Voice bubble with the source's own text fallback; reports what was sent. */
  sendVoice(
    chatId: string,
    opts: {
      audioBase64: string;
      text: string;
      replyToSourceMessageId?: string | null;
      threadId?: string | null;
    },
  ): Promise<{ sourceMessageId: string; asVoice: boolean }>;
  /** Generated images; the source mirrors + stores each as pending media. */
  sendPhotos(
    chatId: string,
    opts: { images: string[]; threadId?: string | null },
  ): Promise<{ delivered: { sourceMessageId: string; stored: boolean }[] }>;
  /**
   * A file (a browser-run download), sent as playable media where the
   * container allows; the caption is mirrored as the message's content.
   */
  sendFile(
    chatId: string,
    opts: {
      buffer: Buffer;
      filename: string;
      mime?: string | null;
      caption?: string | null;
      threadId?: string | null;
    },
  ): Promise<{ sourceMessageId: string }>;
  /** `deleted: false` means the platform refused — cosmetic for every caller. */
  deleteMessage(chatId: string, sourceMessageId: string): Promise<{ deleted: boolean }>;
  /**
   * Name a conversation whose source asked to have it named
   * (`chatInfo.titleProvisional`). Absent on sources whose conversations have
   * real names of their own — most platforms' do — which is why it is optional
   * rather than a call that answers "unsupported".
   */
  setChatTitle?(chatId: string, title: string): Promise<{ title: string }>;
}

/**
 * One source's outbound port, or null when this deployment does not run that
 * source. Callers treat null exactly like v1 treated a stopped poller: the
 * send fails audibly and is recorded on the run/fire — never dropped.
 *
 * The web chat resolves to its in-process port since the dissolve (Phase 6),
 * and a transport to the port its host built. Either is wrapped with the
 * mirror bookkeeping that moved core-side in Phase 7: the `#id` link
 * whitelist rides the send, and a performed delete lands as a soft delete on
 * the mirror row (deliveries themselves are mirrored off the transport's
 * `message.delivered` events).
 */
export function sourceOutbound(source: SourceId): SourceOutboundPort | null {
  if (source === "chat") return webChatOutbound();
  const port = hostedTransport(source)?.outbound;
  if (!port) return null;
  return {
    ...port,
    async sendMessage(chatId, opts) {
      // Chat-wide whitelist: the port does not know the chat's stream shape,
      // and an over-wide list only ever renders a link (the operator plane's
      // unscoped read, the recorded follow-up).
      const linkable = await filterMirroredMessageIds(
        { source, chatId, assistantId: opts.assistantId ?? null, direct: false },
        findMessageRefs(opts.text),
      ).catch(() => []);
      return port.sendMessage(chatId, { ...opts, linkableSourceMessageIds: linkable });
    },
    async deleteMessage(chatId, sourceMessageId) {
      const result = await port.deleteMessage(chatId, sourceMessageId);
      if (result.deleted) {
        await markSourceMessageDeleted(
          { source, chatId, assistantId: null, direct: false },
          sourceMessageId,
        ).catch(() => undefined);
      }
      return result;
    },
  };
}

