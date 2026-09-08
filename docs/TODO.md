# TODO

The working tracker for pending work. It replaced `NEXTJS_REWRITE_PLAN.md` and
`NEXTJS_REWRITE_PROGRESS.md` (retired 2026-07-27): the v1 rewrite is complete,
so the phase plan, per-feature progress tables, session logs and the historical
Decision Notes are archive material — recoverable from git history — and only
the still-actionable information was carried forward here.

How to use this file:

- Update it before and after substantial work; statuses are `todo`,
  `in-progress`, `blocked`, `done`, `deferred`.
- A `done` entry records proof (files changed, tests run, build/typecheck/lint
  status, remaining risks) — and is then **pruned** once the work is shipped and
  documented under `docs/`. Git history is the archive; this file holds only
  open work.
- A `blocked` entry records the blocker, the attempted approach, and the next
  decision needed.
- Decisions are made by asking the user and recording the outcome against the
  entry it belongs to, here (no `docs/decisions/*.md` files).
- At handoff, leave short notes here: current state, next best task, known
  pitfalls, commands that passed or failed.

## Current state

The v2 redesign is complete (2026-08-31; design in `docs/PLAN.md`). Instead
of renaming the old repository, the redesign branch became `main` of a fresh
repository —
[assistants-swarm-hub/ash-core](https://github.com/assistants-swarm-hub/ash-core)
(user decision, 2026-09-01); the old `llm-tg-bot-nextjs` repo stays behind as
the archive. Commit-on-main is back in force. Entries below dated before
2026-08-21 predate the redesign — re-check their file paths against the
current tree before acting on them.

## Transport SDK: a new transport with zero core edits (`in-progress`, opened 2026-09-02)

**Where it stands (2026-09-08):** all seven phases have landed and every check
passes. The organization and every repository were renamed (item 12): the SDK
is **4.0.0** on contract major **4** and both transports run on it locally;
nothing under the new names is published yet. What is left is the pushes only
the user can make, in the order item 12 gives.

**Problem (user, 2026-09-02).** `docs/PLAN.md` and the overview promise that a
transport connects "without any core change", while
`docs/development/adding-a-transport.md` opens with a table of five core files
to edit and closes with seven Telegram-only surfaces. Both cannot stand. The
gap is structural, not a few lists: the source id is a compile-time enum
(`SOURCE_IDS = ["tg", "chat"]` in `packages/contracts/src/scoped-ref.ts`)
enforced by every event schema, every scoped ref, the tool app-scope, the
trace source and the registration request itself, so a container announcing
`id: "signal"` gets 400 from `/api/internal/transports/register` and retries
forever. The four packages a transport imports are private, unversioned and
export raw TypeScript, so nothing can be developed in another repository. The
release workflow publishes images to Docker Hub that `docker-compose.yml`
never references (it builds from source), so an operator has no image-based
service to copy.

**Target flow (user).** Someone develops a transport (any repo, any language);
publishes a Docker image; the core's owner adds one `image:` service to
compose; the transport self-registers and appears in the dashboard; done.
Any core edit for a new source id is a bug.

**Decisions (asked 2026-09-02, all answered by the user):**

- Transport ↔ core coupling stays **Redis + HTTP** as today (queue, bus,
  internal APIs). No HTTP-only rewrite.
- A transport **self-registers and appears enabled**; no admin pre-declare,
  no pairing code, no per-transport token (the shared `INTERNAL_API_TOKEN`
  stays). The admin on/off switch (entry below) remains a separate, optional
  item.
- The transport **picks its own source id** (short lowercase slug). The core
  accepts unknown ids at registration and validates every event's `source`
  at runtime against the registered transports. `chat` stays the one
  built-in in-process source. Scoped refs parse any slug prefix.
- **No capability flags and no platform limits in the core.** The core says
  what to deliver; the transport decides how. Reply splitting at Telegram's
  4096 chars leaves `features/bot-messaging/server/reply.ts` and moves into
  the Telegram transport; the feedback menu, voice, photos and files stay
  internal-API calls a transport renders however its platform allows.
- **Every dashboard surface is source-generic**: History, Analytics, search,
  summaries, Users, Groups, the Vision gallery, the Overview bot card, the
  tool app-scope select, the directory roster, the trace trigger kind and the
  timed task fire iterate the registered transports instead of the `"tg"`
  literal. This **reverses the 2026-08-27 decision** that the content plane is
  Telegram-only.
- **One published package, `@assistants-swarm-hub/transport-sdk`**, bundling the
  contracts, the queue/bus helpers, the token guard, `serveMcp`, the trace
  client, dashboard refresh and image normalization. Built output (ESM +
  d.ts), not raw sources.
- Registry: **GitHub Packages**, whose npm scope must equal the owning
  GitHub account. The user created the organization **`assistants-swarm-hub`**
  and moved the repository to
  [assistants-swarm-hub/ash-core](https://github.com/assistants-swarm-hub/ash-core)
  (2026-09-02). Follow-on naming (user, 2026-09-02): the SDK is
  `@assistants-swarm-hub/transport-sdk`; **every workspace package is scoped
  `@assistants-swarm-hub/*`** (renamed, so nothing suggests a scope that does
  not exist); images live in the org's **GitHub Container Registry** as
  `ghcr.io/assistants-swarm-hub/ash-core` and `ghcr.io/assistants-swarm-hub/ash-tg`
  (the release job authenticates with its own `GITHUB_TOKEN`; no Docker Hub
  secrets) — the `ash-tg` half was superseded by phase 4, which moved the
  Telegram image to `ash-transport-telegram` and its own repository; the transport repositories will be **`ash-transport-telegram`**
  and **`ash-transport-discord`** (an image published from one of them is
  named after its repository).
- The wire contract also ships language-neutral: **JSON Schema** generated
  from the zod event schemas and **OpenAPI** for the internal routes in both
  directions, committed under `docs/api/` and checked in CI against the
  source so they cannot drift.
- **SDK semver with a contract-major handshake**: registration carries the
  contract major; a core that does not speak it refuses with a reason that
  shows on the dashboard's transport roster (never a silent drop).
- Compose ships **pinned published images** (`ghcr.io/assistants-swarm-hub/…`)
  for core and tg with a `docker-compose.dev.yml` override that builds from
  source; the core stops `depends_on` any transport.
- **`apps/tg` moves to its own repository** on the published SDK, with its
  own release workflow and image; this repo keeps the core and the SDK.
- **Proof**: the Telegram transport building, publishing and running from a
  separate repository on the published SDK, image and compose — **plus a
  Discord transport** in a third repository as the second platform.

**Order of work (user): core first, then SDK, then compose, then the tg split.**

1. **Core accepts any transport** (`done`, 2026-09-03 — every sub-item below
   landed).
   - **Registration is open (`done`, 2026-09-02).** `SourceId` is a slug
     (`SOURCE_ID_PATTERN`, `isSourceId`, `WEB_CHAT_SOURCE`; `SOURCE_IDS` is
     gone), `sourceIdSchema` checks shape only, scoped refs parse any slug
     prefix. Registration carries `contractMajor` (`CONTRACT_MAJOR` in
     `packages/contracts/src/contract-version.ts`; `transports.contract_major`,
     migration `0014_brainy_starhawk`): a mismatch is upserted then refused
     409 by name (`incompatibilityReason`), gets no desired state, and its
     events fail at ingest (`isRegisteredTransport` in
     `server/ingest/consumer.ts`); the roster (`GET /api/transports`) carries
     `contractMajor`/`compatible`/`refusedReason` and the assistant editor
     shows "Refused: …" in place of the connection section. The literal
     registries are lookups now: `reconcileManagedConnections` walks
     `listCompatibleTransports()` (name from the row), `directorySources()`
     replaces `DIRECTORY_SOURCES` (`sourceLabels`/`sourceLabelOf` replace the
     sync label), `mediaSources()` is async over the roster, the Tools page
     app-scope select lists the registered transports. Trace trigger kind
     `transport` replaces `telegram` (legacy value kept readable). `apps/tg`
     announces `CONTRACT_MAJOR`. Docs: the manual's "Before you start" is the
     open-registration rule; OpenAPI `SourceId`/`ScopedRef` are patterns;
     `TransportView`/`TransportRegistrationRequest` carry the new fields.
     Proof: `npm run lint`, `npm run typecheck` (8/8), `npm run test`
     (contracts 16, service 3, tg 36, core 1182 passed), integration
     `server/transports` (new, 3 tests), `server/ingest`,
     `features/tool-connections` (36 passed). Not run: a live boot of core +
     tg after the change (no dev server was up); `npm run build`.
   - **The core stops splitting replies (`done`, 2026-09-02).** The core
     publishes the whole answer as one `reply.delivery`
     (`features/bot-messaging/server/service.ts`; `reply.ts` and its test are
     gone). The Telegram transport cuts under its cap in `apps/tg/src/split.ts`
     and `sendChatMessage` (`src/send.ts`) sends every part with the same
     reply target and reports each as `message.delivered`; the delivery
     consumer, the internal message route, the voice text-fallback and the
     MCP delivery tools all go through it (`SentChatMessage.messageIds`
     lists the parts, `messageId` is the first). Docs: the manual's Step 4
     ("You split"), `message-pipeline.md` Stage 7, `features/bot-messaging.md`.
     Proof: `npm run typecheck` (8/8), `npm run lint`, `npm run test` (tg 44
     incl. `split.test.ts` + `send.test.ts`, core 1175). Not run live.
   - **The Overview and the shell summarize every transport (`done`,
     2026-09-02).** `server/transports/status.ts` walks `listTransports()`
     into per-transport rosters (`listTransportRosters`), and
     `summarizeTransports` ranks a refused transport, a failed listing, then
     the first failing connection (named by handle, else by transport + masked
     config) above running/stopped; `getTransportsStatus` feeds the shell. The
     Overview's card is "Bots" (with "No transport" when nothing registered)
     and renders one start/stop block per transport titled with its announced
     name (a refused one shows its reason). The dead Telegram-shaped operator
     contracts (`operatorConnection*`, `operatorSourceSettings*`, unused since
     the registration slice) left `packages/contracts`. Docs: operator guide,
     troubleshooting, deployment checklist, backup, the manual's surfaces
     table. Proof: `server/transports/status.test.ts` (6 tests), `npm run
     typecheck` (8/8), `npm run lint`. Not run live.
   - **Every remaining surface is source-generic (`done`, 2026-09-02).**
     The content plane is `server/source/content.ts` (`tg-content.ts` is
     gone): chats are named by scoped ref, message ids are TEXT end to end
     (`sourceMessageId`/`replyToSourceMessageId` — a snowflake would not
     survive `Number()`), and every cross-chat read (day/hour scans, search,
     analytics series, the search index, summary counts) walks
     `contentSources()` — the transports on this core's contract major — with
     the store's aggregates taking a source list (`sourceIn`). History lives
     at `/history/<ref>`, the overview lists every transport's chats with
     the transport's announced name, search hits and the CSV transfer speak
     `chat_ref`/`source_message_id`, and the summary/extraction markers key
     by ref directly. `known-users`/`known-groups` take the source on every
     read and write; a group is a chat with a `source_chats` row (the
     ingest stores one for non-direct chats only) and a direct chat's
     participants are its senders (`listChatParticipantIds`), so
     `lib/telegram.ts` (`isGroupChatId` and the other Telegram constants)
     is deleted from the core; `getChatLanguage`/`getChatContext` serve the
     out-of-turn callers (task fires, browser runs). Memory, self-improvement
     (feedback rows carry `source`, preferences key by `userRef`, exclusions
     store refs) and the tool context (`source` required) have no default
     source. Tasks derive `chatRef`/`chatSource` from the stored ref, the
     API takes `chatRef`, the dashboard picks chats across every transport,
     and a timed fire binds its tool context to the task's chat's transport.
     Vision's repository takes the source; the legacy in-core Telegram
     media ingest (`ingestMessageMedia`, `detect.ts`, `telegram-files.ts`,
     `frames.ts`) is deleted; the gallery labels rows with the registered
     name. Browser runs store `chat_ref`/`created_by_user_ref` and deliver
     through the transport the ref names; the download cap is the operator's
     limit, not a platform constant. Analytics filters are `chatRef`/`userRef`;
     `chat_hour_insights`/`period_insights` key by `chat_ref` (migration
     `0015_chat_refs_in_insights`, hand-written: rename + backfill of the
     rows that could only have been Telegram's, plus `addressing_exclusions
     .source_message_id` to text and the browser-run columns). Prompts and
     dashboard copy no longer say Telegram where the platform is not the
     point; the chat-context surface line uses the transport's registered
     name. Docs: the manual's closing section is now "What the dashboard
     shows for your transport" (the two conventions a transport must
     follow), `docs/api/{endpoints.md,openapi.yaml}`, `features/{history,
     analytics,tasks,vision,browser-agent}.md`, `architecture/data-model.md`.
     Proof: `npm run typecheck` (8/8), `npm run lint`, `npm run test`
     (contracts 16, service 3, tg 44, core 1158 passed / 26 skipped),
     `npm run test:integration -w @assistants-swarm-hub/core` (41 files: 420
     passed, 30 skipped; the suites that walk the roster register a fixture
     transport via `test/transports.ts` and point the default store handle
     at their container, like the ingest suite), migration 0015 applied to
     the dev database (`npm run db:migrate`). Not run live: a boot of core +
     tg after the change (no dev server was up; the preview cannot sign in
     after a restart), `npm run build`.
   - **Ids are strings, correlations carry the source (`done`, 2026-09-03).**
     Contract major **2**: the turn binding a tool call carries
     (`threadId`, `replyToSourceMessageId`) and the delivery a tool reports
     back (`sourceMessageId`) were `z.number()` — a Discord snowflake does not
     survive `Number()`. Inside the core the same ids stopped being numbers on
     the whole turn path: `SourceOutboundPort` (every send answers
     `{ sourceMessageId }`, `deleteMessage` takes one, `threadId`/
     `replyToSourceMessageId` are strings — the four `Number(body.sourceMessageId)`
     round-trips are gone), `IncomingMessage`/`SentMessage`/`recordReply` in
     `features/bot-messaging`, the browser-agent ack registry, the tasks fire's
     delivery accounting, and `tasks.thread_id`/`browser_agent_runs.thread_id`
     (migration `0016_thread_ids_as_text`). The web chat's own serial ids cross
     the port as strings and are parsed back only in its own port and tools;
     `apps/tg` parses Telegram's at its boundary through one helper
     (`telegramId`). `turnCorrelationId` now takes the chat's **ref**
     (`tg:chat:-100:42:assistant`, and `tg:chat:-100:42` for work that belongs
     to the message rather than one assistant's turn), every trace actor is a
     scoped ref, and `toolContextTrigger` is the one place that shape is built
     (`tool-trace.ts` calls it instead of repeating it). Analytics' `inScope`
     compares refs whole; the reply-trace lookup uses a new
     `getLatestTraceIdForMessage`, which also fixes a turn trace being
     unfindable because the assistant is part of its id. `turbo.json`'s
     `typecheck`/`test` now depend on `^typecheck` — without it turbo served a
     cached `apps/tg` typecheck while `packages/contracts` had changed under
     it, which is how a broken tg build passed `npm run typecheck` here.
     Proof: `npm run lint`, `npm run typecheck` (8/8), `npm run test`
     (contracts 20, service 3, tg 44, core 1159 passed / 26 skipped),
     `npm run test:integration -w @assistants-swarm-hub/core` (41 files: 420
     passed, 30 skipped), migration 0016 applied to the dev database. Docs:
     the manual (contract major 2, the binding's field names), `contributing.md`,
     `architecture/{observability,data-model}.md`, `docs/api/openapi.yaml`.
     Not run live: a boot of core + tg after the change.
2. **SDK package** (`done`, 2026-09-03).
   - `packages/transport-sdk` at **1.0.0**: one curated public surface
     (`src/index.ts`) over `contracts` + `bus` + `service` + `media`, built by
     tsup to `dist/` as ESM + `.d.ts` with `noExternal: [/^@assistants-swarm-hub\//]`
     — the four packages are `devDependencies` and are **bundled in**, so the
     published manifest names no dependency an outsider cannot install. Hono,
     its node adapter, the MCP SDK and zod are `peerDependencies` (the author
     constructs those objects and hands them across; two `McpServer` classes
     in one process is a bug worth designing out); bullmq, ioredis and sharp
     are ordinary dependencies. `publishConfig` points at GitHub Packages.
     The surface is deliberately narrower than the contracts package: the
     core's dashboard DTOs, operator listings and content plane are not in it,
     because a transport never speaks them and the SDK's semver would
     otherwise promise shapes the dashboard changes freely.
   - **The dead internal-API contracts are gone.** `internalMedia*` and
     `internalFeedback*` in `packages/contracts/src/internal-api.ts` described
     routes no transport has served since the Phase 7 de-storing, and nothing
     in either app imported them — publishing them as "the wire" would have
     been a document that lies. The surface is sends-only now.
   - **The wire ships language-neutral**: `packages/transport-sdk/scripts/
     generate-wire-contract.ts` (`npm run wire:generate -w
     @assistants-swarm-hub/transport-sdk`) writes `docs/api/transport/
     events.schema.json` (JSON Schema 2020-12 for every event, from
     `z.toJSONSchema` with `unrepresentable: "throw"`) and `docs/api/transport/
     openapi.yaml` (OpenAPI 3.1 for both HTTP directions). Only prose is
     hand-written there; every body shape comes from the zod schemas.
   - **Drift check**: `packages/transport-sdk/src/wire.test.ts` regenerates
     both files and compares byte for byte, with the generator command in the
     failure message. It runs in `npm run test`, which is the release
     workflow's own gate — so the check is in CI without adding a second
     workflow (there is no PR/push CI in this repo; asking for one is a
     decision for the user, not a thing to add silently).
   - **`publish-sdk` in `release.yml`**, gated like the images: the `version`
     job now applies one `check()` to each shippable manifest and outputs
     `sdk_changed`/`sdk_version`; `verify` runs when either changed; the new
     job builds, publishes to GitHub Packages with the workflow's own
     `GITHUB_TOKEN` (skipping a version already published, so a re-run is a
     no-op) and tags `transport-sdk-v<version>`. The push trigger's `paths`
     gained the SDK manifest. `turbo.json`'s `build` outputs gained `dist/**`
     — an undeclared output caches as "nothing produced".
   - **The manual is rewritten for an outsider**: it opens with "you do not
     need this repository" and a table of the three things that are published,
     Step 1 is an ordinary npm project with an `.npmrc` line (plus what to do
     in another language), Step 9 is "ship an image" and ends at the one
     compose service an operator adds, Step 10 leads with validating your
     fixtures against the JSON Schema, and the `apps/tg` links are marked as
     the worked example that will move. Every `packages/*` path is gone from
     it. Also updated: `docs/api/README.md`, `docs/architecture/overview.md`,
     `docs/development/testing.md` (the drift check and the turbo cache
     gotcha), `docs/operations/deployment.md` (the second release artifact),
     `docs/PLAN.md`, `README.md`, `AGENTS.md`, `.gitignore`.
   - **The declaration build was the whole difficulty, and it is fixed.**
     `noExternal` inlines the JS, but tsup's dts pass is a separate program
     that ignored it and emitted `export { … } from
     "@assistants-swarm-hub/contracts"` — a 3 KB `.d.ts` that resolves to
     nothing on an installer's machine, so every type in the package would
     have been `any` for the author who installed it. `dts: { resolve: [...] }`
     did not help either: the private packages export raw `.ts`, which
     rollup-plugin-dts cannot take as a declaration input. What fixes it is
     `paths` in `packages/transport-sdk/tsconfig.json` mapping the four
     packages to their sources, which puts them in the SDK's own compilation
     — the declaration is 73 KB now and its only remaining imports are
     `zod`, `hono`, `@modelcontextprotocol/sdk` and `bullmq`.
   - **Proof.** `npm run lint`; `npm run typecheck` (9/9); `npm run test`
     (contracts 20, service 3, tg 44, **transport-sdk 3**, core 1161 passed /
     26 skipped); `npm run build -w @assistants-swarm-hub/transport-sdk`
     (ESM 45 KB + d.ts 73 KB). The integration suite's 420-passed run is the
     one recorded on the entry above, taken **before** this slice's contracts
     pruning; Docker Desktop stopped before it could be repeated. What the
     pruning removed had no importers anywhere (`grep` across both apps) and
     is covered by typecheck and the unit suites, but the honest statement is
     that the integration suite has not run against this exact tree. The drift
     check was proved to actually fail: flipping `x-contract-major` in the
     committed JSON failed `wire.test.ts` with the regenerate command in the
     message, and passed again on restore. `npm pack` ships 5 files (README,
     dist, manifest; 60 KB). **End to end**: the packed tarball was installed
     into a scratch project outside the repository together with the four
     peers — it typechecks (`skipLibCheck: true`, `@types/node`) and runs,
     printing `contractMajor: 2`, `signal:chat:group.abc:42:assistant-1` from
     `turnCorrelationId`, the reply target read back off a turn binding, and
     a `delivery` result — with no `@assistants-swarm-hub/*` anywhere in its
     `node_modules`. Not run: the release workflow itself (needs a version
     bump on main), and a live boot of core + tg.
3. **Compose on images** (`done`, 2026-09-03). `docker-compose.yml` runs
   released images — `ghcr.io/assistants-swarm-hub/ash-{core,tg}:${ASH_VERSION:-<version>}`
   — and builds nothing; `docker-compose.dev.yml` is the override that adds a
   `build:` back to those two services and changes nothing else (so the two
   files cannot drift on ports, volumes, environment or healthchecks). The
   core's `depends_on` no longer names `tg`: it depends on no transport at
   all, which is what makes "add a transport" one service and no core edit.
   - **The pin cannot go stale.** A literal pin in the operator's own artifact
     would silently start a clone on an old build, so `scripts/pin-compose-version.mjs`
     rewrites the `${ASH_VERSION:-…}` defaults from the root `package.json`;
     `npm run release:{patch,minor,major}` call it (`release:pin`), and the
     release workflow's verify job runs it with `--check` and refuses to ship
     on a mismatch. Only the default is touched — an operator's `ASH_VERSION`
     still wins.
   - Docs: `docs/operations/deployment.md` gained an **Adding a transport**
     section (the one service, the three things easy to get wrong: the shared
     token, no published port, no `depends_on` edge on the core) and its
     upgrade section now says a transport upgrades on its own schedule with
     `CONTRACT_MAJOR` as the only agreement. `README.md`,
     `docs/getting-started.md`, `docs/configuration.md` (`ASH_VERSION`) and
     the transport manual's Step 9 follow.
   - Proof: `docker compose config` on the base file (images pinned, no
     `build`, `depends_on` = db + redis only), on the base + dev override
     (both services build, still tagged with the pinned name), and with
     `ASH_VERSION=1.47.0` (both images move); `npm run lint`; the pin script
     exercised end to end — a bumped version fails `--check`, `npm run
     release:pin` rewrites both pins, `--check` then passes, restored. Not
     run: an actual `docker compose up` against the registry (the images for
     this version are not published yet — the release workflow has never run),
     and the Docker daemon was down for anything needing it.
4. **tg split** (`done` in this repository, 2026-09-03 — the new repository is
   **staged locally and unpushed**; see "on the user" below).
   - **The new repository was staged as `ash-transport-telegram`** beside this
     one in the org workdir (`git init`, three commits, **no remote — nothing
     was pushed** at the time). 39 files: `src/**` moved verbatim, a standalone
     `package.json`/`tsconfig.json`, a standalone `Dockerfile` (no workspace
     context, `.npmrc` for the SDK's scope, its own `HEALTHCHECK`), its own
     `release.yml` (a changed `version` on main builds, pushes
     `ghcr.io/<owner>/ash-transport-telegram:<version>` + `:latest`, tags), and
     a README that doubles as the worked example's index.
   - **Every import is the SDK's.** The 14 files that imported
     `@assistants-swarm-hub/{contracts,bus,service,media}` now import
     `@assistants-swarm-hub/transport-sdk`, merged into one statement per file.
     Comments naming files that repository does not have were rewritten; the
     README explains that "Phase N"/"v1" citations refer to this repo's history.
   - **The split found a real dependency bug.** `apps/tg` declared
     `@grammyjs/types ^3.28.0` while current grammy pins `5.0.0` exactly. The
     monorepo lockfile hid it (grammy 1.44, one hoisted copy); a fresh
     standalone install took grammy 1.46 and **two** copies of the types, and
     nothing compiled. Fixed there: `grammy ^1.46.0` + `@grammyjs/types ^5.0.0`.
   - **Proof (new repo)**: with the SDK installed from a locally packed tarball,
     `npm run typecheck` passes and `npm run test` is **44 passed / 5 files** —
     the same suite, with no access to this repository. No lockfile is committed
     there: the only install that works today resolves the SDK from a `file:`
     path on one machine.
   - **The core-side cutover is done here** (user decision, 2026-09-03: cut over
     now rather than waiting for the new repo to publish). `apps/tg` is deleted;
     the release matrix has one entry (`ash-core`); `docker-compose.yml`'s `tg`
     service is `ghcr.io/assistants-swarm-hub/ash-transport-telegram` on its own
     `ASH_TELEGRAM_VERSION` (it no longer follows `ASH_VERSION`);
     `docker-compose.dev.yml` builds only the core. Every `apps/tg` reference in
     the docs and in core comments is gone — the manual's worked-example links
     point at the new repository, and the code pointers in the pipeline and
     feature docs read `ash-transport-telegram/src/…`.
   - **Proof (this repo)**: `npm run lint`, `npm run typecheck` (8/8),
     `npm run test` (contracts 20, service 3, transport-sdk 3, core 1161 passed
     / 26 skipped), `docker compose config` on base and base+dev, the compose
     pin check. `git grep apps/tg` is empty outside this entry.
   - **Known window, accepted by the user:** until the new repository is pushed
     and releases its first image, `ghcr.io/assistants-swarm-hub/ash-transport-telegram:1.0.0`
     does not exist, so `docker compose up` cannot start the `tg` service, and
     `npm run dev` here starts only the core. Both resolve the moment step (2)
     below lands.
   - **Pushed by the user, 2026-09-03**, and its first CI run failed on
     `actions/setup-node`'s `cache: npm`, which hashes a lockfile and hard-fails
     when there is none — the state this repository is in until the SDK is
     published. Fixed there (cache dropped, with a note to restore it in the
     same commit as the lockfile), along with a **correction**: GitHub Packages
     wants a token on every npm request, so "public, so pulling it needs no
     token" was wrong in that repo's Dockerfile, `.npmrc` and README, and in
     this repo's manual and SDK README. The image build now takes the token as
     a BuildKit secret and the workflow passes its own `GITHUB_TOKEN`.
   - **SDK published and made public by the user, 2026-09-03.** The transport's
     `verify` job now has an explicit `permissions: { contents: read, packages:
     read }` — it installs the SDK with the workflow's own token, which works
     only while a repository's default workflow permissions are the permissive
     ones, and a restricted repository would have 401'd on a public package.
   - **Settled, 2026-09-04**: the lockfile is committed and `cache: npm` is
     back in `setup-node`, resolved from the registry rather than a packed
     tarball.
5. **Discord transport** (`done`, 2026-09-04 — the user created and pushed
   [assistants-swarm-hub/ash-transport-discord](https://github.com/assistants-swarm-hub/ash-transport-discord);
   the runtime port of phase 6 sits unpushed on top of it).
   - **Staged as `ash-transport-discord`** beside this one in the org workdir
     (`git init`, no remote). On discord.js 14 and the SDK's API — written
     against `docs/development/adding-a-transport.md` and the SDK alone, with
     no access to this repository assumed.
   - **The core needed no change to accept it.** No branch, no capability
     flag, no list with `discord` added: that is the claim the contract has
     been making, and this is the first time something other than the
     transport it was designed around has made it.
   - **Same shape as the Telegram one**, because the contract is: `core/`,
     `inbound/`, `outbound/`, `http/`, and `discord/` as the only code that
     knows the platform. What genuinely differs is confined to that folder and
     listed in its README: snowflake ids no code may parse (`Number()` eats
     them — the reason the wire is strings), a 2000-character cap that makes
     splitting ordinary rather than rare, structured `<@id>` mentions instead
     of a name to match (a role or `@everyone` ping is deliberately not
     addressing), buttons instead of an inline keyboard, an interaction that
     must be answered within three seconds, and no voice bubble — so a voice
     reply is sent as audio and honestly reported `asVoice: false`.
   - **Two routes are absent rather than stubbed.** A Discord channel always
     has its own name, so `PUT /internal/chats/:id/title` is not served; an
     action a platform lacks is a route that does not exist, never one that
     answers "unsupported". The contract's no-capability-flags rule held.
   - **The schemas caught two mistakes the types alone would not have**: an
     edit event needs the chat and the receiving assistant, and a reaction
     event carries `up`/`down` rather than an emoji — the platform's emoji
     vocabulary is the transport's to interpret, so `thumbVerdict` maps it.
   - **Proof**: `npm run typecheck` and `npm run test` (**27 tests / 3 files**:
     every addressing verdict with its reason, the split at Discord's cap
     including that it is 2000 and not Telegram's 4096, and that a snowflake
     survives as a string), against the SDK installed from a locally packed
     2.0.0 tarball. Not run: anything against live Discord, and the image
     build.
   - **Created and pushed by the user, 2026-09-04** (`90cf133` is on `origin`);
     its lockfile is committed since. A live check needs a bot from the Discord
     Developer Portal with the **MESSAGE CONTENT** intent enabled — without it
     the bot connects, looks healthy, and sees every message as empty.

6. **The SDK owns the runtime** (`done`, 2026-09-04 — staged in all three
   repositories, unpublished).
   - **The question that started it (user, 2026-09-04):** "if transports have
     differences only in telegram and discord folders, what's the point of all
     other code?" Measured before answering — of the two transports' 6200
     lines, `core/`, `outbound/`, `http/` and `index.ts` (~1500 lines each)
     were the same file twice with two platforms' nouns in them, while
     `telegram/`/`discord/` and `inbound/` genuinely differed. Two copies is a
     coincidence; the third transport would have made it a rule, and every one
     of those copies is a place for the contract to drift per platform.
   - **Decision (user, asked and answered 2026-09-04): extract the runtime.**
     The wire does not change, so `CONTRACT_MAJOR` stays **3**; the SDK's own
     API does, so it goes to **3.0.0**.
   - **What moved into `packages/transport-sdk/src/runtime/`:**
     `service.ts` (`startTransportService` — env, boot order, registration
     with retry, reconcile on `transport.config.changed`/`assistant.deleted`,
     ordered shutdown), `manager.ts` (`ConnectionManager` — desired-state
     reconcile, supervision with a flat 15 s retry while the core still wants
     a connection, the dashboard-refresh ping), `core-api.ts` (register,
     desired, mirror lookup, menu-press toast), `inbound.ts` (dedupe key,
     shared-chat suppression + presence, the receivers list, the envelope),
     `updates.ts` (queue publisher, envelope, seen-cache), `send.ts` (the one
     send: split, send each part, report each as `message.delivered` with what
     the platform actually attached), `split.ts` (the cap is an argument now —
     4096 and 2000 are the same algorithm), `delivery.ts` (the bus consumer,
     the typing loops, the deliver trace), `http.ts` (`/health`, every
     `/internal/*` route, `/mcp`), `mcp.ts` (the two delivery tools, `turnOf`,
     `toolRefusal`) and `reactions.ts` (`reactToMessage`).
   - **Absent, not stubbed.** `PlatformConnection` declares every action past
     `sendMessage` as optional, and the runtime mounts a route or offers a
     tool only where the method exists. No capability flags — a platform that
     cannot do a thing has no method for it, and the core finds out by asking.
   - **Reacting splits at the right seam.** The mirror gate (a guessed id, or
     the bot's own message, refused before the platform is touched) and the
     `transport.bot-reaction` record are the contract's, so they are
     `reactToMessage` in the SDK; the emoji are the platform's, so each
     transport registers its own `set_message_reaction` over it. That fixed a
     real bug: the Discord transport was setting reactions **without**
     publishing `transport.bot-reaction`, so the next turn would have denied
     reacting (the exact operator report of 2026-08-15, reintroduced by
     copying the file that did not have it).
   - **Dead code found and removed:** `checkCrossFedAddressed` existed in both
     transports and was called by nothing but its own tests — the cross-feed
     verdict is the core's (`server/ingest/consumer.ts`). `findMessageRefs`
     was unused in the Telegram transport.
   - **The transports are their platforms now.** Telegram **3488 → 1679**
     lines, Discord **2549 → 950**, each `index.ts` a single
     `startTransportService` call over a descriptor, an adapter, a normalizer
     and an addressing rule. `core/`, `outbound/` and `http/` are gone from
     both.
   - **Docs.** The manual is restructured: Step 2 is now "Implement four
     things and call the runtime", the wire walk (Steps 3–11) is what the
     runtime does on your behalf — kept for non-Node authors, for debugging
     and for reimplementation — and every reference into the Telegram repo
     points at a file that still exists. Both transport READMEs and the SDK
     README lead with the runtime.
   - **Proof.** SDK: `npm run build` (98 KB d.ts, no private-package imports),
     `npx tsc --noEmit`, `npx vitest run` (**19 tests / 4 files** — the wire
     drift check plus new `split`, `inbound` and `send` suites covering the
     contract logic that used to be duplicated). Telegram: `npx tsc --noEmit`,
     `npx vitest run` (**35 tests / 3 files**). Discord: `npx tsc --noEmit`,
     `npx vitest run` (**16 tests / 2 files**). Not run: anything live, and
     the image builds.
   - **Known gap, left as it was:** the Discord transport ignores
     `linkableSourceMessageIds` — Telegram renders those citations as tappable
     links in its HTML, and Discord does not render masked links in ordinary
     message content, so there is no obvious equivalent. Not invented; ask the
     user what a Discord citation should look like before wiring it.
   - **Published by the user, 2026-09-04**, and both transports moved onto it:
     `npm install` in each resolved `@assistants-swarm-hub/transport-sdk@3.0.0`
     from GitHub Packages (Telegram's lockfile updated; Discord's lockfile was
     never committed at all, so it is now). Typecheck and tests pass in both
     against the PUBLISHED package rather than a hand-copied build — Telegram
     35 tests, Discord 16. The Telegram transport is bumped to **1.1.0** so the
     runtime port actually ships: same env, same port, same wire, a different
     inside. Discord stays 1.0.0, having never released.

11. **Live sweep of the Discord surface** (`done`, 2026-09-04).
    - The user exercised the paths that had never run. Working first time:
      **an image** (described), **the reaction tool** (asked for a like, got
      one — and its new trace is in Debug), **an edit**. Twenty-four Discord
      traces, and every `inbound`/`reply`/`deliver` succeeded.
    - **Feedback did not work, either thumb.** `self-improvement/collect-feedback`
      failed twice with `components[BASE_TYPE_MAX_LENGTH]: Must be 5 or fewer`
      (Discord code 50035). The transport's fault: the core sends a plain grid
      and knows no platform's limits, so it lays a menu out one option per row
      — right for a narrow Telegram keyboard, which has no row limit. Discord
      allows FIVE action rows; the like menu is six and the dislike menu seven,
      and `toComponents` mapped the grid one-to-one. So no feedback was
      collectable on Discord at all.
    - **Fixed by re-packing, not truncating** (`fitToRows`): dropping an option
      would quietly change the question being asked. Rows are the narrowest
      width that still fits everything, so long labels stay readable rather
      than five being crammed in whenever they would go; past Discord's 25
      buttons it throws instead of losing them. Six tests
      (`src/discord/menu.test.ts`), 22 in the transport.
    - **One `skipped` in the sweep is correct, not a defect**: a channel
      message that was not addressed reached the LLM analyzer, which answered
      `name_match: absent`. That is the gate working.
    - **Still unexercised on Discord**: a voice note inbound, a generated image
      outbound (`sendPhoto` returns `mediaId: null` here — Discord serves
      attachments from a CDN URL with no re-usable file id, so the core has
      nothing to key stored media by), the delivery MCP tools, and the
      cross-feed between the two platforms now that one assistant spans both.

10. **The profile was neither live nor reversible** (`done`, 2026-09-04).
    - **Found live (user, 2026-09-04):** "identities have to auto refresh after
      linking is done. there is no option to UNLINK account from Profile page."
      Both correct.
    - **The page had no live refresh at all.** `redeemLinkCode` already
      published `users` and `accounts`, and `ProfileManager` subscribed to
      nothing — so linking, which happens on ANOTHER PLATFORM ENTIRELY, could
      not possibly show up without a reload. It is the one page where the state
      changes from somewhere the user is not looking.
      `useLiveRefresh(["users", "accounts", "memory"])` covers the link graph,
      the profile itself, and the memory documents that arrive with a newly
      linked identity.
    - **Linking had no undo.** `unlinkOwnIdentity` is the mirror of redeeming a
      code and refuses the same way the memory delete does: not one of your
      identities → 403, your own web identity → 400, since that is not a link
      but the thing links are made TO. Removing the second-to-last member drops
      the link row, because a link of one means nothing. `DELETE
      /api/profile/identities?ref=…`, access `account`, traced like every other
      write; admins keep the Users page for everyone else's.
    - **Proof.** Three integration tests against a real Postgres
      (`accounts.integration.test.ts`, 14 in the file now): the two-member link
      is deleted outright, a bigger link keeps its other members, and both
      refusals leave the graph untouched. Core `lint`, `typecheck`, `test`
      (1165 + 19). **Verified in the browser**: the SSE stream is connected, both
      Unlink buttons render, the confirm names the right platform, and Cancel
      leaves the graph alone. That check found one more defect — the two
      buttons had the SAME accessible name, because one person usually carries
      the same handle everywhere; the label now carries the platform.

9. **A link code could not be redeemed where a mention is mandatory**
   (`done`, 2026-09-04).
   - **Found live (user, 2026-09-04):** `@bot link-xxxxxxxx` in a Discord
     channel fell through to the model, which improvised an apology about not
     seeing a link. Two defects behind it.
   - **The Discord transport stored raw mention tokens.** `message.content`
     puts a mention on the wire as `<@1545468913393860950>`, and that snowflake
     was what the mirror kept, the search index held and the model read. The
     normalizer uses `cleanContent` now — the readable `@name` a person sees —
     for the message and for a quoted one. Outgoing text already stripped raw
     mention tokens; this is the same rule inbound. It corrupted every
     mentioning message, not only link codes.
   - **The rule itself was unreachable on a mention platform.** A code must be
     the WHOLE message (`^link-[a-z0-9]{8}$`), which is exactly what makes it
     safe to redeem on sight — but addressing a bot in a shared channel
     REQUIRES mentioning it, so the code is never alone. Telegram groups had
     the same hole since the beginning; only direct chats ever worked.
   - **Decision (asked 2026-09-04, user chose "accept mention + code"):**
     `withoutAddressing` strips a leading run of `@handle` tokens before the
     code test. Only the addressing comes off, so the property the anchor
     existed for survives — a code inside a sentence still does not redeem,
     because what remains must be nothing but the code. The profile's
     instruction says so now instead of "as the whole message".
   - **Proof.** `features/accounts/server/self-link.test.ts` (4 tests) pins
     both halves: the addressed forms redeem, and `my code is link-…`,
     `@bot link-… thanks` and `link-…@evil` do not. Core `lint`, `typecheck`,
     `test` (1165 + 19). Discord transport typechecks, 16 tests. Not yet
     confirmed live.

8. **A hosted tool leaves a trace** (`done`, 2026-09-04).
   - **Found by running it (user, 2026-09-04):** "why the fuck reaction tool
     (which have to be mcp tool) is not traceable?" Correct, and worse than it
     looked: NOTHING traced an MCP tool call, on either side. The core's turn
     trace ends at the LLM response, and the transports' tools recorded
     nothing at all — so a reaction that silently failed was indistinguishable
     from one that worked, and the transport is the only process that knows
     which it was.
   - **The contract had already anticipated it.** `turnToolMeta.correlationId`
     is documented as "the turn's trace correlation, so a hosted tool's work
     joins the turn" and nothing read it. A trace opened on it lands beside
     the turn's own reply trace in the one Debug explorer, in order.
   - **One trace client per service** (`runtime/trace.ts`, `tracedTool`), built
     once in `startTransportService` and shared by the delivery consumer and
     every hosted tool, so a transport has one way to record anything. Each
     call records what it did — the message ids, the reply target actually
     attached, the emoji, and whether the bot-reaction was recorded — and a
     result carrying `isError` settles as a refusal rather than a success,
     because a tool that told the model "nothing was changed" must not read as
     having worked in Debug.
   - **Two boot bugs the live run exposed**, both invisible until a Discord
     connection existed at cold boot:
     - `ConnectionManager.start` read `identity()` straight after `connect()`,
       but the adapter contract says `connect()` resolves when the platform is
       *started*, not ready — Discord's `login()` resolves before
       `ClientReady`. Discord's `identity()` threw, the throw escaped
       `applyDesiredState`, and the process died instead of settling one
       connection as `error`. Every identity read in the manager now goes
       through `identityOf`, which tolerates "not yet".
     - The status then claimed `running` for a connection that could not send.
       It says `starting` until an identity exists, and the adapter's `status`
       hook flips it.
     - Discord's `identity()` returns null while handshaking, which is what
       its own return type always said.
   - **SDK 3.1.0** — additive on purpose: `traces` is optional on
     `startDeliveryConsumer` (it opens its own when omitted), so `^3.0.0`
     ranges keep resolving and no transport manifest had to change.
   - **Proof.** Core `lint`, `typecheck`, `test` (1161 + 19). Both transports
     typecheck, 35 and 16 tests. Live: both transports rebooted on 3.1.0 and
     report `running` with their identities. Not yet seen live: a tool trace
     itself, which needs the model to call a tool — the delivery consumer uses
     the same client and its `deliver` trace is confirmed, so the plumbing is
     proven and only the tool-side call is not.

7. **The release gate is the registry** (`done`, 2026-09-04 — all three
   repositories).
   - **Problem (user, 2026-09-04):** "checking version is not enough, it have
     to check what released". Correct, and in two directions. A version field
     that changed on a push says nothing about whether anything reached the
     registry: a release that failed half-way left the manifest untouched, so
     the gate saw "no change" and never retried it — only a second bump or a
     manual dispatch would ever fix it. And a version already published was
     silently overwritten with different bytes on a forced run.
   - **The gate now asks the registries.** Each workflow's first job checks
     what is actually released — is this image tag in GHCR
     (`docker buildx imagetools inspect`), is this package version on the npm
     registry (`npm view`), is the git tag on origin — and ships only what is
     missing. The core's job emits the build matrix from that check, so the
     list that decides and the list that builds cannot drift apart. Two
     consequences: the workflows are **self-healing** (any later push to main
     finishes an interrupted release), and the `paths:` filter is **gone**,
     because a fix-up push has to be able to wake the workflow. When nothing
     is pending the first job says so in about half a minute and the rest is
     skipped.
   - **And they check what they released.** Nothing is trusted to have worked
     because a push step exited zero:
     - *Images boot before they are pushed.* Built and **loaded**, not pushed:
       the core runs against a real pgvector Postgres and Redis and must answer
       `/api/health` with `status: "ok"` **and the version being released**
       (it is inlined at build time, so a stale cached build says so here); a
       transport runs against a real Redis and must answer `/health` with a
       transport's own body. A migration generated but never committed, a
       missing runtime dependency or a broken entrypoint fails here with the
       registry untouched — and that is the failure an operator meets first.
     - *Pushed digests are read back.* `:latest` must resolve to the same
       digest as `:<version>`, so a half-moved tag cannot pass.
     - *The published SDK is pulled back out.* Into a scratch project with none
       of this repository: it must import and run, announce the same
       `CONTRACT_MAJOR` the source declares, carry declarations that name no
       private workspace package, and typecheck for a consumer. That is the
       position every transport author is in, and where this package's two real
       failures showed up.
     - *Transport pins are not checked here* (removed 2026-09-08). `verify`
       used to resolve every `image:` pin in compose against the registry,
       which made the core's release wait on a transport's — a dependency in
       the wrong direction, and a deadlock the moment both move together (the
       transport installs the SDK the core's run publishes; run #21 failed
       exactly so). A transport pin is the transport repository's to keep.
   - **A forced dispatch still overwrites an image** (deliberate: it is the
     escape hatch for replacing a bad build) but cannot overwrite an npm
     version, which no registry allows — so a forced SDK run re-verifies and
     re-tags instead of failing red.
   - **Proof.** All three workflows parse with duplicate-key checking. The
     pieces that could be run locally were: `imagetools inspect --format
     '{{.Manifest.Digest}}'` against a real image, the matrix JSON the plan job
     builds, and the SDK's whole published-package verification against the
     real 3.0.0 — which caught a bug in the check itself: `require('<pkg>/
     package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, because the
     package's exports map exposes only `.`, so the manifest is read by path.
     Core `lint`/`typecheck`/`test` (1161 + 19) pass. **Not run: the workflows
     themselves** — they need a push, and the current versions are all already
     released, so the first real exercise will be the Telegram transport's
     1.1.0.
   - **Known state at the time of writing:** `ash-core:1.48.1`, `v1.48.1`,
     `transport-sdk-v3.0.0` and `ash-transport-telegram:1.0.0` are all in the
     registry, so a push to `ash-core` today releases nothing. The Discord
     repository has never released, so its first push runs the whole thing on
     1.0.0 — and the core's compose pin for Telegram stays at 1.0.0 until
     1.1.0 is actually in the registry, since the new pin check would (rightly)
     refuse a compose file naming an image nobody published.

8. **A failed registration says why** (`done`, 2026-09-07 — SDK 3.2.0,
   committed, not yet published).
   - **Problem (user, 2026-09-07):** a transport that could not reach its core
     printed `registration with the core failed (fetch failed) — retrying in
     10s`, once every ten seconds, forever. Every word of it is useless.
     `fetch failed` is the entire message Node's fetch throws for every
     network failure there is, and the reason it actually was — refused,
     unresolved, timed out, TLS — sits one level down in `cause`, which
     nothing read. Nor did the line say which transport, which URL it tried,
     how many attempts had failed, or for how long.
   - **`describeError` (new, `runtime/errors.ts`, exported):** name, message,
     the error code when the message does not already spell it out, every
     entry of an `AggregateError` (fetch tries every address a name resolves
     to, and "IPv6 refused, IPv4 timed out" is a different problem from "both
     refused"), and the whole `cause` chain — depth-capped and safe on a
     chain that points back at itself. It is duck-typed, not `instanceof
     Error`, so a `DOMException` from `AbortSignal.timeout` describes itself
     too. This is now the SDK's **only** way of putting a thrown thing into a
     log: the default `errorText` in `service.ts`, `http.ts` and
     `manager.ts`, the delivery-report log in `send.ts` and the trace field in
     `delivery.ts` all go through it.
   - **Every core call names itself.** `createCoreApi`'s `request` wraps a
     transport failure with the method and the full URL; reads a non-OK body
     as text before JSON (a proxy or gateway answers HTML, and that page beats
     "answered 502" alone) and prefers the core's own
     `{ error: { message } }`; reports a 200 whose body is not JSON as exactly
     that; and says when an answer does not match `CONTRACT_MAJOR` rather than
     dumping a raw zod error. The throw carries **where**, `cause` carries
     **why**, and `describeError` joins them at the point of logging — saying
     the reason in both places printed everything twice.
   - **The retry line** now names the transport, the core URL, the attempt and
     the elapsed time, so "the core is still booting" and "this has been
     failing for an hour" stop looking identical. Before registration is even
     attempted the service logs the two URLs and the contract major, which is
     what a failed registration is nearly always about.
   - **Proof.** Seven new unit tests pin the wording of the shapes that
     actually occur (`transport-sdk` 26 tests, all passing), and the built
     `dist` was driven against a dead port, an unresolvable name, an nginx-ish
     502, a 409 contract refusal and a 200 of HTML — the refused case reads
     `... did not answer <- TypeError: fetch failed <- AggregateError
     (ECONNREFUSED) [connect ECONNREFUSED ::1:3200; connect ECONNREFUSED
     127.0.0.1:3200]`.
   - **Follow-up, blocked on the push:** `telegramErrorText` and
     `discordErrorText` still answer `err.message` for anything that is not a
     platform error of their own, so a Telegram or Discord network failure
     still logs bare. Both become a one-line fall-through to the exported
     `describeError` once 3.2.0 is on the registry and each transport has
     installed it.

12. **The organization is renamed** (`done` locally, 2026-09-08 — waits for
    three pushes, in order).
    - **What changed (user, 2026-09-08):** the GitHub organization is
      `assistants-swarm-hub` (was `assistant-hub-swarm`) and every repository
      is `ash-*` (was `ahw-*`). The user renamed the organization and the
      repositories on GitHub; everything else moved here: the npm scope of
      all eight workspaces, the SDK package name, the GHCR image names, the
      compose variables (`ASH_VERSION`, `ASH_TELEGRAM_VERSION`), the wire
      strings (`assistants-swarm-hub:events`, `assistants-swarm-hub/turn`),
      the `Symbol.for` keys, the trace-bundle schema id, the link-fetch
      user-agent, the dashboard title, the docs, the generated wire contract
      under `docs/api/`, the three checkout folders and their `origin`.
    - **Wire major 4.** The name is on the wire (major 3 exists for exactly
      that reason), so `CONTRACT_MAJOR` is 4, the SDK is **4.0.0**, and a
      transport on the old scope is refused by name. Core is **1.49.0**
      (compose pins `ash-core:1.49.0` and `ash-transport-telegram:1.2.0`);
      the transports are telegram **1.2.0** and discord **1.1.0**, both on
      `^4.0.0`.
    - **GitHub Packages already serves the new scope:** `npm view
      @assistants-swarm-hub/transport-sdk versions` lists 1.0.0–3.2.0 and the
      old scope answers 404, so nothing under the old name installs any more
      — every consumer has to move at once, which is what this item does.
    - **Push order, and why:** (1) core — its release workflow publishes SDK
      4.0.0 and `ghcr.io/assistants-swarm-hub/ash-core:1.49.0`; (2) each
      transport — its verify job installs `^4.0.0` from the registry, which
      does not exist until (1) has run. Until then each transport's
      `package-lock.json` deliberately carries no SDK entry (a lock entry
      needs the published tarball's integrity hash); after the publish, run
      `npm install` in each transport and commit the lock.
    - **Proof.** Core: `npm run lint`, `npm run typecheck` (8/8), `npm run
      test` (106 files, 1165 tests), `npm run build`, `npm run test:integration` (32 files, 423 tests).
      The SDK was built and packed locally and that tarball dropped into each
      transport's `node_modules` (not committed): both typecheck and test
      green (telegram 35, discord 22). The dev server's login page titles
      itself `assistants-swarm-hub`. An old-name sweep over the whole workdir
      (build output excluded) finds nothing but the history note in
      `contract-version.ts`.
    - **Also done:** the compose project was taken down as `ahw-core` and
      brought back as `ash-core` on the same bind mounts; the CodeGraph index
      was rebuilt; the workdir `CLAUDE.md` and the IDE module files follow.
      Trace bundles exported from now on carry the new schema id; nothing
      reads bundles back, so the old exports lose nothing.

13. **The core knows no transport** (`done`, 2026-09-08).
    - **Rule (user, 2026-09-08):** the core must not know or care about any
      transport. Run #21 of the release failed because `verify` asked the
      registry for the Telegram image (removed in item 7's note); the sweep
      that followed found the same knowledge everywhere else: a `tg` service
      in `docker-compose.yml`, grammY in the core's dependencies and a raw
      Telegram `Message` path in bot-messaging that nothing calls since the
      split, "Telegram" in prompts, UI copy, trace reasons and constants,
      `tg`/"Telegram" as the test fixture, and the docs describing the
      deployment as core + Telegram.
    - **Scope:** compose ships the core, Postgres and Redis only (a transport
      is the operator's one added service, per the deployment recipe); no
      transport package, type, id, name or limit anywhere in `core/` or
      `packages/`; tests use a synthetic transport; docs describe transports
      generically and name none. Dated history in this tracker and in
      `docs/PLAN.md`'s phase log stays as written.
    - **Landed (2026-09-08).** Compose runs `app`, `db` and `redis` only; the
      transport service and `ASH_TELEGRAM_VERSION` are gone (an operator adds
      a transport per the deployment recipe, whose example is now placeholders).
      grammY left `core/package.json`; the raw-message branch of
      `handleIncomingMessage` (`checkAddressed` over a platform `Message`,
      dead since the split — the consumer always passes the verdict) and its
      wire-shape helpers are deleted, `IncomingMessage.addressing` is
      required, `BotIdentity` lost its numeric id, and `chatType` is
      `private`/`group`. The legacy `telegram` trigger kind left both trace
      enums (traces on disk are cast, not validated, so old rows still load;
      the dev store held none). Prompts say "chat assistant" / "group chat";
      trace reasons say "the transport marked …"; the settings tab, the
      empty-state copy, the profile hint, the layout description and every
      comment in `core/` and `packages/` are platform-free. Tests use the
      synthetic `acme` transport (`core/test/transports.ts`,
      `core/test/__mocks__/bot.ts` replaces the Telegram mock). Docs:
      `architecture/telegram-pipeline.md` → `message-pipeline.md`, and 40
      other pages describe transports generically; the manual links the
      organization, not a transport. `AGENTS.md` carries the standing
      decision.
    - **Proof.** `npm run lint`, `npm run typecheck` (8/8), `npm run test`
      (core 1165, contracts 20, service 3, SDK 26 after `wire:generate`),
      `npm run test:integration` (32 files, 423 tests), `npm run build`,
      `docker compose config` (three services). A case-insensitive sweep of
      the repository for any transport name finds only this tracker's and
      `docs/PLAN.md`'s dated history, the frozen migration `0015`, and the
      MVP repository's name.

**Landed with the org move (`done`, 2026-09-02):** local `origin` repointed;
the guide, the tracker and the link-fetch user-agent name the new repository;
all workspaces renamed `@assistants-swarm-hub/*` → `@assistants-swarm-hub/*` (157
files, lockfile regenerated by `npm install`); `release.yml` pushes
`ghcr.io/<owner>/ash-core` and `ash-tg` with `GITHUB_TOKEN` (`packages:
write`); `docs/operations/deployment.md` and `docs/PLAN.md` name the GHCR
images. Proof: `npm run typecheck` (8/8), `npm run lint`, `npm run test`
(contracts 16, service 3, tg 44, core 1175). Not run: the release workflow
itself (needs a version bump on main).

**Registry visibility (settled — the packages are public).** Note what "public"
buys on each registry: a public
**container** image pulls anonymously, but the npm registry asks for a token on
every request even for a public package — so a transport author always needs
one with `read:packages`, and the docs say so. **Confirmed empirically**
(2026-09-03, with the SDK published and public): an unauthenticated GET of
`https://npm.pkg.github.com/@assistants-swarm-hub%2ftransport-sdk` answers
`401 {"error":"authentication token not provided"}`. The earlier claim that
the SDK needed no token was wrong; do not reinstate it.

**Supersedes** the "Telegram-only surfaces in the core" entry under Other
open items (its list is phase 1's checklist; prune it when phase 1 lands).

## A name in the text is not who the message is for (`todo` — improvement, 2026-08-27)

The deterministic name check answers "does this text contain the assistant's
display name", and the turn treats that as "this message is for me". Those are
different questions, and in a chat holding more than one assistant the
difference shows.

**Live evidence (two-bot group, 2026-08-27).** One human message named both
assistants and asked one of them to do something *about* the other — the shape
of "Ada, ask Grace about her day". Both assistants opened a turn and both
answered: Grace's verdict was `source: "name"`, `matchedText: "Grace"`, matched
on the word that was the *object* of the request, not its addressee. Her own
reply said so:

> I'm not sure if you're asking me to ask myself or if you want Ada to do it,
> but if it's up to me: …

The model spotted an addressing error the regex cannot, because
`matchBotName` sees presence, never direction. Same mechanism produces the
other misses of this family: "tell Ada I said hi" (a third party is asked to
relay), "Ada already answered that" (the name is the subject of a remark),
"unlike Ada, I think…" (a comparison).

**Why it is not simply a bug.** The check is the v1 rule and it is right far
more often than it is wrong — a name spoken in a group usually IS a summons.
It also costs nothing, and it is the reason a summons is never missed to a
provider failure. The failure is confined to messages that mention an
assistant without addressing it, which in a single-assistant chat is rare and
in a multi-assistant chat is routine.

**Decision (user, 2026-08-27): keep the short-circuit.** Asked whether the
name question should go to the analyzer instead, the answer was no — surface
the behaviour rather than change it. Shipped that day (`1bdfbbf`): a
deterministic verdict now carries a note in the Debug timeline naming what
decided and stating that there is no analyzer request/response to read, so the
decision is legible even though it is regex-made. **This entry is the
improvement that was deliberately not taken**, kept because the failure mode
is real and multi-assistant chats make it common.

If it is taken later, the shape is known:

- Keep every **structural** verdict as-is (`private`, `reply`, `mention`,
  `command`). Those are facts Telegram hands us — a reply target, a message
  entity — not readings of prose, and they carry no direction ambiguity.
- Route only the **name** question to the analyzer, which already answers a
  harder version of it (which word is the display name, in what spelling) and
  would gain the easier one (is the message directed at that name).
- Cost is small and well aimed: the analyzer already runs on every other
  undecided group message, so this adds calls **only** for messages that
  contain the name literally — the exact set where the decision matters.
- Watch the failure direction. The name check fails closed today only in the
  sense that it over-answers; an analyzer that mis-reads direction would
  under-answer, and a missed summons is the more expensive error (see the
  reverted pre-filter, 2026-07-20). Any move here wants the enum + citation +
  verifier discipline the existing analyzer already has, not a looser prompt.

Acceptance criteria, if picked up:

- A message naming an assistant as the object of a request ("Ada, ask Grace
  about her day") opens a turn for the addressee only.
- A message naming an assistant as the addressee still answers, with a verdict
  carrying the analyzer exchange behind it.
- Both live shapes above are pinned by tests over recorded messages, not by a
  new lexical rule anywhere in code.
- The Debug note keeps working: a verdict with no exchange still says why.

Dependencies: none. Related: the loop guard bounds how far a mis-addressed
bot-to-bot exchange can run, so this is a quality problem, not a runaway one.

## The served model leaks its deliberation (`todo` — guarded, model unchanged, 2026-08-24)

The chat model in the operator's dev setup
(`Huihui-gemma-4-26B-A4B-it-abliterated` UD-Q4_K_M on llama.cpp b10588) stops
using its thought channel at production prompt scale and writes its working-out
as the answer. Probed directly against the endpoint, replaying the exact request
behind trace `3491c387`, 8–10 samples per condition:

| condition | leaked |
| --- | --- |
| what the app sends (no reasoning param) | 6/8 … 10/10 |
| `temperature: 0.2` | 8/8 |
| `chat_template_kwargs: {enable_thinking: true}` | 7/8 |
| `chat_template_kwargs: {enable_thinking: false}` | 0/8 |

`reasoning_content` was empty in every one of those calls — the channel is never
opened, so llama.cpp has nothing to strip. Ruled out by measurement: the server's
parser (a *short* prompt to the same model/server channels correctly), truncation
(a cut-off thought returns the reasoning field set and content empty, never raw
CoT), the 17 tool definitions (reproduces without them), and sampling temperature
(lower is worse). Tool calling is unaffected either way (4/4 `tasks_create`).

**Guarded, not fixed** (`d5e548b`, reply integrity, see
[bot-messaging.md](features/bot-messaging.md#reply-integrity--deliberation-is-not-an-answer)):
the turn detects the leak mechanically and retries, which recovered 10/10 live.
The cost is a wasted generation — up to ~40s when the leak runs to the token cap.

**Open, needs the operator**: this is a model/template defect, and the honest fix
is serving a model whose thought channel llama.cpp can parse at this prompt size.
Turning thinking off for replies is **rejected** (user decision, 2026-08-24) — it
is the one thing measured to stop the leak outright, and it is not on the table.
Re-run the probe against any replacement model before trusting it.

## Collections: an assistant's structured data (`todo` — spec agreed 2026-09-08)

Supersedes the 2026-08-19 "Collections feature" spec (`deferred`), which is
dropped as a whole (user decision, 2026-09-08 — see "What changed" below;
the old text is in git history). Not started. Two generic upgrades it
depends on are tracked as their own entries right after this one:
"Documents: a text-like media kind" and "`start_agent`: a background copy
of the assistant".

### The scenario (user, 2026-09-08)

1. Create a dedicated assistant — the example is a movie assistant.
2. Export a watchlist from a site (the example: an IMDb export, a CSV of
   ~18 columns — title, year, genres, directors, the site's rating, the
   user's own rating, URL …), send the file to the assistant in chat, and
   ask it to store it.
3. Ask it to fill what the file lacks (description, cast, …). It works in
   the background and reports when done.
4. From then on, a standing instruction: whenever the owner sends a link of
   that kind, add it to the collection, look it up, present it the usual
   way, and ask for the owner's rating.

### What changed against the 2026-08-19 spec

| 2026-08-19 | 2026-09-08 |
| --- | --- |
| Per DM user, DM-only | Per **assistant**; visibility per collection |
| Link kinds detected in the pipeline, per-source adapters in core | No detection, no adapters: the assistant's own tools and a per-collection instruction |
| Created by an interview at the first item of a kind | Created from a **bulk import** (one confirmation) or on request |
| Rules per collection, enforced by the create tool's schema | The standing rule is a **Task**; the collection holds two instructions (fill gaps, present) |
| Rating via a new inline-buttons subsystem | Rating asked in plain text, applied in the next turn |
| Item update tracking via tasks | **Dropped entirely** |
| Fixed item shape plus an attributes blob | **Typed columns** the model proposes and code enforces |

### Decisions (user, 2026-09-08)

1. **Primitive: structured collections.** An assistant owns collections;
   each has typed columns proposed by the model from the data and enforced
   by code. Domain-agnostic — movies, books, recipes, expenses are the same
   feature. No template library, no schema-less rows.
2. **Scope: per assistant; owner rights write.** A collection belongs to
   one assistant (cascade). Writes need owner rights on that assistant
   (`sender.isOwner`, or `authorityIsOwner` lent by a Task — the usual
   rule). Dashboard access follows assistant ownership (a user-role account
   sees its own assistants' collections).
3. **Visibility flag per collection, private by default.** Private: only
   owner-rights senders see it in the prompt block and through the tools.
   Shared: anyone in a chat with the assistant may read and query; writes
   stay owner-only. The gate lives in the service, not in the prompt.
4. **File ingest: a `document` media kind on the transport contract** (own
   entry below). A dashboard import button is not part of v1.
5. **Enrichment data: the per-collection fill-gaps instruction picks the
   tools.** The assistant uses what it has — a background agent with the
   browser tools (`start_agent`, own entry below), or any lookup server
   the operator connects as a tool connection. No source adapters in core;
   the domain lives in the instruction.
6. **The bulk job is a Task, not a new worker.** (The AGENTS.md ask for a
   new long-running worker was put and declined.) "Fill the gaps" makes
   the assistant create an interval task in the chat; every fire starts
   one quiet background agent (`start_agent`) whose goal is the batch
   ("query rows with gaps, look each up, update them"). The agent does the
   work with the assistant's full toolset (own entry below). The agent
   runner executes one run at a time, so a later run simply re-queries and
   continues — no overlap, no pending markers.
7. **Loop end: code reports the gaps, the model ends the task.** The prompt
   block carries "rows with gaps" per collection, so a fire that sees zero
   sends the one completion message (`send_message`) and deletes its own
   task; a fire that sees gaps starts an agent and stays quiet. Progress on
   the dashboard is complete/total, live.
8. **The standing rule is a Task; the rating is asked in plain text.**
   "Whenever I send a link of this kind: add it, look it up, present it as
   usual, ask my rating" is a prompt-kind Task of the assistant — `on-reply`
   in a DM (every DM message is addressed, no matcher needed), `message`
   trigger in a group. The rating answer arrives in a later turn and the
   model applies it with the row-update tool, history as context. No
   buttons subsystem, no per-collection "on add" policy.
9. **Prompt: a compact block, tools offered per assistant.** A block like
   the standing-tasks block lists each visible collection (name,
   description, columns with types and the required set, row count, rows
   with gaps, presentation instruction). Rows are reached through tools.
   The collection tools are offered only to assistants that have at least
   one collection (derived detail: `collections_create` is always offered,
   or the first one could never be made). This is variance **per assistant
   by data presence**, stable for the whole conversation — not routing by
   message content, so the 2026-08-19 "no toolset routing" decision
   stands; refine its AGENTS.md wording when this lands.
10. **Dashboard: `/collections`** with the assistant as a URL facet; per
    collection the shared Tabs: Rows, Columns, Instructions, Activity.
11. **Presentation: per-collection free text; images by URL.** An `image`
    column holds a URL the assistant sends as a link the platform previews.
    No image bytes in the core.
12. **Import flow: one confirmation.** The model proposes the name, the
    typed columns (with the key column and the "needed for complete" set)
    and the file-to-column mapping, asks once, then imports in one call and
    reports inserted / updated / skipped rows with reasons.
13. **Search: structured query plus semantic search.** Column filters,
    sort, text match, paging and a gaps-only flag; and an embedding of a
    text rendering of each row when an embedding model is configured (the
    memory feature's client), re-embedded on every write, degrading to
    structured-only without a model.
14. **Tracking is dropped entirely** — not built, not kept as a later idea.
15. **No hand-off mechanism.** "How does web-found data get into a row" is
    answered by the background agent holding the tools (own entry), not by
    continuation turns or a synchronous research tool.

### Proposed architecture (to implement; details are the implementer's)

- **Tables.** `collections`: `id`, `assistant_id` (NOT NULL → assistants,
  cascade), `name` (unique per assistant, case-insensitive, in the
  service), `description`, `visibility` (`private` | `shared`),
  `fill_instruction`, `presentation_instruction`, `columns` JSONB
  (`[{ key, label, type, options?, scale?, isKey, requiredForComplete }]`),
  timestamps. `collection_rows`: `id`, `collection_id` (cascade),
  `key_value` (unique per collection), `values` JSONB, `complete` boolean
  (computed by code on every write: every `requiredForComplete` column
  non-empty), `created_by_user_ref`, `origin_chat_ref`,
  `source_document_ref` (the import's document, or null), `embedding
  vector(1024)` nullable with an HNSW cosine index, timestamps. Column
  types: `text`, `long_text`, `number`, `date`, `url`, `image` (a URL),
  `list`, `enum` (with options), `rating` (a number with a scale),
  `boolean`. Values are validated per type on every write; an invalid
  value is refused with the column named, never coerced silently.
- **Key column and dedupe.** Exactly one `isKey` column (the site's id or
  the URL); a write with an existing key updates the row. The model fills
  the key from what it sees (an id inside a URL is a mechanical fact it
  may extract); code only enforces uniqueness.
- **Import.** `collection_import` takes a document ref plus either an
  existing collection id or the confirmed proposal (name, columns,
  mapping). Code parses CSV / TSV / JSON / XLSX by the mapping, validates
  per type, upserts by key, and answers counts with per-row skip reasons.
  The trace records the mapping, the counts and the skipped rows in full;
  the raw file is in the media store.
- **Tools** (in-process registry; feature ids `collections` and
  `mcp-tools-collections`): `collections_create`, `collections_update`
  (name, description, visibility, instructions, columns — add, rename,
  retype, remove), `collections_delete`, `collection_import`, `rows_add`,
  `rows_update`, `rows_delete`, `rows_get`, `rows_query` (filters, sort,
  text match, semantic query, gaps flag, paging; a page is capped). No
  `collections_list` — the block. Every tool self-describes; none names
  another tool. Visibility and owner-rights gates are in the service and
  answer denials, never throw.
- **Prompt block.** `buildCollectionsBlock(assistantId, senderHasOwnerRights)`
  composed next to the standing-tasks block, in reply turns and in fires (a
  fire is how the loop sees the gap count). Private collections are
  omitted for non-owner senders.
- **Dashboard.** `/collections`: assistant facet in the URL; per
  collection the Rows tab (typed table, per-column filters as URL
  controls, sort, inline edit, delete, JSON and CSV export), Columns
  (schema editor with the same validation as the tools), Instructions,
  Activity (imports and mutations). Live on a `collections` SSE topic;
  `featureDebugHref`; a Debug button per collection
  (`/debug?relatedId=<collectionId>`).
- **Tracing.** `collections`: create / update / delete / import and every
  dashboard row mutation; `mcp-tools-collections`: every tool call; full
  raw bodies throughout; a chat-side mutation stamps the turn's
  correlation (`toolContextTrigger`).
- **Limits (proposed constants).** 16 collections per assistant, 64
  columns, 50 000 rows per collection, 50 rows per query page.

### The three flows, end to end

1. **Import.** The file arrives as a `document` (kept). The model reads the
   header and a sample through the document read tool, proposes, the owner
   confirms once, `collection_import` runs, the reply reports the counts.
2. **Fill the gaps.** The owner asks; the assistant creates an interval
   task (every 15 minutes, say) in the chat. Each fire reads the block:
   gaps left → `start_agent({ goal: <batch>, quiet: true })` and no
   message; zero → one `send_message` and `tasks_delete` of its own task.
   Each agent run: `rows_query({ gaps: true, limit: N })`, per row browse
   and read, then `rows_update`. A quiet run posts its final report only
   when its goal failed; progress notes, if the agent sends any, go out
   silent.
3. **A link under the standing rule.** The owner sends a link; the
   `on-reply` Task tells the turn what to do: `rows_add` with the key and
   whatever is known, then `start_agent` with the goal "open the link, fill
   row <id>, then present the item per the presentation instruction and
   ask for a rating". The turn acknowledges; the run's final report is the
   card plus the question; the owner's "8" is applied by an ordinary turn
   via `rows_update`. In a group the same runs from a `message` Task.

### Acceptance criteria (v1)

- A text-like document sent in a chat is stored, readable through the read
  tool, and importable; the proposal is confirmed once; a second import of
  the same file updates by key and reports zero inserts.
- A fill-gaps request becomes a Task; runs fill rows without a message per
  row; the completion message arrives exactly once and the task is gone;
  complete/total is live on the dashboard while it runs.
- A link sent under the standing rule ends with a formatted card and a
  rating question; the answer lands on the row.
- A private collection is absent from the block and refused by the tools
  for a non-owner sender; a shared one is readable; writes are owner-only
  in both.
- `/collections` meets the feature contract: tabs, URL filters, live
  updates, export, debug link, full raw bodies in traces.
- Tests: service (per-type validation, key dedupe, completeness, visibility
  and owner gates, limits), import parsers (pinned fixtures per format),
  query (filters, paging, semantic degrade without a model), tools (the
  boundary and the offer rule), Route Handlers, the block, the fire prompt
  carrying the gap count; live suites gated as elsewhere.

### Suggested order

1. The `document` media kind (own entry) — contract, SDK release, the
   transports' normalizers, core ingest, the read tool.
2. `start_agent` replacing `browse_web` (own entry).
3. Collections: schema, service, tools, block, import.
4. `/collections`.
5. The fill-gaps loop and the link flow live, in the dev setup.

### Risks

- Throughput: the agent runner is sequential and a run takes minutes, so a
  500-row watchlist takes many hours; a parallelism knob on the runner is
  the later answer, not part of v1.
- The agent role's model holds a far larger toolset than the browser agent
  did; the operator picks a model that copes (settings, agent role).

## Documents: a text-like media kind on the transport contract (`todo`, 2026-09-08)

Prerequisite of the collections entry, useful on its own: a document sent in
a chat is dropped today — the media detection forwards photos, image
documents, video and voice only, and the web chat's `file` kind is outbound.

Decisions (user, 2026-09-08): text-like formats — CSV, TSV, JSON, XLSX,
TXT, MD — under a size cap; bytes **kept** in the core (unlike images,
whose bytes drop after describing); a general read tool so any document
sent in a chat can be read in a turn, and the import tool takes the
document ref. PDF later. Import-only was declined.

Proposed shape (verify against the contract's rules):

- `transportMediaSchema.kind` gains `document`; the payload travels as one
  base64 blob (like voice) plus a new `filename`. Additive, so a minor SDK
  release, not a `CONTRACT_MAJOR` move — confirm against the compatibility
  rule in `docs/development/adding-a-transport.md` before publishing.
- The transport decides what it forwards (mime or extension in the
  text-like set) and downloads the bytes; the size cap is a core setting
  for storage, not a platform limit.
- Core ingest stores the row as `source_media` kind `document` with bytes
  retained; the transcript line reads `[document: <filename>, <size>]`;
  the web chat's upload route takes the same path (unify with its `file`
  kind).
- `read_document`: a document ref plus a window (rows for tabular formats,
  characters for text), answering the slice with totals so the model
  pages. Self-describing, names no other tool.
- The media gallery lists documents with a download.
- Tests: contract schema, ingest, the read tool's slicing per format, and
  each transport's normalizer in its own repository.

## `start_agent`: a background copy of the assistant (`todo`, 2026-09-08)

Replaces `browse_web` (user decision, 2026-09-08, reworking the first
version of this entry, which had overloaded `browse_web` with the
assistant's toolset). Today `browse_web` inserts a run and the runner
starts a second, browser-only model loop: its own "web-browsing agent"
prompt, the browser role's model, the static browser tool list, no turn
context, no persona, and a text report the runner posts. Such a run can
read a page but cannot record anything anywhere.

Decisions (user, 2026-09-08):

- **One explicit background tool, `start_agent`, replaces `browse_web`.**
  Input: `goal` (self-contained), optional `context` (facts gathered from
  the conversation, like a Task's), optional `quiet`. Output: an
  acknowledgement with the run id. The description inherits everything
  `browse_web`'s earned in production — the must-call cases (a shared link,
  a lookup, a download, a live value, a multi-step job), "keep the request
  intact, add no weaker branch", the do-not for casual chat and stable
  facts — and adds the new must-call: any job that has to act through
  tools (record, remember, schedule, update a collection) or would take
  many steps or minutes. Nothing aliases the old name.
- **The agent is the assistant.** The run row carries the full turn binding
  (source, chat, thread, assistant, sender, owner rights, correlation) and
  the runner wraps the loop in `runWithToolContext` with `deliveryKind:
  "send"`. Toolset = the browser tools + `getToolset({ delivery: "send" })`
  for that assistant, minus `start_agent` (no nesting). Persona composed
  into the agent prompt; the browser rules (navigate first when given a
  URL, refs from the latest page state, the download and no-substitute
  rules) stay as directives.
- **It may speak mid-run, silently.** The agent holds the chat's
  `send_message`; every message it sends during the run goes out
  **silent** — no notification ping, mirrored into history, kept (these
  are progress notes, not acknowledgements, so the settle does not delete
  them). The runner still posts the **final report** with a ping, combined
  with staged files as today; `quiet: true` posts the final report only
  when the outcome check says the goal failed (batches started from
  fires). The silent flag rides the tool call's `_meta` turn binding so
  the transports' delivery tools honour it — an additive contract field, a
  minor SDK release.
- **The browser role becomes the agent role** in Settings
  (`agent_backend_id`, `agent_model`; chat model by default) — one role for
  background agents.
- **Goal plus context, no transcript.** A run sees what the caller wrote,
  plus the triggering message's URLs appended verbatim by code, as today.

Consequences (to implement):

- `browser_agent_runs` → `agent_runs` (+ `context`, `quiet`, the turn
  binding columns); the runner keeps its operating model — queue = table,
  one run at a time, advisory lock, crash sweep, the transient "on it"
  acknowledgement deleted on settle, staged files delivered with the
  report.
- `/browser-agent` → `/agents`: the runs list shows the assistant and the
  chat; "start a run" from the dashboard picks an assistant. A
  dashboard-started run has no chat: chat-bound tools (delivery, tasks)
  answer "no chat", and the report stays on the run row.
- Feature id `browser-agent` → `agents` for the runs and the runner; the
  tool-call trace id follows. Old traces keep their id; the Debug facet
  lists both.
- A restricted run (rule-driven in a group, or rights lent to a non-owner)
  keeps the URL fence for downloads; every other tool gates on the bound
  owner flags exactly as in a turn.
- The reply toolset changes once (`browse_web` out, `start_agent` in); the
  agent's toolset is stable per assistant.
- Tests: the description pinned (the must-call cases), toolset composition
  inside a run (no `start_agent`, `send_message` present, browser tools
  present), the context binding, the persona composed, silent mid-run
  sends and the pinged final report, quiet both ways, restricted gates, a
  dashboard run without a chat, and the live suite with a goal that records
  through a tool.

## The honesty gate cannot judge a retrospective turn (`todo` — observing, 2026-08-15)

Operator trace `0e0a924f…` (`bot-messaging` / `reply`, 2026-08-14 21:37Z). The
user asked *"what do you mean?"* about the bot's previous message, the bot
explained what that message had been, and the gate read the explanation as a
fresh claim — retried, got the same explanation, suppressed it, and answered a
clarifying question with the ⚠️ system notice. 53 seconds, two generations, no
answer.

Why it cannot come out otherwise as written:

1. The gate sees only `request` + `reply` (`buildActionClaimMessages`), never the
   conversation. Its own exemption — *"describes what someone ELSE did, or what
   happened earlier in the conversation"* — is therefore unreachable: a
   first-person past-tense recap is indistinguishable from a fresh claim, and the
   `someone ELSE` clause anchors the bullet to third parties.
2. `ACTION_CLAIM_ENFORCEMENT_DIRECTIVE` offers two options that both fail on this
   shape. There is no tool to call (the "action" is a message already written),
   and "say plainly you did not do it" contradicts what the bot did write. The
   second strike is guaranteed.

Not entirely a false positive: the claim (*"marked it as complete"*) was itself
confabulated about the previous turn, which only wrote `👍 Done.` to a `hello`.
That earlier turn is the deeper bug and is in a different trace.

**Half shipped 2026-08-24 (`b8ebf18`)**, after the same shape recurred live
(trace `10e34de6…`: the bot said *"I've already told you"* — true, and visible in
the window — and the gate suppressed it as a performed action). Point 1 is
closed: `ActionClaimInput` carries the turn's own conversation window and the
rules name speech about one's earlier messages (*told, said, answered,
explained*) as never an action.

**Still open — point 2.** `ACTION_CLAIM_ENFORCEMENT_DIRECTIVE` still offers two
options that both fail on a retrospective turn: there is no tool to call, and
"say plainly you did not do it" contradicts what the bot did write. If the gate
misfires on such a turn again, the second strike is still guaranteed.

## Voice: why transcription is failing in production (`blocked`, 2026-08-14)

Reported by the operator, 2026-08-14: voice messages come back with no
transcript. Two distinct symptoms on prod (`/api/health` reports **1.40.0**):

1. Media cards reading "Transcribed" with `(no speech)` and no content
   (~12:29–12:30 GMT+3).
2. `voice`/`transcribe` traces ending in `error` at **0 ms / 2 ms / 14 ms**, on
   three consecutive message ids in the same second (13:06:03 GMT+3) — the
   vision backfill working a batch.

Symptom 1 is **fixed** (next section): an empty answer was being stored as a
terminal `(no speech)`. Symptom 2 is the underlying failure and is still
**unknown** — sub-15 ms means the transcribe threw *before the wire*, so it is
configuration or a local process, not the endpoint. Candidates, in order:

- `toWavForTranscription` (`features/vision/server/service.ts`) — an ffmpeg
  spawn/transcode failure. ENOENT fails in single-digit ms, which fits best.
- `createOpenAiClient` (`server/llm/client.ts`) refusing an `anthropic` audio
  role in `transcriptions` mode — an instant, named `ApiError`.

**Blocker:** no authenticated access to `/debug`. The Browser pane blocks every
`/_next/static/*` asset with `net::ERR_BLOCKED_BY_CLIENT` (the `/login`
document itself is 200), so the page never hydrates and the sign-in form is
inert; the Claude-in-Chrome extension is not connected either. `/api/health` is
public and was the only reachable signal.

**Next decision needed:** the operator pastes the error message and event list
from one 13:06 `transcribe` trace (or its JSON bundle). That one string
separates ffmpeg-missing from a backend refusal — they read nothing alike.
Note that symptom 1's fix converts these into *more* such traces rather than
fewer: failures that were previously laundered into `(no speech)` now surface
as errors, which is the point.

## Backend normalization layer (`in-progress`, 2026-08-07)

User decision, 2026-08-07: "bot breaks every time I switch backend… implement an
adaptation/normalization layer per backend instead of layers of fixes every
time." Step zero, ahead of the reply-latency work below.

Decisions taken with the user before implementing:

- **Scope**: all five endpoints get their own backend selector (LLM, embedding,
  image, speech, transcription) — they can genuinely be different servers.
- **Tool loop**: `runToolLoop` stays hand-rolled; the AI SDK is transport only.
  The SDK's agent has no stall guard, no `compact()`, no forced tools-free final
  round, and no per-round usage reporting — and Analytics groups on the round.
- **Backends**: Ollama, llama.cpp, vLLM, and a generic OpenAI-compatible
  fallback (the default, and what every pre-existing settings row resolves to).
- **Detection**: manual dropdown plus a Detect button that fingerprints the
  endpoint. Never automatic — a silent change is the bug class this prevents.
- **Speech/transcription**: keep the `openai` SDK internally.
  `@ai-sdk/openai-compatible` supports chat, completion, embedding and image
  models only — it has no transcription or speech model type.
- **Cutover**: adapter layer first with no behavior change, then the latency
  work as a separate change, so a regression has one candidate cause.

Confirmed breakages the layer must pin (user, 2026-08-07): thinking/reasoning
control, context-overflow error shape, served-model-id normalization. Tool-call
dialect was explicitly *not* one of them — **until 2026-08-08**, when a live turn
emitted its tool call inside the reasoning channel and the round came back empty
(see "the tool call went into the reasoning channel" below). Handled generically
in the tool loop for now; if it recurs it belongs here, in the Ollama adapter.

### Done so far

- `lib/llm-backend.ts` — client-safe ids/labels/coercion.
- `server/llm/backends/` — adapter interface, four adapters, registry, endpoint
  fingerprinting. Pure: no fetch, no SDK, so every quirk is testable without a
  server.
- `db/schema.ts` + `db/migrations/0047_bouncy_ink.sql` — five backend columns,
  `NOT NULL DEFAULT 'openai-compatible'` so existing rows keep current behavior.
- Settings zod schemas, repository, service, and `LlmConnection` carry the
  backend. It follows the **host**, like the API key: an endpoint that falls
  back to the LLM connection inherits its backend too.
- `server/llm/backends/backends.test.ts` — 17 tests.

Proof: `npm run lint` clean, `npm run typecheck` clean, `npm run test`
1002 passed / 21 failed — the same 21 fail on a stashed clean tree
(`ytdlp-binary`, `media-download`; environment-dependent, unrelated).

**Migration not applied locally** — no Postgres reachable at the configured
`DATABASE_URL`. It is generated and committed; apply on deploy with
`npm run db:migrate`.

### How the vendor fields reach the wire

`providerOptions[<provider name>]` is the seam, exactly as the provider's docs
describe. The typed options schema
(`{user, reasoningEffort, textVerbosity, strictJsonSchema}`) is `$strip`, which
reads like it would discard everything else — it does not. The model spreads the
raw `providerOptions` entry into the request body and filters out **only** those
four known keys (`@ai-sdk/openai-compatible/dist/index.js`, the
`Object.fromEntries(...)` spread in `getArgs`). Every other key — `think`,
`chat_template_kwargs`, `reasoning_format` — is passed straight through.

So an adapter's `chatBodyExtras()` maps onto `providerOptions` directly and no
`fetch` shim is needed. Two consequences for the adapters:

- Genuine vendor fields use their **wire spelling** (`think`,
  `chat_template_kwargs`, `reasoning_format`) and pass through untouched.
- `reasoningEffort` is the exception and must use the **camelCase typed name**.
  The model writes `reasoning_effort` into the body *after* the passthrough
  spread, so a snake-case `reasoning_effort` is overwritten by the unset typed
  option and never reaches the endpoint. Found by the end-to-end test, not by
  reading the code.

`server/llm/transport.ts` is the single wire, and `server/llm/transport.test.ts`
pins the passthrough against the real provider with a stub `fetch` — asserting
the behavior rather than the declaration, because reading the declaration got it
wrong once.

The conversation stays in OpenAI's message shape and is converted once at the
transport boundary. `./tool-loop` owns the conversation and appends assistant
turns to it verbatim across rounds, so that shape is a stable internal DTO;
converting at the edge leaves the loop, the browser agent, and the MCP tool
bridge untouched by the transport swap.

`chatCompletion` and the tool loop's round factory both run on the transport.
Migration `0047` is applied to the dev DB and the existing row backfilled to
`openai-compatible`.

Behavior is deliberately unchanged until an operator names a backend: the
classifiers still pass `reasoning: "low"`, which on the generic adapter produces
the identical `reasoning_effort: "low"` body they always sent, and the reply path
passes no reasoning preference at all.

Two things improved for free by moving off the OpenAI SDK:

- **Error bodies survive.** `APICallError` keeps `responseBody`, where the OpenAI
  SDK discarded any JSON error body that was not its own `{error:{}}` shape —
  the "500 status code (no body)" problem `fetchWithErrorDetail` exists to work
  around. `isContextOverflowError` and `toLlmError` now read it.
- **`isContextOverflowError` takes the backend**, so an adapter's phrasings are
  tried after the shared concept matcher.

### Measured against the live Ollama (0.32.6, 12B thinking model)

One classifier prompt, identical verdict every time:

| body                       | completion tokens | latency |
| -------------------------- | ----------------- | ------- |
| (nothing)                  | 135               | 2269 ms |
| `reasoning_effort: "low"`  | 94                | 1784 ms |
| `reasoning_effort: "none"` | **17**            | **802 ms** |

So `"low"` — what the bot has been sending all along — is **not** a weaker
"off". It still thinks. `"none"` is the switch, and it is now what the Ollama
adapter emits for `reasoning: "off"`.

Also measured, and why the adapter does *not* send `think`: Ollama's native flag
works on `/api/chat` (17 tokens, 816 ms, no thinking) but the OpenAI-compatible
`/v1/chat/completions` route this app speaks **ignores it** — 128 completion
tokens with it and without. `chat_template_kwargs: {thinking:false}` and
`options: {think:false}` were also tried on `/v1` and did not disable it.

llama.cpp mappings remain **documented, not measured** — no live instance. Its
tests assert the body produced, not a server's answer. vLLM was measured live on
2026-08-12 — see "vLLM measured live" below: the mapping is right, the
deployment is not.

### Settings UI

`features/settings/ui/BackendField.tsx` — one dropdown + Detect control, used by
the LLM section in `SettingsForm` and by all four optional sections through
`ConnectionSection`. A section reusing the LLM connection shows no control: it
inherits that endpoint's backend at read time, so persisting one would be a
second, silently-ignored source of truth.

`POST /api/settings/detect-backend` fingerprints an endpoint. Ollama's
`/api/version` is tried before vLLM's bare `/version` — both answer `{version}`,
and the reverse order would let a generic body claim an Ollama host.

Verified in the browser against the live endpoint: the control renders in the
Core tab, Detect returned "Detected Ollama 0.32.6" and set the dropdown, and
saving persisted `llm_backend = 'ollama'` while leaving the four inheriting
sections untouched.

### Two bugs the live check caught that nothing mocked could

1. **System turns were rejected outright.** The AI SDK refuses `system` messages
   inside `messages` unless `allowSystemInMessages` is set, steering callers to
   its single `instructions` field. That does not fit this app — the reply prompt
   places system turns *between* other turns deliberately (time context after the
   history window, language directive last, at maximum recency). Left unset,
   **every reply would have failed on deploy** with `AI_InvalidPromptError`. Now
   pinned by a test that asserts the sent role order.
2. **The backend never reached the wire.** Ten call sites built their connection
   as `{ baseUrl, apiKey }`, dropping `backend`, so `adapterFor` fell back to the
   generic adapter and the operator's choice did nothing. Fixed at every site.
   The footgun remains: a bare object literal silently loses the field. Worth
   making the runtime itself an `LlmConnection` that callers spread.

### Measured through the app's own code path, live

Same classifier prompt, identical verdict, only the stored backend differing:

| `llm_backend`        | completion tokens | latency | reasoning |
| -------------------- | ----------------- | ------- | --------- |
| `openai-compatible`  | 149               | 2519 ms | 431 chars |
| `ollama`             | **17**            | **683 ms** | **0**  |

### Embeddings and images

Both run on the AI SDK provider now, through the shared `server/llm/provider.ts`
factory that chat also uses — it exists so the three cannot drift on the two
things easy to get subtly wrong: base URL normalization and the
`providerOptions` key. Chat briefly had its own copy that skipped the URL
normalization, which worked only because the stored setting already ended in
`/v1`; an operator entering `http://host:11434` would have hit the wrong path.

Verified live against `bge-m3:latest`: probe reports 1024 dimensions, and a
3-input batch keeps one vector per input **in order** — vector 1 has similarity
1.0 against the same text embedded alone, versus 0.45 cross. That check exists
because `embedMany` pairs vectors to inputs *positionally*: the provider maps
`response.data` straight across and discards each entry's `index`, which the old
code placed by. An arity check now stands in for that guard — a short or padded
response fails loudly instead of misaligning every vector after the gap.

Images are unverified: `image_model` is `docker.io/ai/stable-diffusion:Q4`, which
the configured endpoint does not serve (a Docker Model Runner leftover), and
Ollama has no `/v1/images/generations` at all. The port typechecks and the code
path is the same one embeddings proved; the endpoint is what is missing.

The `openai` package stays for speech, transcription, and `listModels` — the
first two have no model type in `@ai-sdk/openai-compatible`, and the provider
exposes no model listing.

Also fixed while here: a fired deadline now names the endpoint. The AI SDK paths
bound themselves with `AbortSignal`, which throws a bare `TimeoutError` whose
message ("The operation was aborted due to timeout") names neither the host nor
the attempt — useless in a trace read months later.

### Remaining

- Nothing outstanding on the normalization layer itself.
- Watch the first production reply traces after deploy: `addressing-check` and
  `chat-rule-match` should drop from ~135 completion tokens to ~17, and the
  `reasoning` field on their responses should be gone.

### Reply calls keep thinking (user decision, 2026-08-07 — do not retry)

Turning reasoning off on the **reply** path was measured against the live
endpoint and **rejected**. It is not a latency trade, it is a correctness
regression, and the second failure below is the one this bot already has a gate
for.

Three runs each, gemma4:12b, live:

*"split a 2400 bill between 5, two ate half"* — correct answer $600 / $300:

| reasoning | result |
| --------- | ------ |
| on        | **3/3 correct** |
| off       | **0/3 correct** — $480/$240, a garbled half-answer, $533.33/$266.67 |

*"did she push it yet?"* over history where only Bea can know — the bot should
ask her or say it does not know:

| reasoning | result |
| --------- | ------ |
| on        | 3/3 fine: *"@Bea, have you pushed the changes?"* / *"She hasn't mentioned if she pushed it yet."* |
| off       | 3/3 **fabricated**: *"Not yet, still checking the logs."* / *"Not yet. Checking now."* |

That last one asserts a fact it cannot know *and* an action it is not
performing — exactly what `runActionClaimGate` exists to catch. So it is also
**slower**, not faster: those replies trip the gate, which forces a regeneration
plus a re-check. Two extra calls to save 800 ms.

Tool *selection* alone survives reasoning-off (3/3 correct tool, 772 ms vs
4704 ms), but it cannot be isolated: `runToolLoop` only learns a round was the
final answer when it comes back with no tool calls, and that same call is the
one that wrote the reply.

### gemma4:26b benchmarked and rejected (2026-08-07 — do not retry)

The dashboard's Model performance card shows `gemma4:26b` at **2.3x the
tokens/sec of 12b**, which read as free speed. A controlled benchmark against the
live endpoint says the opposite: **12b is faster on every call shape**, and
neither model made a mistake.

Both models warmed first (a cold VRAM load would otherwise be charged to
whichever case ran first) and grouped per model to avoid swap thrash. Median of
3 runs each:

| case                     | 12b p50 | 26b p50 | tok/s 12b | tok/s 26b | correct |
| ------------------------ | ------- | ------- | --------- | --------- | ------- |
| classifier (reasoning off) | **646 ms**  | 800 ms   | 26.3 | 21.3 | 3/3 both |
| short reply              | **1689 ms** | 2050 ms  | 59.2 | 37.6 | 3/3 both |
| arithmetic               | **6215 ms** | 6674 ms  | 71.8 | 44.2 | 3/3 both |
| tool selection           | **2619 ms** | 4241 ms  | 61.5 | 41.5 | 3/3 both |
| big prompt (~26k tokens) | **6097 ms** | 10134 ms | 53.3 | 43.3 | 3/3 both |

26b is the more *concise* model — 295 tokens to 12b's 446 on the arithmetic, 77
to 100 on the short reply — but its lower throughput more than cancels that.

**Why the dashboard disagreed, and what to do about it.** `tokensPerSec` on the
Model performance card is `completionTokens / latency` summed over calls made at
different times under different load. Latency there includes time queued behind
other work on a serial endpoint, so the number measures *how busy the box was
while that model happened to be in use*, not how fast the model is. 12b carries
3,189 lifetime calls including every busy period; 26b carries 228, mostly from
quiet ones. The card is not wrong about what it reports — it is a poor proxy for
model speed, and it was read as one here. Worth a hint on the card saying so
before it misleads someone again.

### vLLM measured live (`done` pending live reply verification, 2026-08-12)

**Resolved by the operator on 2026-08-12**: the vLLM config was changed and
re-measured with raw curl against the endpoint. The default request (the reply
path's shape) now thinks and comes back parsed — reasoning in the `reasoning`
field (which the vllm adapter reads), `content` holding only the clean
answer. The classifier shape (`chat_template_kwargs: {enable_thinking:false}`
+ `reasoning_effort`) stays properly off: 11 completion tokens, no reasoning.
Two background traces (history-summaries, memory-extraction) errored with 502
during the restart window — transient, they retry on schedule. Remaining
proof wanted: one live bot reply trace showing reasoning in the response body
and no transcript-marker echo. The original findings below are kept for the
record.

The operator switched chat to a live vLLM (0.26.0, `https://vllm.tcloud.monster`,
`gemma4-12b`) on 2026-08-11 and reported two regressions the next day: replies
leaking transcript markers (`[reply to #560]` delivered to Telegram) and no
reasoning anywhere in Debug. Both trace to one fact, measured with raw curl
against the endpoint:

- **Default template never thinks.** A plain chat completion answers directly —
  19 completion tokens on a live reply trace, `reasoning: ''`. The reply path
  sends `reasoning: default` (leave the model alone) by design, so on this
  server every reply runs thinking-off — the exact mode measured on 2026-08-07
  to produce fabricated facts and wrong arithmetic ("Reply calls keep thinking",
  above). The transcript-marker echo is the same degradation showing up as
  format mimicry.
- **`chat_template_kwargs: {enable_thinking: true}` is broken server-side.**
  Non-streaming, the model thinks (192 completion tokens, `finish_reason: stop`)
  but the response arrives with **both `content` and `reasoning` null/empty** —
  the server's parsing swallows the entire answer. Streaming the same request
  shows why: everything lands in `content` as raw text beginning with Gemma's
  literal `thought` marker — no reasoning parser is separating the channels.
  So the app must NOT force the kwarg on this server: replies would come back
  empty. The vllm adapter's `readReasoning` (`reasoning`/`reasoning_content`)
  is correct — the field exists in the schema and is simply never populated.

**Blocker**: app-side nothing can restore thinking here; the fix is in the vLLM
launch (a reasoning parser that understands the Gemma `thought` format +
template defaulting to thinking on), or keeping chat on llama.cpp (which parses
Gemma thinking natively into `reasoning_content` — the 3-way benchmark already
ranked it best for chat replies). Next decision needed: the operator picks
which; nothing to change in this repo either way.

A code-side mitigation (`stripTranscriptEcho`, mechanically removing echoed
transcript markers from reply text before delivery) was shipped and **reverted
the same day (user decision, 2026-08-12): no code solutions to LLM output
problems.** Model misbehavior is fixed at the LLM level — prompt, model choice,
serving configuration — never by post-processing its text in code. Do not
re-add a reply-text sanitizer. What stays is the LLM-level part: an explicit
input-only rule about the transcript format in `BASE_SYSTEM_PROMPT`'s Reply
format block. The real fix for the leakage is restoring thinking (the blocker
above).

## Reply latency (`todo`, 2026-08-07)

From the production trace/analytics review, 2026-08-07 (1,939 traces,
2026-07-22 → 2026-08-07):

- Replies run **p50 36.8s, p90 86.8s**.
- **90% of every generated token is hidden `reasoning`** — a measured reply
  averaged 78 characters of answer against 3,895 of reasoning. One sample reply
  that emitted no reasoning returned an 80-character answer in **3.0s** against
  **49.3s** for a same-sized answer with 10,964 characters of reasoning.
- The two pre-reply gates (`addressing-check` 206 min, `chat-rule-match` 123 min)
  are **37% of all LLM wall time**, against 60 min for reply generation itself —
  and both sit on the critical path, costing the median reply ~13.5s before
  generation starts. 1,704 of those turns ended in silence.
- `gemma4:26B` measured **2.3x faster per token** than `gemma4:12b` across every
  call kind — worth checking the 12b's GPU layer split.
- ~~Interactive calls bypass the priority gate with no concurrency limit~~ —
  capped at 4 on 2026-08-07.
- ~~The 24h history window is injected as one message, invalidating the KV
  prefix~~ — **measured and wrong**. The real cache-breaker was the per-sender
  blocks sitting *above* the window; fixed 2026-08-07.

Blocked on the normalization layer above by user decision (2026-08-07): the
thinking fix is exactly a per-backend knob, so it lands after the seam exists.

## Live checks not yet run (`todo`)

Eleven checks written down between 2026-07-29 and 2026-09-02 and never reported
as run. The work each belongs to shipped and is documented under `docs/`, so
the entries that carried them were pruned — git history has the full write-ups.
The "pending production deploy" half of those old labels is long satisfied (the
platform has released since); what is left is the live half.

- **Hosted-backend directives** (2026-08-14) — read the first live trace on a
  hosted backend and confirm the tool-call and system-turn directives still land
  the way they were tuned to.
- **Anthropic backend, key in hand** (2026-08-14) — the operator's step, since
  the assistant never handles keys: create the backend with a real key, Test
  connection should list `claude-*` models, then point the chat or vision role
  at it. Same for the Gemini backend type.
- **Reasoning-channel re-emission** (2026-08-07) — the photo-reply retry is one
  extra round, not a cure. If the model re-emits into the reasoning channel a
  second time the turn still fails; watch whether it does.
- **Browser-agent failure verdict** (2026-08-12) — a real failed run (an
  impossible download) should settle `failed` carrying the quoted reason, and a
  yt-dlp failure away from the big media platforms should show retry and
  fallback attempts in the run activity before any failure report.
- **Cancelling a task from a group** (2026-08-05) — ask the bot in a group to
  cancel a task and confirm it disappears from the tasks page. The run worth
  watching is a *failed* cancel: the bot must not claim success it did not have.
- **A rule turn that calls no tool** (2026-08-03) — post a media link in a
  rule-bearing group and confirm the video arrives; the failure path is the
  patient one to watch.
- **yt-dlp updater against real GitHub** (2026-08-01) — never run live; the
  tests stub `fetch`. First real proof is **Run now** on the updater card and a
  version badge that moves.
- **Poller survives an outage** (2026-08-01) — pull the network for a few
  minutes with the bot running: status should flip to error with
  `reconnecting automatically`, log one line, and the bot should be back
  within ~15s.
- **Browser-agent chat delivery** (2026-08-01) — send a media video link through
  the bot: the ack should arrive without a ping and vanish when the video posts,
  and the video should play inline carrying the reply.
- **Classifier token cap** (2026-08-01) — confirm addressing-check traces parse
  and completion tokens stay well under the 3,000 cap. A `finish_reason:
  "length"` means the cap is too low.
- **Overview Start/Stop while signed in** (2026-09-02) — the routes were proved
  to exist, but the preview browser holds no session, so a signed-in click on
  the Overview bot control's Start/Stop was never exercised.

## Other open items

- **MCP tools: platform tools on the transport, everything else the user's
  own (`todo`, raised by the user 2026-09-02)** — The user's direction: a
  transport exposes only its platform's tools (Telegram: reply, send, react),
  and a person connects their own MCP servers to an assistant — a Home
  Assistant server to control a smart home, say — with no relation to any
  transport. **What exists already matches the split**
  (`docs/features/tool-connections.md`): each transport's MCP server is a
  *managed* connection scoped to that source; any account adds a remote MCP
  server on `/tools` (`POST /api/tool-connections`: URL + auth headers,
  discover → apply), scoped to all or chosen assistants; the core's own tools
  (history, memory, tasks, browsing, images) are in-process. **What falls
  short for the Home Assistant case, to decide with the user:**
  1. A `user`-role account's connections must target public addresses
     (`isSafePublicUrl` — the SSRF guard), so a LAN Home Assistant
     (`http://homeassistant.local:8123/mcp_server/sse`) is refused unless an
     admin owns the connection. Options: a per-deployment allowlist of private
     hosts the admin grants; or admin-only for private endpoints (status quo).
  2. Only header auth (`authHeaders`, e.g. a long-lived Bearer token). OAuth
     2.1 MCP servers (the growing default) cannot be connected. Would need the
     authorization-code flow with token storage per connection.
  3. Discover → Apply is manual: a user who adds a server must press Apply
     before the assistant sees the tools; a server that adds tools later
     shows drift until re-applied. Fine for operators, unexplained for a
     first-time user — the Tools page could apply on create for user-owned
     connections (the managed rows already do).
  4. Per-assistant scope only; no per-chat or per-person scope (v2 decision).
     A person's private tools (their own home) are usable by everyone who can
     talk to that assistant. Worth revisiting: bind a user-owned connection
     to the owner's linked identities so only their turns get the tools.
  5. Transport tools are one server per transport, offered whole. If a
     transport grows tools that only some assistants should have, the
     managed connection's assistant selection already covers it.
  6. The `stdio` transport is modelled but refused (the core makes the calls
     over HTTP); local stdio MCP servers need a bridge.
  Recommended next step: confirm items 1, 3 and 4 with the user, then a small
  entry per item. No tool-routing/capability router (standing decision).

- **A transport's admin on/off switch has no route or UI (`todo`, 2026-09-01)**
  — `server/transports/service.ts` has `setTransportEnabled` and the
  `transports.enabled` column folds into the desired state (a disabled
  transport runs nothing), but nothing calls it: there is no `PATCH
  /api/transports/{id}` and no control on the dashboard, so the column stays
  at its default. PLAN.md's "appears in the dashboard, where an admin enables
  it" is unimplemented. Small: one account-level route gated to admins plus a
  toggle where the registered transports are listed.

- **Telegram-only surfaces in the core (`todo` — needed before a second
  transport is useful to an operator; recorded 2026-09-01)** — the runtime
  contract is source-agnostic (registration, ingest, turn pipeline, delivery,
  tool scoping, outbound port), but several dashboard and content surfaces are
  keyed by the literal `"tg"`: the Overview bot card
  (`server/transports/status.ts`), the history/search/summaries/analytics
  content plane (`server/source/tg-content.ts`, user decision 2026-08-27 that
  the content plane is Telegram-only), the Users/Groups directories
  (`features/known-users`, `features/known-groups`, `DIRECTORY_SOURCES`), the
  vision gallery (`features/vision/server/repository.ts`), scoped-ref defaults
  in memory/tasks/self-improvement writes, timed task fires
  (`features/tasks/server/fire.ts` binds `source: "tg"`, so a scheduled task
  always delivers through Telegram), the trace trigger kind
  (`"telegram"`), and three literal registries a new source id must be added
  to (`SOURCE_IDS`, `TRANSPORT_SOURCE_IDS`, the app-scope select in
  `ConnectionsManager.tsx`). The full list with file paths is in
  `docs/development/adding-a-transport.md` ("Known Telegram-only surfaces").
  Widening each is a lookup over the registered transports instead of a
  literal; decide with the user whether to do it ahead of a second transport
  or alongside one.

- **Local Telegram Bot API server (`todo`; operator-requested, 2026-08-01)** —
  the standard Bot API caps bot uploads at 50 MB, which is what forces the
  attach-or-fail path for most videos. Running the official
  `telegram-bot-api` server locally raises the ceiling to 2 GB, so nearly every
  browser-agent download could actually reach the chat. Scope when picked up: a
  new Compose service, grammY pointed at the local endpoint (`apiRoot`), token
  logout/login migration between cloud and local API, and a decision on where
  its file store lives. New infrastructure — present the design per the
  Decision Notes process before building.

- **Ukrainian idiomatic joke requests never trigger tools on gemma4:12b
  (`blocked` on a model decision;** from the 2026-07-27 "lied about scheduling"
  trace `64067530…`**)** — a persona-mode, third-person recurring gag request
  in idiomatic Ukrainian ("let \<persona\> send everyone ... once a day",
  phrased colloquially) made the model claim it had scheduled the task without
  calling `tasks_create`. Fixes landed: the base prompt's Honesty rules now
  bind action claims to tool calls (in character too), the Conversation rules
  treat third-person requests about the bot as requests to it, and the
  `tasks_create` description covers joke/third-person recurring phrasings —
  verified live: the model no longer fabricates the action, and both the
  identical English joke phrasing and a plain Ukrainian daily-reminder request
  now select `tasks_create`. But the idiomatic-Ukrainian variant failed 5/5
  live runs — a cross-lingual gap in gemma4:12b itself. The English variant is
  pinned in `features/scheduled-tasks/server/tool-selection.integration.test.ts`;
  the Ukrainian one is deliberately NOT pinned in code (no Cyrillic in code —
  user rule, 2026-07-27) and lives only in the exported trace. Next decision
  needed (operator): try a stronger/tool-tuned model in Settings for the reply
  path, or accept the gap; re-verify against the trace phrasing after any
  model change. Related observation feeding the same decision: the plain
  English "what reminders do I have?" live case intermittently fabricates a
  full reminder list without calling `tasks_list` (seen 2 of ~6 live suite
  runs, 2026-07-27) — same bluffing pattern, worth including when evaluating a
  replacement model.

- **Context-free reminders + bluffing instead of searching history
  (`in-progress`;** from the 2026-07-28 traces `257ad4e9…` and `925ecf31…`, plus
  the operator's account of how the task was set up**)** — one incident, two
  defects, at opposite ends of the same feature.

  *What happened.* A person was discussed in the chat over several days. A user
  asked the bot to remind another participant daily who that person is. The bot
  created a scheduled task whose instruction was the surface phrasing of the
  request ("remind X who \<person\> is") rather than the substance, so every fire
  delivered that sentence back — a reminder that points at a fact instead of
  carrying it. When the reminded user then asked outright who the person was, the
  bot never called a history tool across five consecutive turns
  (`finish_reason: stop`, zero tool calls, all 21 tools offered), accused them of
  faking amnesia, and answered with an empty metaphor. Its own reasoning trace
  states it cannot find the term, then improvises anyway.

  *Root cause of the reminder half.* `fireScheduledTask` composes base prompt +
  persona + specialist + language + directive and **loads no transcript at all**
  (`features/scheduled-tasks/server/fire.ts`), so the firing model has no way to
  know what the instruction refers to. `tasks_create` only ever asked for a
  "self-contained" instruction without saying that self-contained means carrying
  the facts.

  *Fixes landed* (design decision — operator, 2026-07-28: fix at **both** ends
  rather than either alone, since a 12B model may miss either step):
  1. **Grounding** block in `BASE_SYSTEM_PROMPT`
     (`features/bot-messaging/server/prompt.ts`) — factual claims limited to
     transcript / durable memory / this-turn tool results; searching history is
     mandatory for an unfindable reference; "I don't know" is an acceptable
     answer; covering a gap by accusing the asker is forbidden; the persona
     governs tone and never truth.
  2. **`TASKS_CREATE_DESCRIPTION`** (extracted to an exported constant so it can
     be pinned) — states that a fire sees only the instruction text, requires
     `history_search` → `history_get_in_range` before creating a task that
     references chat-specific people/events/topics, requires the findings be
     written into the instruction, and says to ask the user rather than store an
     empty pointer. Same rule echoed on the `instruction` field of
     `tasks_create`/`tasks_update`.
  3. **`buildTaskDirectiveMessage`** (`fire.ts`) — second line of defence: tells
     the fire it has no transcript, to look the reference up in history before
     writing, and to be honest rather than parrot the directive when the lookup
     comes up empty. The fire already runs with the full toolset bound to the
     task's chat, so the lookup is available.

  Files changed: `features/bot-messaging/server/prompt.ts` + `prompt.test.ts`,
  `features/scheduled-tasks/server/mcp-tools.ts` + `mcp-tools.test.ts`,
  `features/scheduled-tasks/server/fire.ts` + `fire.test.ts`. Verified:
  `npm test` (74 files, 727 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Live re-test of the reply half: failed* (trace `f79f84a2…`, 2026-07-28). Asked
  "хто такий Мурадян?" the bot again called no tool and again answered with a
  metaphor. Its reasoning block names the source explicitly: *"looking at my
  previous response (#13164), I defined it as a symbol of bypassing direct routes"*,
  padded with general knowledge (*"in common underground/internet/tech contexts
  (especially in Ukraine), 'Muradyan' often refers to…"*). The term occurs five
  times in the 24-hour window: twice asserted by the bot, three times as
  participants asking what it means. **No human ever said what it is** — the bot
  invented it, then read its own invention back as established fact.

  *Root cause of the miss.* Grounding declared "the transcript" a source
  wholesale, and a bot line is transcript. The rule's own bot-specific clause
  ("if you cannot back it up, say so") reads as being about *honesty under
  challenge*, not about *what counts as evidence*, so a self-confirming loop
  passed it.

  *Second round of fixes* (design decision — operator, 2026-07-28: **rank the
  sources**, prioritize user-sourced information over bot-sourced; enforcement
  stays in the prompt — *"we never solve model problems by code"* — so no gating,
  forced retrieval, or verifier pass):
  4. **Grounding** rewritten around source rank: fact = what a *person here*
     said, durable memory, or a this-turn tool result. The bot's own messages are
     "never a source" and are declared unreliable outright — wrong, stale,
     polluted by the conversation, or invented. People outrank the bot; a user
     correction is taken as correct. A term appearing *only* in the bot's own
     lines is named as the not-known case, with re-deriving a meaning from its
     own earlier wording forbidden. Mirrors what memory extraction already does
     (`EXTRACTION_SYSTEM` refuses to harvest facts from bot lines).
  5. **`TRANSCRIPT_PREAMBLE`** (`features/history/server/format.ts`) — says it at
     the point of use: the other people's lines are what was said, the bot's own
     are not evidence and may be wrong or invented.
  6. **History tool results carry provenance**
     (`features/history/server/mcp-tools.ts`) — each line names its author in
     words (`a participant` / `you (the bot)`) instead of the wire role, and a
     result whose every row is bot-authored appends
     `SELF_AUTHORED_ONLY_NOTE` ("…this result confirms nothing… Treat this as not
     found."). The only code-side change, and only because the prompt's source
     ranking is unusable if a lookup hands back rows without saying whose they
     are. `structuredContent.role` is unchanged for machine consumers.

  Files changed (round 2): `features/bot-messaging/server/prompt.ts` +
  `prompt.test.ts`, `features/history/server/format.ts` + `format.test.ts`,
  `features/history/server/mcp-tools.ts` + new `mcp-tools.test.ts`. Verified:
  `npm test` (75 files, 739 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Third round: dedicated `context` field* (rework — user direction, 2026-07-31:
  instead of one-liner instructions the bot has to **gather and save context**
  when creating a task; asking for the facts to be woven into the instruction
  text, round 1's approach, still produced one-liners in practice):
  7. **`scheduled_tasks.context` column** (nullable text; migration
     `db/migrations/0045_first_metal_master.sql`) threaded through the row
     mapper, repository insert/update, service create/update (trim + 4000-char
     bound, blank stores null), and `ScheduledTask`.
  8. **Tool contract**: `tasks_create` gains a **required** `context` input —
     the gathered background, written self-contained for a reader with no chat
     transcript; `''` allowed only for a fully self-contained instruction.
     `TASKS_CREATE_DESCRIPTION` reworked around "GATHER CONTEXT BEFORE
     CREATING" (from the visible conversation or `history_search` /
     `history_get_in_range`), keeping the ask-instead-of-storing-a-pointer and
     third-person/gag rules. `tasks_update` gains an optional `context`
     replacement; `tasks_get`/`tasks_list` structured views include it.
  9. **Fire prompt** (`buildTaskDirectiveMessage`) — a "Saved context" block
     carries the stored background into the fire; the history lookup stays as
     fallback for tasks that predate the field.
  10. **Dashboard** — optional Context textarea on create and edit
     (`ScheduledTasksManager`), context shown on task cards; dashboard API
     create/patch accept it (`context: null` clears on patch).

  Files changed (round 3): `db/schema.ts` + migration 0045,
  `features/scheduled-tasks/{types.ts, server/repository.ts, server/schema.ts,
  server/service.ts, server/mcp-tools.ts, server/fire.ts,
  ui/ScheduledTasksManager.tsx}`, `app/api/scheduled-tasks/route.ts`, tests
  (`fire.test.ts`, `mcp-tools.test.ts`, `scheduled-tasks.integration.test.ts`).
  Verified: `npm run lint`, `npm run typecheck` clean; `npm test` 84 files /
  852 passed; `npm run test:integration` 25 files / 338 passed (11 live files
  skipped); `npm run build` green after the operator re-ran the `data/pg`
  chmod (the recurrence is tracked below).

  *New evidence for the model half* (trace `e5f96e23…`, 2026-07-31): asked (in
  Ukrainian) to *update* the Muradyan task with the PS5/donations backstory,
  gemma4:12b's reasoning correctly narrowed to the scheduled task and literally
  ended "Let's do that check" (meaning `tasks_list`) — then the generation
  emitted a plain chat message claiming the context was saved
  (`finish_reason: stop`, `tool_calls: null`, all 25 tools offered). The
  decision died crossing from the reasoning channel to generation; no prompt
  text can bind that. Two levers, both operator decisions: (a) the standing
  model-replacement question below; (b) injecting the chat's scheduled tasks
  into the reply-turn system context (like memory/rules) so "the task" resolves
  without a `tasks_list` round-trip — costs tokens per turn, not implemented.

  **Remaining risk / next step (operator):** still unverified live, and still the
  same gemma4:12b tool-avoidance pattern as the `tasks_list` fabrication in the
  item above — round 1's prompt text was ignored, and rounds 2–3 add more prompt
  text plus a required tool field, so the model may ignore them too. Re-run
  live: ask the bot who "Мурадян" is again; a pass is "I don't know / nobody
  here ever said". Also re-run the task half (create a reminder that references
  a chat-only topic — a pass now includes a filled `context` on the created
  row; then ask the bot what that topic is). Existing thin task instructions
  are deliberately **not** migrated — operator fixes those through the bot
  (decision, 2026-07-28); old rows simply have `context = null` and keep the
  history-lookup fallback. If the model still refuses to search, this folds
  into the same model-replacement decision. Known remaining laundering path,
  not addressed: `history_recall_topics`
  serves daily topic summaries, which are written over both sides of the
  conversation — a bot-invented term can therefore re-enter through a summary
  with no author attached. Decide whether summaries should mark, or exclude,
  bot-sourced content.

- **`npm run build` dies on `data/pg` whenever the bundled Postgres recreates it
  (`done` for now — one host-side fix, may recur).** Turbopack walks the project
  tree and `data/pg` is created `drwx------` owned by the container's postgres uid,
  so the build ends in `Permission denied (os error 13) … reading dir "…/data/pg"`
  with a `TurbopackInternalError` — nothing to do with the code (`eslint.config.mjs`
  already ignores `data/**` for the same reason; Turbopack has no equivalent).
  The operator ran the chmod on 2026-07-29 and the build was green again. It
  **recurred** on 2026-07-31 (a fresh Postgres volume recreated the dir); the
  operator re-ran the chmod the same day. **Recurred again on 2026-08-01**,
  blocking the build check for the chat-delivery overhaul above, and **still
  failing later the same day** for the poller-supervision work. Four recurrences
  now — worth a documented pre-build step (or a Turbopack-side exclusion if one
  appears).

- **Traces bind-mount permissions (`blocked` on an operator decision;** from
  the 2026-07-22 prod data-loss incident**)** — Docker auto-creates
  `./data/traces` root-owned while the app runs as the non-root `app` user, so
  trace flushes fail with EACCES (now surfaced via the data-loss banner, the
  Overview card and `/api/health`). Host-side workaround: chown the bind mount
  to the container's `app` uid. The permanent Dockerfile fix (root entrypoint
  chowns the mount, then drops to `app` via su-exec) was proposed but not
  implemented — a container security-posture change that needs the operator's
  decision.
- **Search-engine cascade (operator's call)** — engines rank themselves by
  success stats, so the blocked-engines-first configured order self-heals; the
  open question is adding **Brave** as a fourth engine (measured best on
  2026-07-26: 45 relevant results).
- **Memory General-knowledge cleanup (verify)** — the wrong pre-fix lines in
  the General knowledge document (2026-07-17 incident) needed manual removal on
  `/memory`; the pruning merge only runs when a new `general` note arrives.
  Verify the cleanup happened; drop this item if it did.
