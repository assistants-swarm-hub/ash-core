/**
 * `@assistants-swarm-hub/transport-sdk` — what a **transport package** is
 * written against, and nothing else.
 *
 * A transport is an npm package the core hosts in its own process: its
 * default export (see {@link defineTransport}) is a descriptor, a platform
 * adapter, a normalizer, an addressing rule, and the words and tools of its
 * own. Everything that is the same for every platform — registering,
 * reconciling connections from the desired state, deduping shared chats,
 * assembling and publishing events, consuming deliveries, splitting and
 * performing sends, hosting the delivery tools — is the core's. See
 * [Adding a transport](https://github.com/assistants-swarm-hub/ash-core/blob/main/docs/development/adding-a-transport.md)
 * for the manual.
 *
 * This package's **major** is the compatibility contract: declare it as a
 * peer dependency, and a core whose interface moved refuses the package by
 * name, with a reason its dashboard shows.
 */

// ---- Declaring the package --------------------------------------------------
export { defineTransport } from "./define";

// ---- The interface: what you implement, what the host hands you -----------
export type {
  AddressingRule,
  BotIdentity,
  ConnectionStatus,
  DeliveryToolTexts,
  InboundMessage,
  MenuGrid,
  Normalizer,
  PlatformAdapter,
  PlatformConnection,
  PlatformHooks,
  RunningConnection,
  SendContext,
  SendOptions,
  SentMessage,
  TransportCoreApi,
  TransportDescriptor,
  TransportPackage,
  TransportRuntime,
  UpdatePublisher,
} from "@assistants-swarm-hub/contracts";

// ---- The contract's shapes those interfaces are written in -----------------
export {
  SOURCE_ID_PATTERN,
  addressingSchema,
  connectionIdentitySchema,
  isSourceId,
  scopedRef,
  sourceIdSchema,
  transportConfigFieldSchema,
  transportMediaSchema,
  transportUserSchema,
  type Addressing,
  type ConnectionIdentity,
  type ScopedRefString,
  type SourceId,
  type TransportConfigField,
  type TransportDesiredState,
  type TransportMedia,
  type TransportMessageLookupResponse,
  type TransportUpdateEvent,
  type TransportUser,
} from "@assistants-swarm-hub/contracts";

// ---- Your own MCP tools: the turn they are bound to, the delivery they report
export {
  readTurnMeta,
  toolDeliveryResult,
  type ToolDelivery,
  type TurnToolMeta,
} from "@assistants-swarm-hub/contracts";
export { toolRefusal, turnOf } from "./tools";
export { toolTrigger, tracedTool } from "./traced-tool";
export { reactToMessage, type ReactionOutcome, type ReactionStatus } from "./reactions";

// ---- Traces: what your tools did, in the core's one debug explorer ---------
export type { SourceTraceClient } from "@assistants-swarm-hub/contracts";

// ---- Media: the bounded JPEG the core's vision endpoints accept ------------
export {
  VISION_MAX_DIMENSION,
  normalizeImageForChat,
  type ImagePayload,
} from "@assistants-swarm-hub/media";

// ---- Documents: which files travel whole as the `document` kind, and how large
export {
  DOCUMENT_FORMATS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MEDIA_KIND,
  documentFormatOf,
  isDocumentFile,
  type DocumentFormat,
} from "@assistants-swarm-hub/contracts";

// ---- Your own logs want this too -------------------------------------------
// It is what turns a bare `fetch failed` into the connection error underneath.
export { describeError } from "./errors";
