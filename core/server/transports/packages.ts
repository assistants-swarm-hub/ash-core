import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sourceIdSchema, transportConfigFieldSchema } from "@assistants-swarm-hub/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The transport packages installed into this core (`docs/TODO.md`,
 * "Transports as packages the core hosts in-process").
 *
 * A transport is an ordinary npm dependency: the operator runs `npm install
 * <package>` (a developer, `npm link` to their checkout), restarts, and the
 * core finds it here — every installed package whose manifest carries the
 * {@link TRANSPORT_KEYWORD} keyword is imported and its default export
 * checked against the transport shape: the same four pieces plus tools that
 * `startTransportService` takes today. Running them (connections,
 * deliveries, the per-transport MCP server) is the host's job, built on top
 * of this.
 *
 * Two things are deliberate:
 *
 * - Discovery walks the `node_modules` directories Node itself would search
 *   from the working directory, so what `npm install` put there is what
 *   loads — in the checkout and in the image alike — and nothing names a
 *   transport in this repository.
 * - A package that will not load is reported, never thrown: one broken
 *   transport must not take the core down with it. The host puts the failure
 *   on the dashboard's roster, where a refused registration shows today.
 *
 * The functions are typed loosely for now: the core does not yet depend on
 * the SDK's interface types (`PlatformAdapter`, `Normalizer`,
 * `AddressingRule`); the host wires them against those when it lands.
 */

/** The `keywords` entry that marks an installed package as a transport. */
export const TRANSPORT_KEYWORD = "assistants-swarm-hub-transport";

const aFunction = <T>() =>
  z.custom<T>((value) => typeof value === "function", { message: "expected a function" });

type AnyFunction = (...args: never[]) => unknown;

/**
 * A transport's own tools join the server the host builds for it; the
 * second argument is the running context (`runtime.send`, `runtime.core`),
 * typed once the host exists.
 */
type ToolRegistrar = (server: McpServer, runtime: unknown) => void;

export const transportModuleSchema = z.object({
  descriptor: z.object({
    id: sourceIdSchema,
    name: z.string().min(1),
    connectionConfigSchema: z.array(transportConfigFieldSchema),
    transportConfigSchema: z.array(transportConfigFieldSchema).optional(),
    maxMessageLength: z.number().int().positive(),
    typingRefreshMs: z.number().int().positive(),
  }),
  adapter: z.object({ connect: aFunction<AnyFunction>() }),
  normalize: aFunction<AnyFunction>(),
  addressing: aFunction<AnyFunction>(),
  tools: z
    .object({
      platform: z.string().min(1),
      register: aFunction<ToolRegistrar>().optional(),
    })
    .optional(),
});

export type TransportModule = z.infer<typeof transportModuleSchema>;

export interface LoadedTransportPackage {
  /** The npm package name. */
  name: string;
  version: string;
  /** Where it was found — a linked checkout shows as its real path's parent. */
  dir: string;
  transport: TransportModule;
}

export interface FailedTransportPackage {
  name: string;
  dir: string;
  error: string;
}

export interface TransportPackages {
  /** The `node_modules` directories searched, nearest first. */
  searched: string[];
  loaded: LoadedTransportPackage[];
  failed: FailedTransportPackage[];
}

const packageManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  exports: z.unknown().optional(),
  module: z.string().optional(),
  main: z.string().optional(),
});

type PackageManifest = z.infer<typeof packageManifestSchema>;

/**
 * Find and load every installed transport package. A core with none
 * installed is an empty, successful result. The nearest `node_modules` wins
 * a name, as it does for Node; packages are visited in sorted order so the
 * roster and the log are stable between boots.
 */
