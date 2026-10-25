# Deployment

The platform is designed to be **self-hosted with Docker Compose** on a home server,
NAS or VPS: the core's image, one image per transport it runs, a Redis instance that
carries the queues between them, and a Postgres instance. Everything else in the
architecture follows from that: in-process schedulers, in-process singletons pinned to
`globalThis`, and advisory locks for the brief moments two core processes overlap.

Transports are **additive**: each is a separate image that registers itself, so
running one more is one more service and no change to the rest.

## Docker Compose

```bash
docker compose up -d
```

Three services, every one of them a **released image** — nothing is built on
the host. Transports are not services: the core knows none, and each is an
npm package the core installs at boot from the `TRANSPORTS` you name (below).

| Service | Image | Notes |
| --- | --- | --- |
| `app` | `ghcr.io/assistants-swarm-hub/ash-core:${ASH_VERSION}` | The dashboard, the web chat and the whole pipeline. Publishes `${PORT:-3200}:3200` |
| `redis` | `redis:7-alpine`, started with `--appendonly yes` | The cross-app bus and the two queues (`transport-updates`, `inbound-messages`). Publishes `${REDIS_PORT:-6379}:6379` |
| `db` | `pgvector/pgvector:pg17` | The one database. Publishes `${POSTGRES_PORT:-5432}:5432` |

`ASH_VERSION` defaults to the version this checkout releases, so a clone runs a
known-good core rather than a moving `latest`. Set it in `.env` to run another
one; `npm run release:*` rewrites the default when the version is bumped, and
the release workflow refuses to ship if the two ever drift. A transport's
version is its own repository's and pinned in the spec you name; the only
thing the two sides must agree on is the transport SDK's major, which the
core checks when it loads the package.

To build the working tree instead of pulling, add the dev override — it adds a
`build:` to the core and changes nothing else. A transport is never built here:
to run one from source, pack it (`npm pack`), mount the tarball, and name the
mounted path in `TRANSPORTS`.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`app` waits for `db` (healthcheck `pg_isready`) and `redis` (`redis-cli ping`) to be
**healthy**. The core boots with no transport at all; a transport is a package it
loads at boot. All three restart `unless-stopped`.

### Adding a transport

A transport is an npm package in its own repository, published to the org's
registry on GitHub Packages. Running one is **two lines in `.env`**, and no
change to the compose file — the package name and version are the transport's
own README's to give:

```
TRANSPORTS=<package>@<version>
NPM_TOKEN=<a token with read:packages>
```

`TRANSPORTS` is a space-separated list of npm specs, so several transports are
several entries. On every boot the image's entrypoint installs what is named
into a directory of its own (`/app/transports`), away from the traced
`node_modules` the server runs on, and the core finds the packages there. The
token is what the registry wants for the install — a package published there
is readable by any account, but not anonymously — and is removed from the
container's environment before the server starts. Nothing is cached across
recreations: the install happens on each boot, which is what keeps "which
version runs" a fact of the environment rather than of a layer.

Then `docker compose up -d app`. The core registers the package, the dashboard
grows a connection section built from the config fields it declares, and its
platform actions appear as tools. Nothing in the core is edited — if something
has to be, that is a core bug (see
[Adding a transport](../development/adding-a-transport.md)). A package the
core refused — built for another SDK major, or not a transport at all — shows
on the Overview by its package name with the reason, and the rest run.

### Volumes

All four persisted paths are **bind mounts to host directories**, not named volumes, so
you can see and back up the data with ordinary tools:

| Host path (default) | Container path | Holds |
| --- | --- | --- |
| `./data/pg` | `/var/lib/postgresql/data` | The database |
| `./data/redis` | `/data` | The Redis append-only file: every queued transport event and inbound turn not yet consumed |
| `./data/traces` | `/app/core/data/traces` | Monthly trace NDJSON logs |
| `./data/downloads` | `/app/core/data/downloads` | Agent downloads |

All four are mounted, and all four hold the only copy of what they contain. Two of
them matter for non-obvious reasons:

