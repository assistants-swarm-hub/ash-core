import "server-only";

/**
 * The history feature's record shapes. The mirror lives in the core's
 * conversation store (`server/source/content.ts`), whose client maps rows
 * into these shapes so the composition code (transcripts, views, tools) is
 * the same for every registered transport. Nothing here touches a database.
 */

/** One mirrored message. */
export interface ChatMessageRecord {
  /** The store's monotonic insertion id. */
  id: number;
  /** Scoped ref of the chat this message belongs to (`acme:chat:42`). */
  chatRef: string;
  /** Source-local message id (`#<id>` anchors, trace correlations). */
  sourceMessageId: string;
  role: "user" | "assistant";
  /** Sender's source-local user id for `user` rows; null for the assistant. */
  userId: string | null;
  content: string;
  replyToSourceMessageId: string | null;
  sentAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  botReaction: string | null;
  createdAt: string;
}

/** Per-chat rollups for the History dashboard overview. */
export interface ChatSummary {
  chatRef: string;
  /** Human name of the transport the chat lives on, as it announced itself. */
  sourceLabel: string;
  /** The chat's title (a group), or its source-local id. */
  label: string;
  messageCount: number;
  lastSentAt: string;
}
