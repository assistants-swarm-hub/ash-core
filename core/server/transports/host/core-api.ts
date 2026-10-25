import "server-only";

import type {
  TransportCoreApi,
  TransportDescriptor,
  TransportDesiredState,
} from "@assistants-swarm-hub/contracts";

import { processCallbackPress } from "@/features/self-improvement/server/collect-flows";
import { collectTransport } from "@/features/self-improvement/server/collect-transport";
import { describeError } from "@/lib/describe-error";
import { getSourceMessage } from "@/server/source-store/repository";
import { desiredTransportState, registerTransport } from "@/server/transports/service";

/**
 * What a hosted transport asks of the core, answered by direct calls into
 * the core's services: its registration and desired state, the mirror
 * lookup a reaction tool needs, and the toast a menu press wants back.
 */

/** Register a hosted transport from its descriptor; the answer is its desired state. */
export async function registerHostedTransportRow(
  descriptor: TransportDescriptor,
): Promise<TransportDesiredState> {
  return registerTransport({
    id: descriptor.id,
    name: descriptor.name,
    connectionConfigSchema: descriptor.connectionConfigSchema,
    transportConfigSchema: descriptor.transportConfigSchema ?? [],
  });
}

export function inProcessCoreApi(descriptor: TransportDescriptor): TransportCoreApi {
  const source = descriptor.id;
  return {
    desiredState: () => desiredTransportState(source),

    async lookupMessage(params) {
      const row = await getSourceMessage(
        {
          source,
          chatId: params.chatId,
          assistantId: params.assistantId,
          direct: params.direct,
        },
        params.sourceMessageId,
      );
      return {
        found: row != null,
        role: row ? (row.role === "assistant" ? "assistant" : "user") : null,
        assistantId: row?.assistantId ?? null,
      };
    },

    // Synchronous by design: the platform's button spinner wants an answer
    // only the flow's outcome can word, and the core owns that flow.
    async forwardMenuPress(body) {
      const transport = collectTransport(body.source);
      if (!transport) return { toast: null };
      try {
        const { toast } = await processCallbackPress(
          {
            data: body.data,
            presserUserId: body.user.userId,
            chatId: body.chat.id,
            menuSourceMessageId: body.menuSourceMessageId,
          },
          { source: body.source, assistantId: body.assistantId, transport },
        );
        return { toast };
      } catch (err) {
        console.error("feedback callback processing failed:", describeError(err));
        return { toast: null };
      }
    },
  };
}