- The **Redis** mount is where the no-message-loss guarantee lives while a message is
  between the two apps. An inbound update that a transport has forwarded
  but the core has not yet consumed exists only in that AOF; drop the directory and
  those messages are gone.
- The **downloads** mount: a file an agent fetched that was **too large to
  attach to the chat** exists nowhere else, so an unmounted container path would
  silently lose it on the next image replacement.

`/app/core/data/bin` — where the yt-dlp updater keeps the current binary — is
deliberately **not** mounted (user decision, 2026-08-01). It is a cache, not data: a
recreated container falls back to the build the image pins and re-downloads a current
one on boot, which costs ~40 MB per redeploy and saves a host directory whose ownership
would have to be kept right for the non-root `app` user.

A host bind mount must be writable by the container's non-root `app` user. If it is
not, trace flushing fails — which surfaces as a global dashboard alert rather than a
crash, because failing readiness there would drop the traces still buffered in RAM —
and downloads fail per-run, reported on the run row.

### Environment

Compose has working defaults; a root `.env` is optional and is read only for the
`${…}` substitutions in `docker-compose.yml`. There is no root `.env.example`:
`core/.env.example` documents local (non-Docker) development.

The core (`core/server/env.ts`) reads:

| Variable | Compose sets it to | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Composed from `POSTGRES_*`, pointing at the bundled `db` | Override to use an external database |
| `REDIS_URL` | `redis://redis:6379` | Unset → the core boots **without** its turn consumer and ingest and processes no messages (it logs `Inbound turn consumer NOT started`) |
| `TZ` | `${TZ:-UTC}` | Container timezone only — the *operator* timezone used for rendering and scheduling is a database setting |
| `NODE_ENV` | `production` | |

Every core variable also accepts a `<NAME>_FILE` variant pointing at a file whose
contents are used instead (Docker secrets).

The image's entrypoint (`core/docker/entrypoint.sh`), not the app, reads two more:

| Variable | Compose sets it to | Notes |
| --- | --- | --- |
| `TRANSPORTS` | `${TRANSPORTS:-}` | Space-separated npm specs of the transport packages to install at boot: a name, a `name@version`, or a path to a tarball mounted into the container. Empty: a core with no transports |
| `NPM_TOKEN` | `${NPM_TOKEN:-}` | The token the org's registry on GitHub Packages wants for the install (`read:packages`). Written to a temporary `.npmrc` for the install, then removed; the server never sees it |

A transport has no environment of its own: bot tokens and everything else it
needs arrive from the core when it is loaded.

