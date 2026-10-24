import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { TransportRuntime } from "@assistants-swarm-hub/contracts";

import { InProcessTransport } from "@/server/mcp/in-process-transport";

import { loadTransportPackages, nodeModulesChain, TRANSPORT_KEYWORD } from "./packages";

/**
 * A project's `node_modules` as `npm install` leaves it: the transport
 * package, a package with the keyword that is not a transport, a package
 * without the keyword, and a copy of zod. The zod copy stands in for a
 * linked checkout — `npm link` resolves a package's dependencies from its
 * own folder, so its tool input shapes come from a zod the core did not load,
 * and the core's MCP server must still validate with them.
 */
const FIXTURE = path.resolve(__dirname, "../../test/fixtures/transports/acme");
const ACME = "@acme/transport-acme";
const BROKEN = "@acme/transport-broken";

const coreZodDir = path.dirname(createRequire(import.meta.url).resolve("zod/package.json"));

let project: string;
let nodeModules: string;

async function writePackage(name: string, manifest: Record<string, unknown>, index: string): Promise<void> {
  const dir = path.join(nodeModules, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.1", type: "module", main: "index.js", ...manifest }));
  await fs.writeFile(path.join(dir, "index.js"), index);
}

beforeAll(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "ash-project-"));
  nodeModules = path.join(project, "node_modules");
  await fs.cp(FIXTURE, path.join(nodeModules, ACME), { recursive: true });
  await fs.cp(coreZodDir, path.join(nodeModules, "zod"), { recursive: true });
  await writePackage(BROKEN, { keywords: [TRANSPORT_KEYWORD] }, "export default { descriptor: { id: 'Broken Id' } };\n");
  await writePackage("bystander", { keywords: ["unrelated"] }, "export default { descriptor: { id: 'bystander' } };\n");
});

afterAll(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("nodeModulesChain", () => {
  it("lists the directories Node searches, nearest first", () => {
    const chain = nodeModulesChain(path.join(project, "core"));
    expect(chain[0]).toBe(path.join(project, "core", "node_modules"));
    expect(chain[1]).toBe(nodeModules);
    expect(chain.at(-1)).toBe(path.join(path.parse(project).root, "node_modules"));
  });
});

describe("loadTransportPackages", () => {
  it("loads the keyword-marked package through its default export and reports the one that is not a transport", async () => {
    const result = await loadTransportPackages([nodeModules]);
    expect(result.searched).toEqual([nodeModules]);
    expect(result.loaded.map((pkg) => pkg.name)).toEqual([ACME]);
    const [acme] = result.loaded;
    expect(acme.version).toBe("0.1.0");
    expect(acme.dir).toBe(path.join(nodeModules, "@acme"));
    expect(acme.transport.descriptor).toMatchObject({ id: "acme", name: "Acme Chat" });
    expect(acme.transport.tools?.platform).toBe("Acme");
    expect(result.failed).toEqual([
      { name: BROKEN, dir: nodeModules, error: expect.stringMatching(/default export is not a transport[\s\S]*source id/) },
    ]);
  });

  it("is an empty result, not a failure, where nothing is installed", async () => {
    const missing = path.join(project, "elsewhere", "node_modules");
    await expect(loadTransportPackages([missing])).resolves.toEqual({ searched: [missing], loaded: [], failed: [] });
  });

  it("lets the nearest node_modules win a name, as Node does", async () => {
    const nearer = path.join(project, "core", "node_modules");
    await fs.cp(path.join(nodeModules, ACME), path.join(nearer, ACME), { recursive: true });
    await fs.writeFile(
      path.join(nearer, ACME, "package.json"),
      JSON.stringify({ name: ACME, version: "9.9.9", type: "module", keywords: [TRANSPORT_KEYWORD], main: "index.js" }),
    );
    const { loaded } = await loadTransportPackages([nearer, nodeModules]);
    expect(loaded.map((pkg) => [pkg.name, pkg.version])).toEqual([[ACME, "9.9.9"]]);
  });

  it("resolves a package's own zod when it has one, as a linked checkout does", async () => {
    const entry = pathToFileURL(path.join(nodeModules, ACME, "index.js")).href;
    const fixture = (await import(/* @vite-ignore */ entry)) as { sameZod: (candidate: unknown) => boolean };
    expect(fixture.sameZod(z)).toBe(false);
  });

  it("registers the package's tools on a core-built MCP server and validates their input across zod copies", async () => {
    const { loaded } = await loadTransportPackages([nodeModules]);
    const server = new McpServer({ name: "acme-transport", version: "1.0.0" });
    loaded[0].transport.tools?.register?.(server, {} as TransportRuntime);

    const [serverSide, clientSide] = InProcessTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["acme__echo"]);
      const schema = tools[0].inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      expect(Object.keys(schema.properties ?? {})).toEqual(["chatId", "text"]);
      expect(schema.required).toEqual(["chatId", "text"]);

      const ok = await client.callTool({ name: "acme__echo", arguments: { chatId: "42", text: "hi" } });
      expect(ok.content).toEqual([{ type: "text", text: "42: hi" }]);

      const bad = await client
        .callTool({ name: "acme__echo", arguments: { chatId: 7, text: "hi" } })
        .then((result) => result, (error: unknown) => error);
      const refused = bad instanceof Error || (bad as { isError?: boolean }).isError === true;
      expect(refused).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
