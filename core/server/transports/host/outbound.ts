import "server-only";

import type { PlatformConnection, SendContext } from "@assistants-swarm-hub/contracts";

import type { CollectTransport } from "@/features/self-improvement/server/collect-flows";
import { ApiError } from "@/lib/api-error";
import type { SourceOutboundPort } from "@/server/turn/source-outbound";

import { publishDelivered, sendChatMessage } from "./send";

/**
 * The core-driven sends for one hosted transport — what its internal HTTP
 * API served when it ran as its own service, as direct calls: the sends that
 * need something back (a delivered id, a refusal) or carry bytes (voice,
 * photos, files), the deletes, the chat titles, and the feedback-menu
 * operations the core-owned collection flow performs.
 *
 * Refusals keep the shapes the HTTP port's callers already handle: an action
 * the platform lacks is a `bad_request`, a platform that would not do it is
 * `service_unavailable` carrying the platform's own words. A connection that
 * is not running is the latter too — the send fails audibly and is recorded
 * on the run, never dropped.
 *
 * Every performed send is reported as a `message.delivered` event, which is
 * what the core mirrors and cross-feeds off; nothing here writes storage.
 */

export interface HostedOutboundDeps {
  send: SendContext;
  errorText: (err: unknown) => string;
}

interface Resolved {
  assistantId: string | null;
  direct: boolean;
  connection: PlatformConnection;
}

async function resolve(deps: HostedOutboundDeps, chatId: string, assistantId: string | null): Promise<Resolved> {
  let connection: PlatformConnection;
  try {
    connection = deps.send.connectionFor(assistantId);
  } catch (err) {
    throw ApiError.serviceUnavailable(deps.errorText(err));
  }
  return { assistantId, connection, direct: await connection.isDirectChat(chatId).catch(() => false) };
}

const refused = (deps: HostedOutboundDeps, err: unknown) =>
  ApiError.serviceUnavailable(deps.errorText(err), { cause: err });