Full variable reference: [Configuration](../configuration.md#environment-variables).

### Health

```
GET /api/health   (core, :3200)  → 200 when ready, 503 when the database is unreachable
```

A transport's connections have no endpoint of their own: their live state is
the host's, in the core's process, and the dashboard's status surfaces read it
directly.

The container healthcheck polls this every 10 s (start period 40 s). It uses
`127.0.0.1`, not `localhost`, deliberately: the server binds IPv4 `0.0.0.0`, and
`localhost` can resolve to IPv6 `::1`, which would refuse the connection.

## The images

### `ash-core`

Multi-stage, from `node:24-alpine`.

```
base ──► deps (npm install, incl. dev) ──► builder (npm run build) ──► runner
```

Deliberate choices worth knowing before you change them:

| Choice | Why |
| --- | --- |
| `npm install`, not `npm ci` | `package-lock.json` is generated on Windows and omits Linux-only optional native deps (musl builds of `lightningcss` / `tailwind-oxide`, `@emnapi/*`), which `npm ci`'s strict sync check rejects |
| Native deps installed **inside** the image | Host `node_modules` must never be copied in — they are built for the wrong platform |
| One manifest per workspace package the core depends on, copied before the install | The workspace install needs every manifest; the `deps` stage copies `core/package.json` plus `packages/{bus,contracts,db,media,service,ui}/package.json` |
| `output: "standalone"` | The runner ships only traced runtime deps (`.next/standalone`), not a full `node_modules`; traced from the monorepo root, so the output mirrors the workspace layout |
| `ffmpeg` from apk | Vision samples video frames with it, voice transcodes both ways, and agent runs mux streams with it (user decision: system ffmpeg over a bundled/WASM build) |
| `yt-dlp` from **upstream**, not apk | The agents' media downloader; a media site's player has no file URL to fetch (user decision, 2026-07-29). The apk package is frozen per Alpine release while these sites change on purpose, so the image pins upstream's self-contained `musllinux` build (checksum-verified, no python3) and the app's daily updater keeps a newer copy in `/app/core/data/bin` (user decision, 2026-08-01) |
| `chromium` + `nss`/`freetype`/`harfbuzz`/fonts from apk | Playwright's own download is a glibc build that will not run on Alpine (musl). `CHROMIUM_EXECUTABLE_PATH` points at the distro browser |
| `playwright` and `playwright-core` copied **whole** over the traced copies | They are `serverExternalPackages`, so Next's file tracer copies only statically resolvable JS and misses runtime data files like `playwright-core/browsers.json` |
| `sharp` needs no apk package | It ships its own musl libvips binary via npm |
| Non-root `app` user | Standard hardening; `data/traces`, `data/downloads`, `data/bin` and `transports` are created and chowned up front |
| `npm` stays in the image | The entrypoint installs the transport packages the operator names at boot; nothing else in the runner needs it |

#### Startup command

```sh
/app/entrypoint.sh      # core/docker/entrypoint.sh
```

Three steps: install the packages named in `TRANSPORTS` into `/app/transports`
(skipped when it is empty; a failed install is logged and the core starts
without them), apply pending migrations, serve. Migrations complete **before**
the app accepts traffic, and a failed migration fails the start — so the app
never serves against an unmigrated database.

The migration runner is isolated on purpose: `packages/db/migrate/` has its own tiny
`package.json` and uses drizzle's **programmatic** migrator
(`drizzle-orm/node-postgres/migrator`) rather than the drizzle-kit CLI, which is
intentionally absent from the slim image. The image copies the SQL chain from
`core/store/migrations` next to it, and its two dependencies live in their own
directory so they never touch the app's traced `node_modules`. With `DATABASE_URL`
unset it warns and exits 0 rather than failing the container.

### A transport has no image

A transport is an npm package, published from its own repository to the org's
registry on GitHub Packages; this repo's release workflow has one image: the
core. The core's image installs the transports at boot (above). Whatever a
platform library needs at runtime it must bring as an npm dependency — the
image has `ffmpeg`, Chromium and `sharp`'s own libvips, and nothing else a
transport could count on.

## Upgrading

Bump `ASH_VERSION` in `.env` (or pull a new checkout, whose pinned default moves
with each release), then:

```bash
docker compose pull && docker compose up -d
```

Or, when running the dev override, rebuild:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`.
The core's entrypoint applies any new migrations first; each transport
re-registers with the core at boot and reconciles from the desired state the
core answers with.

**Once, upgrading past 1.48.1:** the app moved from `apps/core/` to `core/` in
this repository, and its container paths moved with it — `/app/apps/core/data/*`
is now `/app/core/data/*`. The bind mounts in `docker-compose.yml` moved in the
same commit, so take the new compose file along with the new image. Pulling the
image against an old compose file leaves traces and downloads unmounted: the host
directories still hold what they held, but the container writes past them.

**Once, upgrading past 1.49.0:** the bundled database defaults to `core` (it was
`bot`). A stack that never set `POSTGRES_DB` keeps its data in `bot`, and the new
default points the core at a `core` database that does not exist — it fails to
start rather than starting empty. Either set `POSTGRES_DB=bot` in `.env` and
carry on, or rename the database once while the app is stopped:

```bash
docker compose stop app && docker compose exec -T db psql -U bot -d postgres -c 'alter database bot rename to core' && docker compose up -d
```

Nothing in the store depends on the name; the rename is instant.

A transport upgrades on **its own** schedule — its package and version are its
repository's, not this one's: change the version in `TRANSPORTS` and recreate
`app`. The only thing the two sides must agree on is the transport SDK's
major; when they do not, the core refuses that package by name and says so on
the dashboard rather than failing quietly.

During the overlap window two core processes may briefly co-exist. That is handled:

- Background jobs take **Postgres advisory locks**, so a job never
  double-processes. A lock miss is a benign skip.
- The agent runner sweeps any run left `running` by the previous process to
  `failed` at boot.
- The trace store flushes buffered traces on graceful shutdown, so at most one flush
  interval (60s) of settled traces is at risk on a hard kill.

The host closes every platform connection first on `SIGTERM`, so a replacement
container does not collide with the old one's sessions. Anything a transport
had forwarded but the pipeline had not consumed waits in the Redis queue across
the restart.

## Releases

`.github/workflows/release.yml` ships two kinds of artifact, each on its own
version field: the **app images** on the root `package.json` version, and the
**transport SDK** on `packages/transport-sdk/package.json`'s. Neither waits for
the other.

**The gate is the registry, not the diff.** A version field that changed on
this push says nothing about whether anything shipped: a release that failed
half-way leaves the manifest untouched, so a "did the version change?" check
would never retry it, and a version already published would be quietly
overwritten with different bytes. So the workflow asks what is actually
released — is this image tag in GHCR, is this package version on the npm
registry, is the git tag on origin — and ships only what is missing. Two
consequences worth knowing:

- **It is self-healing.** Any later push to `main` finishes an interrupted
  release. Nothing has to be bumped again.
- **It runs on every push to `main`**, because a fix-up push has to be able to
  wake it. When everything on the commit is already released the first job says
  so in about half a minute and the rest is skipped.

```bash
npm run release:patch
```

(or `release:minor` / `release:major` — they bump the version without creating a git
tag), then commit and push to `main`. Actions → Release → *Run workflow* forces a
release of the current version even when it is already published — the escape
hatch for replacing a bad image. (A published npm version cannot be replaced at
all; a forced SDK run re-verifies and re-tags it instead of failing red.)

A release is all-or-nothing: nothing reaches the registry and no tag is created
unless every image built and started. This repository's image is
`ghcr.io/assistants-swarm-hub/ash-core`; each transport publishes its own from
its own repository. The workflow:

1. **plan** — asks the registries what exists: each image tag, the SDK version,
   and both git tags. It emits the build matrix (exactly the images that are
   missing) and stops the whole run when there is nothing to do.
2. **verify** — `npm install`, `npm run lint`, `npm run typecheck`, `npm run test`
   (fanned out across the workspaces via turbo. Unit tests only; the integration
   suite needs Docker and is not part of the gate.) Then one release-shaped
   check on `docker-compose.yml`, the artifact an operator actually clones:
   its pin must name the version being released (`npm run release:*` keeps
   it in step; this catches a version bumped any other way). Nothing about
   any transport is checked: the core's release never waits on one.
3. **build** — one entry per missing image (`ash-core` from
   `core/Dockerfile`), built with layer caching and handed to the next job
   as an artifact — nothing is pushed. One failing image fails the release.
   Transports are not in the matrix: each releases from its own repository.
4. **publish** — loads the images and **boots the core against a real Postgres
   and Redis** (pgvector, because migration 0000 creates the `vector`
   extension), waiting for `/api/health` to answer `ok` *and* report the version
   being released. Only then does it push every `:<version>`, move every
   `:latest`, read both digests back from the registry to confirm they match,
   and create the `v<version>` git tag. A migration that was generated but never
   committed, a missing runtime dependency, a broken entrypoint or a stale
   cached build all fail here, with the registry untouched.

And, for the SDK:

5. **publish-sdk** — builds `packages/transport-sdk` (ESM + `.d.ts`, with the
   private workspace packages bundled in), publishes it, and then **pulls it
   back out of the registry** into a scratch project that has none of this
   repository: the package must import and run, carry declarations that name
   no private workspace package, and typecheck for a `defineTransport`
   consumer. That is the position every transport author is in, and it is
   where this package's two real failures showed up. The tag goes up last.

The SDK carries its own semver because a transport author pins the package,
not a core release, and the two move at different speeds. The number the two
sides must actually agree on is the SDK's **major**: a transport declares it
as a peer dependency, the core compares that range against the major it hosts
(`TRANSPORT_SDK_MAJOR` in the contracts), and refuses a mismatch by name.

No registry secrets: the publish jobs authenticate with the workflow's own
`GITHUB_TOKEN` (`packages: write` for the push, `contents: write` for the tag).
A package's first push makes it private to the org — flip both the container
images and the npm package to public in their settings once. "Public" means
different things on the two registries: a public **container** image pulls
anonymously, while the npm registry asks for a token on every request even for
a public package, so a transport author needs one with `read:packages`.

Note that `verify` uses `npm install` rather than `npm ci` for the same lockfile
reason as the Dockerfiles.

## Running behind a reverse proxy

Only the core is exposed; a transport runs inside it and talks to its platform
outbound. Two things need care on the core:

- **SSE.** `/api/events` sets `X-Accel-Buffering: no` and
  `Cache-Control: no-cache, no-transform`, which nginx honours. Make sure your proxy
  does not buffer responses or apply a short read timeout — the stream is
  long-lived, with a heartbeat comment every 25s.
- **TLS.** The session cookie is `HttpOnly` and `SameSite=Lax` but is **not** marked
  `Secure`, so terminate TLS at the proxy if the dashboard is reachable from outside
  your LAN.

## Production checklist

- [ ] `TRANSPORTS` names each transport at a pinned version, and `NPM_TOKEN` is a
      token with nothing but `read:packages`.
- [ ] Claim `/setup` and create the first admin account before exposing the port.
      `/setup` self-seals the moment any account exists; further accounts come from
      the Accounts page.
- [ ] `DATABASE_URL` points where you intend (or you are using the bundled `db`).
- [ ] `./data/traces` and `./data/downloads` are on a disk with room and are
      writable by the container user. Overview's **Trace storage** and **Downloads**
      cards probe this for real — check them rather than assuming.
- [ ] `./data/redis` and `./data/pg` are on the same backup regime — see
      [Backup and restore](backup-and-restore.md).
- [ ] Do not publish `POSTGRES_PORT` or `REDIS_PORT` beyond localhost.
- [ ] Add your LLM server on the Backends page, pick the chat model in Settings →
      Models, then confirm Overview shows a live probe result — not just "configured".
- [ ] Set the operator timezone and the daily-jobs run time (Settings → General).
- [ ] Create an assistant on `/assistants` and connect a bot token in its editor.
      Owner rights need no setting: the assistant's owning account holds them, and so
      does every admin; a person links their chat identity to their account by
      sending the code from `/profile` to the bot.
- [ ] `GET /api/health` returns 200.
- [ ] Overview's **Bots** card reads Running, and each assistant's
      connection in its editor reads Running with the bot's `@username`.
- [ ] A backup routine exists for the database, the Redis directory **and** the
      trace directory — see [Backup and restore](backup-and-restore.md).

## Scaling

This is a single-instance design, and several parts assume it:

| Component | Assumption |
| --- | --- |
| Platform connections | Live in each transport, one per connected bot. A platform that permits one consumer per token needs exactly one instance of that transport |
| Redis | One instance; the queues and the bus assume it, and its AOF is the only copy of in-flight events |
| Ingest and turn consumer | Per-chat ordering is an in-process promise chain per `(source, chat)`; a second core replica would interleave one chat's turns |
| Realtime hub | In-process pub/sub. Multiple replicas would need an external fan-out (e.g. Postgres `LISTEN`/`NOTIFY`) behind the same API |
| Trace store | In-process, file-backed. Multiple replicas would need an external store behind the same API |
| Job schedulers | One ticker per process; cross-process overlap is *tolerated* via advisory locks, not designed for |

Scaling vertically (a bigger box, a faster LLM endpoint) is the supported direction.
Running multiple replicas is not, without the API-level replacements above.

## Adding a transport

A new transport is one more package in `TRANSPORTS`: the core installs it at
boot, registers it from its descriptor, announces the config fields its
connections need, and the dashboard renders them — no core change and no
Compose wiring at all. The interface, step by step, is in
[Adding a transport](../development/adding-a-transport.md).
