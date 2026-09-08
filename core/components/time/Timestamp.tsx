/**
 * The shared `<Timestamp>`, re-exported at the path this app has always
 * imported it from. It lives in `@assistants-swarm-hub/ui` so app-contributed
 * dashboard UI renders instants exactly the way the shell does — one
 * component, one timezone rule (see `packages/ui/src/Timestamp.tsx`).
 */
export { Timestamp } from "@assistants-swarm-hub/ui";
