import { readFileSync } from "node:fs";

import { TRANSPORT_SDK_MAJOR } from "@assistants-swarm-hub/contracts";
import { describe, expect, it } from "vitest";

/**
 * This package's major is the compatibility contract: a transport declares
 * it as a peer, the core refuses a package built on another one. The number
 * the core compares against lives in the contracts; the one a transport
 * installs is this manifest's. They are the same number, or neither side's
 * refusal means anything.
 */
describe("the SDK's major", () => {
  it("is the major the core hosts", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(Number(manifest.version.split(".")[0])).toBe(TRANSPORT_SDK_MAJOR);
  });
});
