import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { SourceTraceClient } from "./trace";
import type { Addressing, ConnectionIdentity } from "./source-events";
import type {
  TransportCallbackRequest,
  TransportConfigField,
  TransportDesiredState,
  TransportMedia,
  TransportMessageLookupResponse,
  TransportUpdateEvent,
  TransportUser,
} from "./transport-events";

/**
 * The interface between the core and a transport package (`docs/TODO.md`,
 * "Transports as packages the core hosts in-process").
 *
 * A transport is an npm package whose default export is a
 * {@link TransportPackage}: who it is, how to open one connection to its
 * platform, how to read one platform message into the contract's shape, and
 * the structural addressing verdict. The core hosts it — registers it,
 * reconciles its connections from the desired state, dedupes shared chats,
 * assembles and publishes every event, consumes deliveries, splits and
 * performs sends, hosts the delivery tools — and hands it a
 * {@link TransportRuntime} for the tools of its own.
 *
 * The division is deliberate: everything here is judgement about a PLATFORM,
 * and everything the host keeps is judgement about the CONTRACT. These are
 * TypeScript interfaces, not wire schemas: nothing in this file crosses a
 * process boundary, which is why it lives next to the wire rather than in it.
 */

/**
 * The transport-sdk major this core hosts. A transport package declares the
 * SDK it was built against as a peer dependency; the host reads that range,
 * and a package whose lowest accepted version is on another major is refused
 * by name, with a reason the dashboard shows — the interface moved
 * incompatibly between majors, and running it would fail in stranger ways.
 * The SDK's own package version pins its major to this number in a test.
 */
export const TRANSPORT_SDK_MAJOR = 5;

/** Who this transport is, as the dashboard learns it when the package loads. */
export interface TransportDescriptor {
  /** The source id: a short lowercase slug, the prefix of every scoped ref. */
  id: string;
  /** What the dashboard calls it. */
  name: string;
  /** The fields the assistant editor renders for one connection. */
  connectionConfigSchema: TransportConfigField[];
  /** Transport-wide settings, usually none. */
  transportConfigSchema?: TransportConfigField[];
  /** The platform's message length cap, in UTF-16 code units. */
  maxMessageLength: number;
  /** How often to refresh the typing indicator; the platform decides. */
  typingRefreshMs: number;
}

/** The bot account one connection runs as. */
export interface BotIdentity {
  /** The bot's platform id, verbatim — never parsed. */
  id: string;
  identity: ConnectionIdentity;
}

/**
 * One inbound message in the contract's vocabulary, with the platform's
 * wire format already read off. The host turns this into the event.
 */
export interface InboundMessage {
  chatId: string;
  /** A direct conversation (per-assistant stream) or a shared one. */
  direct: boolean;
  chatTitle?: string | null;
  /** The platform's own name for the chat kind, when it has one. */
  chatType?: string | null;
  sourceMessageId: string;
  /** The text the model reads: message text, caption, or a media note. */
  content: string;
  sentAt: string;
  threadId?: string | null;
  sender: TransportUser;
  replyTo?: {
    sourceMessageId: string;
    hasMedia: boolean;
    text: string | null;
    quote?: string | null;
    author: TransportUser | null;
    /** Set when the quoted message was written by one of this deployment's bots. */
    authorPlatformId?: string | null;
  } | null;
  media?: TransportMedia | null;
}

/**
 * The structural addressing verdict for one receiving bot, computed from the
 * platform's own wire shape. Called once per running connection.
 */
export type AddressingRule<TRaw> = (raw: TRaw, bot: BotIdentity) => Addressing;

/** Turn one platform message into the contract's shape. Media included. */
export type Normalizer<TRaw> = (raw: TRaw) => Promise<InboundMessage | null>;

/** What a delivered message looks like, whatever the platform. */
export interface SentMessage {
  sourceMessageId: string;
  /** What the platform actually attached, which is not always what was asked. */
  replyToSourceMessageId: string | null;
}

