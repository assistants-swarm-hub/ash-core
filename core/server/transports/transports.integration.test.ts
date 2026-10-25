import type { TransportRegistration } from "@assistants-swarm-hub/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";

import { desiredTransportState, isRegisteredTransport, listTransports, registerTransport } from "./service";

/**
 * Registration is open (user decision, 2026-09-02): a transport the core has
 * never heard of is registered by the host from its package's descriptor —
 * no list in the core to extend. Whether a package may be hosted at all is
 * the loader's call (its SDK major), before any row exists.
 */

let store: TestStoreDb;

beforeAll(async () => {
  store = await startTestStoreDb();
});

afterAll(async () => {
  await store?.stop();
});

beforeEach(async () => {
  await store.truncate();
});

function registration(overrides: Partial<TransportRegistration> = {}): TransportRegistration {
  return {
    id: "signal",
    name: "Signal",
    connectionConfigSchema: [
      { key: "phoneNumber", label: "Phone number", kind: "text", required: true },
    ],
    transportConfigSchema: [],
    ...overrides,
  };
}

describe("transport registration", () => {
  it("accepts a source id the core has never seen and answers its desired state", async () => {
    const desired = await registerTransport(registration(), store.db);
    expect(desired).toEqual({ transport: { enabled: true, config: {} }, connections: [] });

    const rows = await listTransports(store.db);
    expect(rows.map((row) => [row.id, row.name])).toEqual([["signal", "Signal"]]);
    expect(await isRegisteredTransport("signal", store.db)).toBe(true);
    expect(await isRegisteredTransport("beta", store.db)).toBe(false);
  });

  it("keeps the admin's decisions across re-registration while the identity follows the code", async () => {
    await registerTransport(registration(), store.db);
    await registerTransport(
      registration({
        name: "Signal (beta)",
        connectionConfigSchema: [{ key: "phoneNumber", label: "Number", kind: "text", required: true }],
      }),
      store.db,
    );
    const [row] = await listTransports(store.db);
    expect(row.name).toBe("Signal (beta)");
    expect(row.connectionConfigSchema[0].label).toBe("Number");
    expect(row.enabled).toBe(true);
    expect(await desiredTransportState("signal", store.db)).toEqual({
      transport: { enabled: true, config: {} },
      connections: [],
    });
  });
});
