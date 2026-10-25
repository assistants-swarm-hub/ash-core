import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  TRANSPORT_SDK_MAJOR,
  sourceIdSchema,
  transportConfigFieldSchema,
  type TransportPackage,
} from "@assistants-swarm-hub/contracts";
import { minVersion } from "semver";
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
 *   on the dashboard's roster by package name.
 * - The SDK major is the compatibility contract: a package declares the
 *   `@assistants-swarm-hub/transport-sdk` it was built against as a peer
 *   dependency, and one whose lowest accepted version is on another major
 *   than {@link TRANSPORT_SDK_MAJOR} is refused by name — the interface moved
 *   incompatibly, and importing it would fail in stranger ways.
 *
 * The shape is checked, not the behavior: a function is a function here, and
 * the host calls it against the contracts' {@link TransportPackage} types.
 */

/** The `keywords` entry that marks an installed package as a transport. */
export const TRANSPORT_KEYWORD = "assistants-swarm-hub-transport";

const aFunction = <T>() =>
  z.custom<T>((value) => typeof value === "function", { message: "expected a function" });

type AnyFunction = (...args: never[]) => unknown;

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
      register: aFunction<NonNullable<TransportPackage["tools"]>["register"]>().optional(),
    })
    .optional(),
});

export interface LoadedTransportPackage {
  /** The npm package name. */
  name: string;
  version: string;
  /** Where it was found — a linked checkout shows as its real path's parent. */
  dir: string;
  transport: TransportPackage;
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

const SDK_PACKAGE = "@assistants-swarm-hub/transport-sdk";

const packageManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
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

/**
 * The `node_modules` directories Node searches from `from` upward, then the
 * entries of `NODE_PATH`, as Node's own resolver takes them — which is how
 * the image hands the host the packages its entrypoint installed into a
 * directory of their own, away from the traced `node_modules` the server
 * runs on.
 */
export function nodeModulesChain(from: string, nodePath = process.env.NODE_PATH): string[] {
  const chain: string[] = [];
  let current = path.resolve(from);
  for (;;) {
    if (path.basename(current) !== "node_modules") chain.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const entry of (nodePath ?? "").split(path.delimiter)) {
    if (entry) chain.push(path.resolve(entry));
  }
  return chain;
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

/**
 * Import one package directory and check that its default export is a
 * transport — after checking the SDK major it declares, so a package built
 * for another interface is refused with the reason rather than imported.
 */
async function loadTransportPackage(
  packageDir: string,
  manifest: PackageManifest,
): Promise<LoadedTransportPackage> {
  const refusal = sdkMajorRefusal(manifest);
  if (refusal) throw new Error(refusal);
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
    // Shape-checked above; the behavior is the package's. The host calls it
    // against the interface, which is what the loose function checks stand for.
    transport: parsed.data as unknown as TransportPackage,
  };
}

/**
 * Why the package's declared SDK range cannot be hosted here, or null. A
 * package that declares no SDK peer is not judged: it may be built on the
 * types alone, and the export check below is what then protects the host.
 */
function sdkMajorRefusal(manifest: PackageManifest): string | null {
  const range = manifest.peerDependencies?.[SDK_PACKAGE];
  if (!range) return null;
  const lowest = minVersion(range, true);
  if (!lowest) return `declares an unreadable ${SDK_PACKAGE} range "${range}"`;
  if (lowest.major === TRANSPORT_SDK_MAJOR) return null;
  return (
    `built for ${SDK_PACKAGE} ${lowest.major} ("${range}"); this core hosts ${TRANSPORT_SDK_MAJOR} — ` +
    "update whichever side is behind"
  );
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