/** Options every send accepts; a platform ignores what it does not have. */
export interface SendOptions {
  replyToSourceMessageId?: string | null;
  threadId?: string | null;
  silent?: boolean;
  /** Ids the platform may render as links, resolved by the core. */
  linkableSourceMessageIds?: readonly string[];
}

/** A plain button grid; the platform renders it however it can. */
export type MenuGrid = { text: string; callbackData: string }[][];

/**
 * One live connection to the platform: what the host can ask it to do.
 * Everything here is an ACTION — the events flow the other way, through the
 * hooks passed to {@link PlatformAdapter.connect}.
 *
 * A platform that lacks an action leaves the method undefined rather than
 * implementing a refusal: the host then offers no tool and answers no port
 * call for it, which is what "no capability flags" means in practice.
 */
export interface PlatformConnection {
  /** Who this connection is on the platform; known once it is ready. */
  identity(): BotIdentity | null;
  sendMessage(chatId: string, text: string, opts?: SendOptions): Promise<SentMessage>;
  sendVoice?(
    chatId: string,
    voice: { base64: string; filename: string; text: string },
    opts?: SendOptions,
  ): Promise<{ sourceMessageId: string; asVoice: boolean }>;
  sendPhoto?(
    chatId: string,
    image: { base64: string; filename: string },
    opts?: SendOptions,
  ): Promise<{ sourceMessageId: string; mediaId?: string | null }>;
  sendFile?(
    chatId: string,
    file: { base64: string; filename: string; mime?: string | null },
    opts?: SendOptions & { caption?: string | null },
  ): Promise<{ sourceMessageId: string }>;
  deleteMessage?(chatId: string, sourceMessageId: string): Promise<void>;
  sendMenu?(
    chatId: string,
    menu: { text: string; keyboard: MenuGrid; replyToSourceMessageId: string },
  ): Promise<{ sourceMessageId: string }>;
  editMenu?(
    chatId: string,
    sourceMessageId: string,
    menu: { text: string; keyboard: MenuGrid | null },
  ): Promise<void>;
  /**
   * Set (or, with a null emoji, clear) this bot's one reaction badge.
   * `options` carries whatever the platform's own tool offers on top —
   * a big animated variant, say — and a platform with none ignores it.
   */
  setReaction?(
    chatId: string,
    sourceMessageId: string,
    emoji: string | null,
    options?: Record<string, unknown>,
  ): Promise<void>;
  setChatTitle?(chatId: string, title: string): Promise<{ title: string }>;
  sendTyping?(chatId: string, threadId?: string | null): void;
  /** Whether a chat is a direct one; the core's refs do not carry the kind. */
  isDirectChat(chatId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** How a connection reports what happened, back into the host. */
export interface PlatformHooks<TRaw> {
  /** A message arrived. The host normalizes, dedupes and forwards it. */
  message(raw: TRaw): void;
  /** A message's text changed. */
  edited(input: {
    chatId: string;
    direct: boolean;
    sourceMessageId: string;
    content: string;
    editedAt: string;
  }): void;
  /** Someone reacted to one of this assistant's messages. */
  reaction(input: {
    chatId: string;
    direct: boolean;
    sourceMessageId: string;
    reaction: "up" | "down";
    user: TransportUser;
  }): void;
  /** A feedback-menu button was pressed; the answer is the toast to show. */
  menuPress(input: {
    chatId: string;
    direct: boolean;
    menuSourceMessageId: string;
    data: string;
    user: TransportUser;
  }): Promise<{ toast: string | null }>;
  /** The connection's state changed (ready, failed, reconnecting). */
  status(input: { state: "running" | "error"; error?: string | null }): void;
}

/** Everything the platform layer is: how to open one connection. */
export interface PlatformAdapter<TRaw> {
  /**
   * Open a connection for one assistant. Resolve once it is started —
   * "ready" is reported through `hooks.status`, so a platform with a
   * handshake need not block here.
   */
  connect(
    input: { connectionId: string; assistantId: string; config: Record<string, unknown> },
    hooks: PlatformHooks<TRaw>,
  ): Promise<PlatformConnection>;
  /** The platform's own words for a failure, for relaying to the operator. */
  errorText?(err: unknown): string;
}

/** What a connection is doing, as the dashboard reports it. */
export interface ConnectionStatus {
  connectionId: string;
  assistantId: string;
  state: "starting" | "running" | "stopped" | "error";
  username: string | null;
  since: string | null;
  error: string | null;
}

// ---- What the host hands a transport's own tools ----------------------------

/** The roster a delivered event carries, for the core's cross-feed. */
export interface RunningConnection {
  assistantId: string;
  botId: string;
  identity: { botUsername: string; botDisplayName: string };
}

/** The producer every update a transport sees is published through. */
export interface UpdatePublisher {
  publish(event: TransportUpdateEvent): Promise<void>;
  close(): Promise<void>;
}

/** What a send needs: who is running, which connection acts, where to report. */
export interface SendContext {
  descriptor: TransportDescriptor;
  publisher: UpdatePublisher;
  running: () => RunningConnection[];
  /** The connection to send through, for one assistant. */
  connectionFor: (assistantId: string | null) => PlatformConnection;
  /** Called when a delivered report could not be published; the send stands. */
  onReportFailure?: (sourceMessageId: string, error: unknown) => void;
}

/**
 * What a transport asks of the core: the mirror lookup a reaction tool
 * needs, the toast a menu press wants back, and its own desired state.
 */
export interface TransportCoreApi {
  desiredState(): Promise<TransportDesiredState>;
  /** Ask the core's mirror about one message (the reaction tool's pre-check). */
  lookupMessage(params: {
    chatId: string;
    sourceMessageId: string;
    assistantId: string | null;
    direct: boolean;
  }): Promise<TransportMessageLookupResponse>;
  /** Forward a menu press and get the toast to answer with. */
  forwardMenuPress(body: TransportCallbackRequest): Promise<{ toast: string | null }>;
}

/**
 * The server a transport's own tools register on: the host's `McpServer`,
 * named by the one method a registrar calls rather than by the class. The
 * class carries private fields, so two copies of the MCP SDK — a linked
 * checkout resolving its own, a core built against another — would be
 * two incompatible types for the same object; the method's shape is one.
 */
export type TransportToolServer = Pick<McpServer, "registerTool">;

/** How the delivery tools word themselves for one platform. */
export interface DeliveryToolTexts {
  /** How the platform names itself in a tool description ("Matrix"). */
  platform: string;
  replyToMessage?: string;
  sendMessage?: string;
}

/**
 * The running context a transport's own tools receive: everything a hosted
 * tool might need to act and to record what it did.
 */
export interface TransportRuntime {
  descriptor: TransportDescriptor;
  core: TransportCoreApi;
  updates: UpdatePublisher;
  send: SendContext;
  /**
   * The transport's one trace client. Anything a transport records — its
   * own MCP tools included — goes through this, so every trace it emits is
   * built the same way and lands on the turn it belongs to.
   */
  traces: SourceTraceClient;
  statuses: () => ConnectionStatus[];
  /** The connection to act through for one assistant; null means whichever runs. */
  connectionFor: (assistantId: string | null) => PlatformConnection;
}

/**
 * What a transport package's default export is: the four pieces plus,
 * optionally, how its delivery tools speak and the tools of its own.
 */
export interface TransportPackage<TRaw = unknown> {
  descriptor: TransportDescriptor;
  adapter: PlatformAdapter<TRaw>;
  normalize: Normalizer<TRaw>;
  addressing: AddressingRule<TRaw>;
  /**
   * How the delivery tools word themselves, and any tools of the platform's
   * own to register alongside them on the server the host builds for this
   * transport. A transport with no extra tools passes only `platform`.
   */
  tools?: DeliveryToolTexts & {
    register?: (server: TransportToolServer, runtime: TransportRuntime) => void;
  };
}