export async function loadTransportPackages(
  searched: string[] = nodeModulesChain(process.cwd()),
): Promise<TransportPackages> {
  const loaded: LoadedTransportPackage[] = [];
  const failed: FailedTransportPackage[] = [];
  const seenNames = new Set<string>();
  const seenSourceIds = new Map<string, string>();
  for (const dir of searched) {
    for (const packageDir of await transportPackageDirs(dir)) {
      let name = path.relative(dir, packageDir).split(path.sep).join("/");
      try {
        const manifest = await readPackageManifest(packageDir);
        name = manifest.name;
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        const pkg = await loadTransportPackage(packageDir, manifest);
        const id = pkg.transport.descriptor.id;
        const owner = seenSourceIds.get(id);
        if (owner) throw new Error(`source id "${id}" is already taken by ${owner}`);
        seenSourceIds.set(id, name);
        loaded.push(pkg);
      } catch (error) {
        failed.push({ name, dir, error: errorText(error) });
      }
    }
  }
  return { searched, loaded, failed };
}

/** The `node_modules` directories Node searches from `from` upward. */
export function nodeModulesChain(from: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(from);
  for (;;) {
    if (path.basename(current) !== "node_modules") chain.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * The package directories under one `node_modules` whose manifest carries
 * the transport keyword — scoped packages included, links followed. A
 * directory that is not a package, or whose manifest will not parse, is not
 * a transport and is skipped silently; it is somebody else's dependency.
 */
async function transportPackageDirs(nodeModules: string): Promise<string[]> {
  const found: string[] = [];
  for (const packageDir of await packageDirs(nodeModules)) {
    const manifest = await readPackageManifest(packageDir).catch(() => null);
    if (manifest?.keywords?.includes(TRANSPORT_KEYWORD)) found.push(packageDir);
  }
  return found.sort();
}

async function packageDirs(nodeModules: string): Promise<string[]> {
  const entries = await fs.readdir(nodeModules, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const full = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      const scoped = await fs.readdir(full, { withFileTypes: true }).catch(() => []);
      for (const inner of scoped) {
        if (inner.isDirectory() || inner.isSymbolicLink()) dirs.push(path.join(full, inner.name));
      }
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

/** Import one package directory and check that its default export is a transport. */
async function loadTransportPackage(
  packageDir: string,
  manifest: PackageManifest,
): Promise<LoadedTransportPackage> {
  const entry = path.resolve(packageDir, entryOf(manifest));
  // Left alone by both bundlers: the package is not part of the build, and
  // the file URL keeps Node's own resolution (a link resolves to its target,
  // whose dependencies are its own).
  const imported: unknown = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(entry).href
  );
  const candidate =
    imported && typeof imported === "object" ? (imported as { default?: unknown }).default : undefined;
  const parsed = transportModuleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`default export is not a transport: ${z.prettifyError(parsed.error)}`);
  }
  return {
    name: manifest.name,
    version: manifest.version ?? "0.0.0",
    dir: path.dirname(packageDir),
    transport: parsed.data,
  };
}

async function readPackageManifest(packageDir: string): Promise<PackageManifest> {
  const raw = await fs.readFile(path.join(packageDir, "package.json"), "utf8");
  return packageManifestSchema.parse(JSON.parse(raw));
}

/**
 * The package's ESM entry, relative to its directory: the `.` export under
 * the `import`/`node`/`default` conditions (the shape `tsup` publishes), else
 * `module`, else `main`, else `index.js`. Resolved by hand because
 * `require.resolve` refuses a package whose exports have no `require`
 * condition, and `import.meta.resolve` cannot be told where to start.
 */
function entryOf(manifest: PackageManifest): string {
  return exportTarget(manifest.exports) ?? manifest.module ?? manifest.main ?? "index.js";
}

function exportTarget(exports: unknown): string | null {
  if (typeof exports === "string") return exports;
  if (!exports || typeof exports !== "object") return null;
  const record = exports as Record<string, unknown>;
  if ("." in record) return exportTarget(record["."]);
  for (const condition of ["import", "node", "default"]) {
    if (condition in record) return exportTarget(record[condition]);
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
