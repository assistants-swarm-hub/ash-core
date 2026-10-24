import "server-only";

import {
  callRemoteTool,
  listRemoteTools,
  type DiscoveredTool,
  type RemoteEndpoint,
} from "@/server/mcp/http-client";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import { hostedTransport } from "@/server/transports/hosted";

import type { ToolTransport } from "./schema";

/** The two things the core ever asks a connection's server: what it offers, and one call. */
export interface ToolConnectionClient {
  listTools(): Promise<DiscoveredTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<McpToolCallResult>;
}

/**
 * How a connection's MCP server is reached, decided by its kind: an
 * `in-process` connection is the managed row of a transport this core hosts,
 * answered by the server the host built for it; everything else is a remote
 * endpoint over HTTP. Discovery, the managed reconcile and the turn's tool
 * call all go through here, so none of them knows the difference.
 */
export function toolConnectionClient(
  connection: RemoteEndpoint & { transport: ToolTransport; appScope: string | null },
): ToolConnectionClient {
  if (connection.transport === "in-process") {
    const hosted = connection.appScope ? hostedTransport(connection.appScope) : null;
    if (!hosted?.tools) {
      const what = connection.appScope ?? "this connection's transport";
      throw new Error(`${what} is not hosted by this core`);
    }
    return hosted.tools;
  }
  return {
    listTools: () => listRemoteTools(connection),
    callTool: (name, args, meta) => callRemoteTool(connection, name, args, meta),
  };
}
