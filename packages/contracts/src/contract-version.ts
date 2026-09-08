/**
 * The wire contract's major version — the one number a transport and a core
 * must agree on. It is bumped when an event, an internal route or the
 * registration shape changes incompatibly; a transport announces the major
 * it was built against at registration, and a core that speaks another
 * refuses it with a reason the dashboard shows (user decision, 2026-09-02:
 * a mismatch is never a silent drop).
 *
 * 2 (2026-09-03): every platform id on the wire is a string. The turn binding
 * a tool call carries (`threadId`, `replyToSourceMessageId`) and the delivery
 * a tool reports back (`sourceMessageId`) were numbers, which a 64-bit
 * snowflake does not survive.
 *
 * 3 (2026-09-04): the platform is named `assistants-swarm-hub`, and the name is
 * part of the wire — the bus channel (`assistants-swarm-hub:events`) and the
 * `_meta` key a tool call carries (`assistants-swarm-hub/turn`). A transport on
 * major 2 publishes to a channel nobody reads and reads a `_meta` key nobody
 * sends, which is silent rather than loud; the handshake is what turns it into
 * a refusal by name.
 *
 * 4 (2026-09-08): the platform was renamed `assistants-swarm-hub` (the GitHub
 * organization, the npm scope, the images and every repository moved with
 * it), and the name is on the wire — the bus channel is now
 * `assistants-swarm-hub:events` and the `_meta` key `assistants-swarm-hub/turn`.
 * A transport built on the `@assistant-hub-swarm` SDK publishes to the old
 * channel and reads the old key, so the handshake refuses it by name, as
 * major 3 did to major 2.
 */
export const CONTRACT_MAJOR = 4;
