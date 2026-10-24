# `@assistants-swarm-hub/transport-sdk`

What a **transport package** is written against: the interface a messaging
platform (Signal, Matrix, Slack, …) is connected to an
[assistants-swarm-hub][core] core through, and the few helpers a transport's
own tools call.

A transport is an npm package the core **hosts in its own process**. Its
default export is a descriptor, a platform adapter, a normalizer, an
addressing rule, and the words and tools of its own. Everything that is the
same for every platform — registering, reconciling connections from the
desired state, deduping shared chats, assembling and publishing events,
consuming deliveries, splitting and performing sends, hosting the delivery
tools — is the core's. An operator installs your package into their core with
`npm install`, restarts, and you appear on their dashboard; the core needs
**no changes** to accept you.

- **The manual**: [Adding a transport][manual] walks the interface in the
  order you meet it, with a worked example.

## Install

The package is published to **GitHub Packages**, so npm needs to know where to
look for the `@assistants-swarm-hub` scope. In your project:

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

Then:

```bash
npm install --save-peer @assistants-swarm-hub/transport-sdk
npm install --save-dev tsup typescript
```

The SDK is a **peer** dependency of your package, and its major is the
compatibility contract: the core you are installed into checks the range you
declare against the SDK it was built with, and refuses a package that does not
fit — by name, with a reason its dashboard shows. `zod` and
`@modelcontextprotocol/sdk` are peers of this package in turn, so your tools'
input shapes and the server they register on agree.

## Write the package

```ts
// src/transport.ts
import { defineTransport } from "@assistants-swarm-hub/transport-sdk";

export default defineTransport({
  descriptor,   // { id, name, connectionConfigSchema, maxMessageLength, typingRefreshMs }
  adapter,      // { connect(input, hooks): Promise<PlatformConnection> }
  normalize,    // (raw) => Promise<InboundMessage | null>
  addressing,   // (raw, bot) => Addressing
  tools: {
    platform: "Signal",            // how the delivery tools word themselves
    register(server, runtime) {}, // your own MCP tools, on the server the host builds for you
  },
});
```

Build it to ESM (`tsup src/transport.ts --format esm`), point `exports` at the
output, and mark the package as a transport so the core finds it among its
installed dependencies:

```json
{
  "keywords": ["assistants-swarm-hub-transport"],
  "exports": { ".": { "import": "./dist/transport.js" } },
  "peerDependencies": { "@assistants-swarm-hub/transport-sdk": "^5.0.0" }
}
```

Two rules decide the shape of your adapter:

- **A missing action is a missing method, not a refusal.** `PlatformConnection`
  declares `sendVoice`, `sendPhoto`, `sendFile`, `deleteMessage`, `sendMenu`,
  `editMenu`, `setReaction`, `setChatTitle` and `sendTyping` as optional. Leave
  out what your platform cannot do and the host offers no tool and answers no
  call for it. There are no capability flags anywhere.
- **Report, never decide.** The hooks (`message`, `edited`, `reaction`,
  `menuPress`, `status`) take what the platform said, in the contract's
  vocabulary. Whether an event is a duplicate, who its receivers are, what its
  correlation id is and whether anyone answers are all decided by the core.

Your own tools go on the same server through `tools.register(server, runtime)`,
which hands you the running context (`runtime.send`, `runtime.core`,
`runtime.traces`, `runtime.descriptor`). Reacting is the usual case: the emoji
a platform accepts are its own, so each transport registers its own
`set_message_reaction` over this package's `reactToMessage`, which owns the
part that is not — the mirror check that refuses a guessed id or the bot's
own message, and the record that lets the next turn remember it. `turnOf`,
`toolRefusal` and `tracedTool` are the binding check, the refusal shape and
the trace every hosted tool uses.

## Develop against a local core

Link your checkout into the core's `node_modules` and restart it:

```bash
cd your-transport && npm link
cd ../ash-core && npm link your-transport --no-save
```

A linked package resolves its dependencies from its own folder, which is fine:
the host validates your tools' input shapes with whichever zod you brought.

## Versioning

This package's **major** is what the core checks. It moves when the interface
moves incompatibly — a hook's shape, a connection method's signature, what
the runtime hands your tools. Minor and patch versions add and fix without
breaking a package built on the same major.

[core]: https://github.com/assistants-swarm-hub/ash-core
[manual]: https://github.com/assistants-swarm-hub/ash-core/blob/main/docs/development/adding-a-transport.md
