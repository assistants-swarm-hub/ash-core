import "server-only";

import {
  CONTRACT_MAJOR,
  type TransportCoreApi,
  type TransportDescriptor,
  type TransportDesiredState,
} from "@assistants-swarm-hub/contracts";

import { processCallbackPress } from "@/features/self-improvement/server/collect-flows";
import { collectTransport } from "@/features/self-improvement/server/collect-transport";
import { describeError } from "@/lib/describe-error";
import { getSourceMessage } from "@/server/source-store/repository";
import { desiredTransportState, registerTransport } from "@/server/transports/service";

/**
 * What a hosted transport asks of the core, answered by direct calls into
 * the services the internal transport routes used to front. Same answers,
 * same wording, no HTTP: the routes stay only for a transport still run as
 * its own service.
 */

/**
 * Register a hosted transport: the same upsert a service's registration
 * does, with no base URL (nothing calls it back) and the core's own
 * contract major (the host IS the core's runtime). The answer is the
 * desired state, as it is over the wire.
 */
export async function registerHostedTransportRow(
  descriptor: TransportDescriptor,
): Promise<TransportDesiredState> {
  return registerTransport({
    id: descriptor.id,
    name: descriptor.name,
    contractMajor: CONTRACT_MAJOR,
    baseUrl: "",
    mcpPath: "in-process",
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
