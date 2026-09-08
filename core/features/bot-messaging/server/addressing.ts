/**
 * The core's half of the addressing decision: does free text speak the
 * assistant's name? Pure and deterministic — no network calls — so it is fully
 * unit-testable and cheap to run on every message.
 *
 * The structural half (a direct chat, a reply to the bot, an @mention, a
 * command) is the transport's: it reads its platform's wire shape and sends
 * the verdict on the event. Nothing here knows any platform.
 *
 * People do not only address a bot by its handle — they call it by name, and in
 * a multilingual chat they write that name in their own alphabet or decline it
 * ("Ари, привет"). A literal match cannot see either, so when these rules find
 * nothing but the message could still be naming the bot, the result is
 * *undecided* ({@link AddressResult.needsAnalyzer}) and the caller settles it
 * with one LLM call — see `address-analyzer.ts`. Keeping that split here means
 * the cheap checks stay pure and only a genuinely ambiguous message costs a
 * completion.
 *
 * Deliberately NO cheap "name-shaped" pre-filter in front of the analyzer: one
 * was built and reverted (user decision, 2026-07-20) — any lexical gate is
 * weaker than the LLM at spotting the name in unfamiliar spellings, and a
 * missed summons costs more than the analyzer calls saved. Every undecided
 * group message goes to the analyzer.
 */

export type AddressSource =
  | "private"
  | "mention"
  | "reply"
  | "command"
  /** The display name, spelled exactly as configured. */
  | "name"
  /** The display name in another alphabet or an inflected form (LLM verdict). */
  | "analyzer"
  /**
   * Nobody addressed the bot: the turn was opened by a standing `always` chat
   * task that matched the message (see `features/tasks/server/matcher.ts`).
   * Never produced by the checks in this module — the caller sets it after the
   * addressing verdict has already come back negative.
   */
  | "task";

export interface AddressResult {
  addressed: boolean;
  source?: AddressSource;
  /**
   * True when nothing deterministic matched but the message is still a candidate
   * (a group message with text, and a bot display name worth looking for). The
   * caller runs the LLM analyzer; nobody else should treat this as "addressed".
   */
  needsAnalyzer?: boolean;
  /** Human explanation of the verdict, when there is one to give. */
  reason?: string;
  /**
   * The word the analyzer took for the display name, when it cited one — recorded
   * on the trace so a later "wasn't talking to you" report knows exactly which
   * word to exclude, rather than parsing it back out of {@link reason}. Present
   * on analyzer verdicts only, and on rejected ones too (a citation that failed
   * the verifier is still what the model saw).
   */
  matchedText?: string;
}

/** Minimal identity the name check and the analyzer need. */
export interface BotIdentity {
  /** The bot's platform handle, as the transport announced it. */
  username: string;
  /**
   * The name people actually speak — the assistant's name, as opposed to the
   * `@username` they type.
   */
  displayName: string;
}

/**
 * What each deterministic verdict says for itself. A turn the cheap checks
 * addressed records no LLM exchange, so these sentences are the whole account
 * of why the bot answered — they carry the evidence rather than name the
 * branch that fired.
 */
export const DETERMINISTIC_REASONS = {
  private: "a direct chat — every message in it is for the bot",
  reply: "the sender replied to one of this assistant's messages",
  mention: "the message @mentions this bot's username",
  command: "a /command addressed to this bot's username",
} as const;

/** The `name` verdict's reason, quoting the word the message actually used. */
export function spokenNameReason(matched: string): string {
  return `the assistant's name is spoken: "${matched}"`;
}

/**
 * Display names too generic to treat as a summons: a bot called "Bot" would
 * answer every message that mentions bots, and every one of those misses would
 * also cost an analyzer call.
 */
const GENERIC_DISPLAY_NAMES = new Set(["bot", "ai", "assistant", "the", "and", "cloud"]);

/** Below this, a "name" is too short to match without constant false positives. */
const MIN_DISPLAY_NAME_LENGTH = 3;

/** Whether a display name is specific enough to be worth matching at all. */
export function displayNameMatchable(displayName: string): boolean {
  const trimmed = displayName.trim();
  if (trimmed.length < MIN_DISPLAY_NAME_LENGTH) return false;
  return !GENERIC_DISPLAY_NAMES.has(trimmed.toLowerCase());
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether free text speaks the bot's display name (as opposed to @mentioning it).
 *
 * The name must stand as its own word and must not be the tail of an @handle
 * (`@AriaFanClub` is not a summons). The boundaries are `\p{L}\p{N}`-based rather
 * than `\b`, because `\w` is ASCII-only: a Cyrillic-named bot matched with `\b`
 * treats every Cyrillic letter as a word boundary, so a bot named "Бот" would
 * answer to "работа".
 */
export function messageNamesBot(text: string, displayName: string): boolean {
  return matchBotName(text, displayName) != null;
}

/**
 * The same check, returning the word AS IT APPEARS in the message (the name
 * matches case-insensitively, so the spelling the sender used is not
 * necessarily the configured one). The verdict records it, so a decision to
 * answer names its own evidence the way an analyzer verdict does.
 */
export function matchBotName(text: string, displayName: string): string | null {
  if (!text.trim() || !displayNameMatchable(displayName)) return null;
  const name = escapeRegex(displayName.trim());
  const re = new RegExp(`(?<![\\p{L}\\p{N}_@])${name}(?![\\p{L}\\p{N}_])`, "iu");
  return re.exec(text)?.[0] ?? null;
}