export function hostedOutboundPort(deps: HostedOutboundDeps): SourceOutboundPort {
  const { send } = deps;
  return {
    async sendMessage(chatId, opts) {
      const ctx = await resolve(deps, chatId, opts.assistantId ?? null);
      try {
        const sent = await sendChatMessage(send, {
          chatId,
          assistantId: ctx.assistantId,
          direct: ctx.direct,
          text: opts.text,
          replyToSourceMessageId: opts.replyToSourceMessageId ?? null,
          threadId: opts.threadId ?? null,
          silent: opts.silent ?? false,
          linkableSourceMessageIds: opts.linkableSourceMessageIds ?? [],
        });
        return { sourceMessageId: sent.sourceMessageId };
      } catch (err) {
        throw refused(deps, err);
      }
    },

    // A voice reply is a platform capability; without it the core's TTS path
    // is refused the way the missing route was.
    async sendVoice(chatId, opts) {
      const ctx = await resolve(deps, chatId, null);
      if (!ctx.connection.sendVoice) throw ApiError.badRequest("this platform has no voice messages");
      const sendOpts = {
        replyToSourceMessageId: opts.replyToSourceMessageId ?? null,
        threadId: opts.threadId ?? null,
      };
      let sourceMessageId: string;
      let asVoice = true;
      try {
        const sent = await ctx.connection.sendVoice(
          chatId,
          { base64: opts.audioBase64, filename: "voice.ogg", text: opts.text },
          sendOpts,
        );
        sourceMessageId = sent.sourceMessageId;
        asVoice = sent.asVoice;
      } catch {
        // The voice bubble was refused — the answer still arrives, as text.
        try {
          // The text path splits under the cap and reports itself.
          const sent = await sendChatMessage(send, {
            chatId,
            assistantId: ctx.assistantId,
            direct: ctx.direct,
            text: opts.text,
            ...sendOpts,
          });
          return { sourceMessageId: sent.sourceMessageId, asVoice: false };
        } catch (err) {
          throw refused(deps, err);
        }
      }
      // The report records the spoken text — what history, search, and the
      // next turn's window read.
      await publishDelivered(send, {
        chatId,
        assistantId: ctx.assistantId,
        direct: ctx.direct,
        sourceMessageId,
        content: opts.text,
        replyToSourceMessageId: sendOpts.replyToSourceMessageId,
        threadId: sendOpts.threadId,
      }).catch(() => undefined);
      return { sourceMessageId, asVoice };
    },

    async sendPhotos(chatId, opts) {
      const ctx = await resolve(deps, chatId, null);
      if (!ctx.connection.sendPhoto) throw ApiError.badRequest("this platform has no photo sends");
      const threadId = opts.threadId ?? null;
      // Best-effort per image: a report failure must not turn a picture the
      // user can see into a failed call, and a send failure skips that image.
      const delivered: { sourceMessageId: string; stored: boolean }[] = [];
      for (const [index, base64] of opts.images.entries()) {
        let sent: { sourceMessageId: string; mediaId?: string | null };
        try {
          sent = await ctx.connection.sendPhoto(
            chatId,
            { base64, filename: `image-${index + 1}.png` },
            { threadId },
          );
        } catch (err) {
          console.error(`Failed to deliver a generated image to ${chatId}:`, deps.errorText(err));
          continue;
        }
        // The report carries the bytes: the core stores the picture as
        // ordinary pending media keyed by the id the platform just minted.
        const stored = await publishDelivered(send, {
          chatId,
          assistantId: ctx.assistantId,
          direct: ctx.direct,
          sourceMessageId: sent.sourceMessageId,
          content: "",
          replyToSourceMessageId: null,
          threadId,
          image: sent.mediaId ? { fileId: sent.mediaId, fileUniqueId: null, base64 } : null,
        })
          .then(() => true)
          .catch(() => false);
        delivered.push({ sourceMessageId: sent.sourceMessageId, stored });
      }
      return { delivered };
    },

    async sendFile(chatId, opts) {
      const ctx = await resolve(deps, chatId, null);
      if (!ctx.connection.sendFile) throw ApiError.badRequest("this platform has no file sends");
      const threadId = opts.threadId ?? null;
      let sourceMessageId: string;
      try {
        const sent = await ctx.connection.sendFile(
          chatId,
          { base64: opts.buffer.toString("base64"), filename: opts.filename, mime: opts.mime ?? null },
          { threadId, caption: opts.caption ?? null },
        );
        sourceMessageId = sent.sourceMessageId;
      } catch (err) {
        throw refused(deps, err);
      }
      // The caption is the delivered message's readable content.
      await publishDelivered(send, {
        chatId,
        assistantId: ctx.assistantId,
        direct: ctx.direct,
        sourceMessageId,
        content: opts.caption ?? "",
        replyToSourceMessageId: null,
        threadId,
      }).catch(() => undefined);
      return { sourceMessageId };
    },

    async deleteMessage(chatId, sourceMessageId) {
      const ctx = await resolve(deps, chatId, null);
      // A refused delete (too old, no such capability) is cosmetic for every
      // caller — the message simply stays standing.
      if (!ctx.connection.deleteMessage) return { deleted: false };
      try {
        await ctx.connection.deleteMessage(chatId, sourceMessageId);
      } catch {
        return { deleted: false };
      }
      // The soft-delete lands in the core's mirror through the outbound
      // wrapper; there is no event for it, because the delete is the core's call.
      return { deleted: true };
    },

    async setChatTitle(chatId, title) {
      const ctx = await resolve(deps, chatId, null);
      if (!ctx.connection.setChatTitle) throw ApiError.badRequest("this platform names its own chats");
      try {
        return await ctx.connection.setChatTitle(chatId, title);
      } catch (err) {
        throw refused(deps, err);
      }
    },
  };
}

/**
 * The feedback menus: the core-owned collection flow posts, edits and
 * removes its option menus through these; presses travel back through the
 * host's in-process core API.
 */
export function hostedMenus(deps: HostedOutboundDeps): CollectTransport {
  return {
    async sendMenu(input) {
      const ctx = await resolve(deps, input.chatId, input.assistantId);
      if (!ctx.connection.sendMenu) throw ApiError.badRequest("this platform has no button menus");
      try {
        const sent = await ctx.connection.sendMenu(input.chatId, {
          text: input.text,
          keyboard: input.keyboard,
          replyToSourceMessageId: input.replyToSourceMessageId,
        });
        return { sourceMessageId: sent.sourceMessageId };
      } catch (err) {
        throw refused(deps, err);
      }
    },

    async editMenu(input) {
      const ctx = await resolve(deps, input.chatId, input.assistantId);
      if (!ctx.connection.editMenu) throw ApiError.badRequest("this platform has no button menus");
      try {
        await ctx.connection.editMenu(input.chatId, input.sourceMessageId, {
          text: input.text,
          keyboard: input.keyboard ?? null,
        });
      } catch (err) {
        throw refused(deps, err);
      }
    },

    async deleteMenu(input) {
      const ctx = await resolve(deps, input.chatId, input.assistantId);
      // Cosmetic — a menu the platform will not delete simply stays.
      if (!ctx.connection.deleteMessage) return;
      await ctx.connection.deleteMessage(input.chatId, input.sourceMessageId).catch(() => undefined);
    },
  };
}
