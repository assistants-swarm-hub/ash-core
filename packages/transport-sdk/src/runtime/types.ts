/**
 * The platform interface a transport implements. Defined once, in
 * `@assistants-swarm-hub/contracts` (`transport-interface.ts`), because the
 * core hosts transport packages against the very same types; re-exported
 * here so a transport built on this SDK keeps importing them from one place.
 */
export type {
  AddressingRule,
  BotIdentity,
  ConnectionStatus,
  InboundMessage,
  MenuGrid,
  Normalizer,
  PlatformAdapter,
  PlatformConnection,
  PlatformHooks,
  SendOptions,
  SentMessage,
  TransportDescriptor,
} from "@assistants-swarm-hub/contracts";
