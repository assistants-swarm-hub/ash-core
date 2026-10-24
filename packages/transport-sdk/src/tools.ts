import { readTurnMeta, type TurnToolMeta } from "@assistants-swarm-hub/contracts";

/**
 * The two checks every tool of a transport's own makes before it acts.
 *
 * The delivery tools (`reply_to_message`, `send_message`) are the core's and
 * are registered by the host; what a transport registers alongside them —
 * a reaction tool, say — meets the same binding, in `extra._meta` of the
 * call, and refuses the same way when it is missing.
 */

/**
 * The turn a hosted tool is bound to, or null when the call carries none or
 * belongs to another source.
 */
export function turnOf(meta: unknown, source: string): TurnToolMeta | null {
  const turn = readTurnMeta(meta);
  return turn && turn.source === source ? turn : null;
}

/** A tool result that says plainly that nothing happened. */
export function toolRefusal(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}
