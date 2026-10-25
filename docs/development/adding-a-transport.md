# Adding a transport

How to connect a new messaging platform (Signal, Matrix, Slack, …) to
an assistants-swarm-hub core.

**You do not need this repository.** A transport is an npm package developed
in its own repository against the published
[`@assistants-swarm-hub/transport-sdk`](../../packages/transport-sdk/README.md);
the core's operator installs it, restarts, and you appear on their dashboard.
Everything a transport must do is published:

| What you need | Where it is |
| --- | --- |
| The interface, as code | [`@assistants-swarm-hub/transport-sdk`](../../packages/transport-sdk/README.md) on GitHub Packages — the types you implement against, `defineTransport`, and the few helpers a transport's own tools call |
| A working version of every step | The transports published under [assistants-swarm-hub](https://github.com/assistants-swarm-hub) — each a separate repository built on the SDK, exactly like yours will be |

This document walks the interface in the order a new transport meets it. Read
[Architecture overview](../architecture/overview.md) first for where a
transport sits, and [The message pipeline](../architecture/message-pipeline.md)
for what the core does with what you send it.

## What a transport is

A transport is a **package the core hosts in its own process** and that owns
exactly one platform. It has no process, no port, no database and no files.
Everything it knows at runtime it learns from the core (which bots to run,
with which config), and its whole job is translation:

| Direction | The transport… | The core… |
| --- | --- | --- |
| Platform → core | reports **every** update it sees (messages addressed or not, edits, reactions) through the host's hooks, media bytes attached | normalizes it into events, dedupes shared chats, persists it in the conversation store, decides who gets a turn, composes the prompt, runs the pipeline |
| Core → platform | performs the sends the host asks of its connection: text, voice, photos, files, deletes, menus, titles, the typing indicator | hands each finished reply and each turn-lifecycle phase to the host, which asks the connection to act |
| Model → platform | registers the platform's own actions (react, say) as MCP tools on the server the host builds for it | offers those tools on that platform's turns only, bound to the turn out of band |
| Operator → transport | announces its config fields in its descriptor | renders them in the assistant editor, stores the values opaquely, hands them back as desired state |

The transport never decides whether to answer. It computes only what the wire
format alone can say (a reply target, an @mention entity) and reports it; the
name check and the LLM analyzer are the core's.

## The shape at a glance

```
 platform API ◄──► your package           the core's host
                    ├─ descriptor          ├─ registers you from it, renders your config fields
                    ├─ adapter.connect()   ├─ opens one connection per assistant from the desired state
                    │   └─ hooks           ├─ message/edited/reaction/menuPress/status → events, dedupe, queue
                    ├─ normalize()         ├─ one platform message → the contract's InboundMessage
                    ├─ addressing()        ├─ the structural verdict, per receiving bot
                    └─ tools.register()    └─ your MCP tools on the server it builds for you,
                                              next to the delivery tools it registers itself
```

Nothing crosses a process boundary. The host calls your functions; your
connection calls the platform.

## Before you start: what the core knows about you

Nothing, until it loads you. There is no list of transports anywhere in the
core (user decision, 2026-09-02): the source id in your descriptor is accepted
as long as it has the right shape, and every runtime lookup over "the sources"
— the ingest's source check, the managed tool connections, the Users and
Groups roster, the media backfill and gallery, the app-scope select on the
Tools page — reads the registration table. A transport connects to a core
with **zero core edits**; if you find yourself editing a core file to make
your transport appear, that is a core bug — file it.

Two things are checked when you load:

| Check | Rule | On failure |
| --- | --- | --- |
| **Source id** | `^[a-z][a-z0-9-]{0,31}$` — short, lowercase, stable. It becomes the prefix of every scoped ref (`signal:user:123`), the slug of your MCP tools (`signal__send_message`), the `source` on every event and the `transports.id` row. It cannot change later without rewriting stored refs | The package is refused; the roster names it with the reason |
| **SDK major** | The `@assistants-swarm-hub/transport-sdk` range in your `peerDependencies` must start on the major the core hosts (`TRANSPORT_SDK_MAJOR`, `5` today). It moves when the interface moves incompatibly — a hook's shape, a connection method's signature, what the runtime hands your tools | The package is refused by name, with a reason the dashboard shows. Nothing of it runs until either side updates |

Every dashboard surface is source-generic — see
[What the dashboard shows for your transport](#what-the-dashboard-shows-for-your-transport)
at the end for the exact list, and for the one convention it relies on.

## Step 1 — Scaffold the package

Start an ordinary Node package in your own repository. The `@assistants-swarm-hub`
scope lives on GitHub Packages, so point npm at it first:

```
# .npmrc
@assistants-swarm-hub:registry=https://npm.pkg.github.com
```

That registry wants a **token on every request**: a package published there is
readable by any account once it is public, but not anonymously. Put one with
`read:packages` in your user-level `~/.npmrc`, where it stays out of every
repository you write:

```
//npm.pkg.github.com/:_authToken=<token>
```

In CI it is the workflow's own `GITHUB_TOKEN`.

```bash
npm install --save-peer @assistants-swarm-hub/transport-sdk @modelcontextprotocol/sdk zod
npm install --save-dev tsup typescript
```

| Dependency | Gives you |
| --- | --- |
| `@assistants-swarm-hub/transport-sdk` | `defineTransport`, the types you implement against, and the helpers your own tools call: `turnOf`, `toolRefusal`, `tracedTool`, `reactToMessage`, `normalizeImageForChat`, `isDocumentFile`, `describeError` |
| `@modelcontextprotocol/sdk` | The server type your tools register on |
| `zod` | Your MCP tools' input shapes |
| Your platform SDK | Whatever client library your platform has |

The three are **peer** dependencies: the SDK because its major is what the
core checks, the other two so your tools' input shapes and the server they
register on agree with the host's. Everything else your package needs, it
brings.

Then make the package findable and loadable:

```json
{
  "name": "@your-scope/transport-signal",
  "keywords": ["assistants-swarm-hub-transport"],
  "type": "module",
  "exports": { ".": { "import": "./dist/index.js" } },
  "files": ["dist", "README.md"],
  "scripts": { "build": "tsup src/index.ts --format esm --out-dir dist --clean", "prepack": "npm run build" },
  "peerDependencies": { "@assistants-swarm-hub/transport-sdk": "^5.0.0" }
}
```

The keyword is how the core finds you among its installed dependencies; the
export is what it imports; the peer range is what it checks. No environment
variables: a transport has none.

## Step 2 — Implement four things and export them

Everything the rest of this document describes is the same for every platform,
so the core does it. The host registers you, opens one connection per
assistant from the desired state and again on every change, dedupes shared
chats, assembles and publishes every event, consumes deliveries and drives the
typing indicator, splits and performs sends, hosts the delivery tools, and
shuts all of it down in order.

What is left is your platform, in four pieces:

| You write | It is | Reference |
| --- | --- | --- |
| a **descriptor** | who you are: id, name, the config fields the dashboard renders, your message cap and typing refresh | your `descriptor.ts` |
| a **platform adapter** | `connect()` for one connection: the actions you support, and what arrives reported through the host's hooks | your adapter and connection |
| a **normalizer** | one platform message → the contract's `InboundMessage`, media fetched | your normalizer |
| an **addressing rule** | the structural verdict, per receiving bot | your addressing rule |

```ts
// src/index.ts — the package's default export is the transport
import { defineTransport } from "@assistants-swarm-hub/transport-sdk";

export default defineTransport({
  descriptor,        // { id, name, connectionConfigSchema, maxMessageLength, typingRefreshMs }
  adapter,           // { connect(input, hooks): Promise<PlatformConnection> }
  normalize,         // (raw) => Promise<InboundMessage | null>
  addressing,        // (raw, bot) => Addressing
  tools: { platform: "Signal" },  // how the delivery tools word themselves
});
```

Two rules decide the shape of your adapter:

- **A missing action is a missing method, not a refusal.** `PlatformConnection`
  declares `sendVoice`, `sendPhoto`, `sendFile`, `deleteMessage`, `sendMenu`,
  `editMenu`, `setReaction`, `setChatTitle` and `sendTyping` as optional. Leave
  out what your platform cannot do and the host answers no call and offers
  no tool for it. There are no capability flags anywhere.
- **Report, never decide.** The hooks (`message`, `edited`, `reaction`,
  `menuPress`, `status`) take what the platform said, in the contract's
  vocabulary. Whether an event is a duplicate, who its receivers are, what its
  correlation id is and whether anyone answers are all decided elsewhere.

Your own MCP tools go on the same server through `tools.register(server,
runtime)`, which hands you the running context (`runtime.send`, `runtime.core`,
`runtime.traces`, `runtime.descriptor`). Reacting is the usual case: the emoji a
platform accepts are its own, so each transport registers its own
`set_message_reaction` over the SDK's `reactToMessage`, which owns the part
that is not — the mirror check that refuses a guessed id or the bot's own
message, and the `transport.bot-reaction` record that lets the next turn
remember it. `turnOf` reads the turn your tool is bound to from the call's
`_meta`, `toolRefusal` is the result that says nothing happened, and
`tracedTool` records what the call did on the turn's own correlation.

## Step 3 — Register, receive desired state, reconcile

The host does this for you; what follows is what happens, so you can read a
dashboard and a log.

At boot the host imports every installed package carrying the keyword,
checks the two things above, and **registers** you: an upsert of your
descriptor's id, name and config schemas into the `transports` table. The
operator's decisions on that row — `enabled`, the transport-level config —
survive every re-registration; your identity follows your code.

The answer is your **desired state**: the transport-level config blob and one
entry per assistant connection (`id`, `assistantId`, the opaque `config` the
operator typed into your fields, `enabled`). The host reconciles its
connections to it: it calls `adapter.connect()` for each enabled connection,
restarts one whose config changed, and closes one that is gone or disabled.
A connection that throws is recorded as `error` and retried every fifteen
seconds while the core still wants it; the dashboard shows the message.

On every change — a connection edited, started or stopped, a settings write,
an assistant deleted — the core tells the host directly, and the host
refetches the desired state and reconciles again (serialized, so a burst of
changes collapses). Nothing of this needs a restart; adding a connection in
the dashboard opens it within a second.

## Step 4 — Report what you see

Your connection calls the hooks the host gave it:

| Hook | When | What the host does |
| --- | --- | --- |
| `message(raw)` | any message, addressed or not, from anyone | runs your normalizer; skips an empty one; dedupes a shared chat so one bot forwards and the others only prove presence; runs your addressing rule once per running connection; publishes one `transport.message` event onto the queue |
| `edited({…})` | a message's text changed | publishes `transport.edited` (once per shared chat) |
| `reaction({…})` | someone reacted to one of this assistant's messages with a thumbs up or down | publishes `transport.reaction` — the feedback seam |
| `menuPress({…})` | a feedback-menu button was pressed | asks the core synchronously and resolves with the toast to show; the platform's spinner wants an answer only the flow's outcome can word |
| `status({…})` | the connection became ready, or failed | flips the dashboard's badge; a failure starts the retry loop |

The `InboundMessage` your normalizer returns is the contract's vocabulary:
chat id and kind (direct or shared), the message id and text, the sender,
what it replies to, and media as bytes with a kind. The host turns it into the
event the pipeline consumes; you never build an event yourself.

## Step 5 — Perform the sends

The host asks your connection to act, and reports every performed send as a
`message.delivered` event — which is what the core mirrors and cross-feeds
off. You never report a delivery yourself.

| The host asks | For | Through |
| --- | --- | --- |
| `sendMessage` | every reply the pipeline finishes, split under your `maxMessageLength` at paragraph, line, sentence or word boundaries; each part reported | the reply-delivery event, handed to the host in-process |
| `sendTyping` | from the moment a turn is accepted until it settles, every `typingRefreshMs` | the turn-lifecycle events, handed over the same way |
| `sendVoice`, `sendPhoto`, `sendFile` | a voice reply (with your connection's text fallback when the platform refuses the bubble), generated images (best-effort per image), a browser-run download | the core's outbound port |
| `deleteMessage`, `setChatTitle` | a browsing acknowledgement's cleanup, a provisional title | the same |
| `sendMenu`, `editMenu`, `deleteMessage` | the feedback flow's option menus | the same |

Every id your connection returns is the platform's own, verbatim, as a
string — never parsed into a number. A 64-bit snowflake does not survive
`Number()`, and the store keeps ids as text end to end.

## Step 6 — Host your tools

The host builds one MCP server per transport, registers the two delivery
tools on it (`reply_to_message` and `send_message`, worded with the
`platform` name you give and any `replyToMessage`/`sendMessage` text you
override), then calls your `tools.register(server, runtime)`. The core lists
that server's tools as a managed tool connection of kind `in-process`, scoped
to your source: offered on your turns only, under `<source>__<tool>`, with
the turn's binding delivered to your handler in the call's `_meta`. The
snapshot follows the code — a release that adds a tool offers it after the
restart, without an operator pressing Apply.

## Step 7 — Install it into a core

An operator runs, in their core:

```bash
npm install @your-scope/transport-signal
```

and restarts. In a container, they name the package in `TRANSPORTS` and the
image's entrypoint installs it at boot — see
[Deployment](../operations/deployment.md). Either way the core finds you,
registers you, and your connection section appears in the assistant editor.

To develop against a core checkout next door, link instead:

```bash
cd transport-signal && npm run build && npm link
cd ../ash-core && npm link @your-scope/transport-signal --no-save
```

and restart the core — a transport is boot-time. `npm install` in the core
prunes the link; link again after one.

## Step 8 — Publish

Bump `version` in your `package.json`, push, and let your workflow publish
to the registry (the transports under the org show one that typechecks,
tests, builds, publishes, installs the package back from the registry to
prove it imports, and tags the commit). A new major of the SDK means a new
range in your `peerDependencies` and a rebuild; nothing else about your
package changes with a core release.

## What the dashboard shows for your transport

Nothing in the dashboard is written for a platform. What it shows for yours
comes from your descriptor and the rows the host keeps:

| Surface | What it reads |
| --- | --- |
| Overview → Bots | one block per registered transport titled with your `name`; each connection's state (`starting`, `running` as `@handle`, `error` with your message, `stopped`), with start/stop; a refused package by its package name and the reason |
| The assistant editor | one connection section per transport, its fields rendered from `connectionConfigSchema` (`text`, `secret` write-only with a `…last4` preview, `boolean`) |
| Settings → Transports | the transport-level fields from `transportConfigSchema`, and the enable switch |
| Tools | your MCP server as a managed connection, its tools under your slug |
| Users and Groups, History, Media | every chat, person and file under your source id, with your `name` as the label |
| Debug | your traces (the delivery of every reply, every tool call) on the turn's correlation, next to the core's |

The one convention they rely on: a **scoped ref** is `<source>:<kind>:<id>`,
and `<source>` is your descriptor's id. Keep it stable.
