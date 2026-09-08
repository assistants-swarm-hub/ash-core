import type { BotIdentity } from "@/features/bot-messaging/server/addressing";

/**
 * The bot identity used across messaging tests. The display name is deliberately
 * *not* a variation of the username: addressing treats the spoken name and the
 * @handle as separate routes, so a shared string would let either one pass a test
 * meant for the other.
 */
export const BOT: BotIdentity = { username: "MyBot", displayName: "Aria" };
