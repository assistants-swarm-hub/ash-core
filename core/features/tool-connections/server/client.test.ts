import { afterEach, describe, expect, it, vi } from "vitest";

import { registerHostedTransport, unregisterHostedTransport } from "@/server/transports/hosted";

import { toolConnectionClient } from "./client";

const remote = vi.hoisted(() => ({ listRemoteTools: vi.fn(), callRemoteTool: vi.fn() }));
vi.mock("@/server/mcp/http-client", () => ({
  listRemoteTools: remote.listRemoteTools,
  callRemoteTool: remote.callRemoteTool,
}));

afterEach(() => unregisterHostedTransport("acme"));

describe("toolConnectionClient", () => {
  it("answers an in-process connection from the hosted transport's own server", async () => {
    const tools = { listTools: vi.fn(async () => []), callTool: vi.fn() };
    registerHostedTransport({
      descriptor: { id: "acme", name: "Acme", connectionConfigSchema: [], maxMessageLength: 1, typingRefreshMs: 1 },
      outbound: {} as never,
      menus: {} as never,
      statuses: () => [],
      tools,
    });
    const client = toolConnectionClient({
      transport: "in-process",
      appScope: "acme",
      endpointUrl: "in-process://acme",
      authHeaders: {},
    });
    await client.listTools();
    expect(tools.listTools).toHaveBeenCalled();
    expect(remote.listRemoteTools).not.toHaveBeenCalled();
  });

  it("refuses an in-process connection whose transport this core does not host", () => {
    expect(() =>
      toolConnectionClient({ transport: "in-process", appScope: "acme", endpointUrl: "in-process://acme", authHeaders: {} }),
    ).toThrow(/acme is not hosted by this core/);
  });

  it("reaches an http connection over the remote client", async () => {
    remote.listRemoteTools.mockResolvedValueOnce([]);
    const endpoint = { transport: "http" as const, appScope: null, endpointUrl: "https://x.test/mcp", authHeaders: {} };
    await toolConnectionClient(endpoint).listTools();
    expect(remote.listRemoteTools).toHaveBeenCalledWith(endpoint);
    await toolConnectionClient(endpoint).callTool("t", { a: 1 }, { m: 1 });
    expect(remote.callRemoteTool).toHaveBeenCalledWith(endpoint, "t", { a: 1 }, { m: 1 });
  });
});
