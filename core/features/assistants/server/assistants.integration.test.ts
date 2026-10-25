import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@assistants-swarm-hub/db/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as storeSchema from "../../../store/schema";
import { listTraces } from "@/server/trace";
import { getTraceDetail } from "@/server/trace/service";
import type { StoreDb } from "@/server/store/db";
import { registerHostedTransport, unregisterHostedTransport } from "@/server/transports/hosted";
import { registerTransport } from "@/server/transports/service";
import {
  createAssistant,
  editAssistant,
  getAssistantPersona,
  getAssistants,
  removeAssistant,
} from "./service";

const STORE_MIGRATIONS = fileURLToPath(new URL("../../../store/migrations", import.meta.url));

/**
 * Assistants CRUD over the v2 core store: uniqueness, limits, traces, and
 * the delete path's notification of the transports — a hosted one told to
 * reconcile directly, one run elsewhere through the `assistant.deleted` bus
 * event, whose skipped publish is a loud warning (the publish itself rides
 * the shared publisher, exercised in the transport runtime suite).
 */

const ACME = { id: "acme", name: "Acme Chat", connectionConfigSchema: [], transportConfigSchema: [] };

describe("assistants service", () => {
  let pg: TestPostgres;
  let pool: Pool;
  let db: StoreDb;

  beforeAll(async () => {
    pg = await startTestPostgres();
    const url = await pg.createDatabase("assistants_store");
    await applyMigrations(url, STORE_MIGRATIONS);
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: storeSchema });
  });

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE assistants, transports RESTART IDENTITY CASCADE`);
    unregisterHostedTransport("acme");
  });

  const trigger = { kind: "dashboard" } as const;

  it("creates, lists, edits, and reads a persona", async () => {
    const created = await createAssistant({ name: "Sarcastic Bot", persona: "Be dry." }, trigger, null, db);
    expect(created).toMatchObject({ name: "Sarcastic Bot", persona: "Be dry." });

    const listed = await getAssistants(db);
    expect(listed.map((a) => a.name)).toEqual(["Sarcastic Bot"]);

    const edited = await editAssistant(created.id, { persona: "Be kind." }, trigger, db);
    expect(edited.persona).toBe("Be kind.");
    // The identity line is structural: a third-person persona still knows
    // its own name (user decision, 2026-08-24).
    expect(await getAssistantPersona(created.id, db)).toBe(
      "You are Sarcastic Bot.\n\nBe kind.",
    );
  });

  it("asserts the identity even with an empty persona; unknown ids stay null", async () => {
    const created = await createAssistant({ name: "Plain", persona: "  " }, trigger, null, db);
    expect(await getAssistantPersona(created.id, db)).toBe("You are Plain.");
    expect(await getAssistantPersona("nope", db)).toBeNull();
  });

  it("refuses a duplicate name, case-insensitively", async () => {
    await createAssistant({ name: "Echo", persona: "" }, trigger, null, db);
    await expect(createAssistant({ name: "echo", persona: "" }, trigger, null, db)).rejects.toMatchObject(
      { status: 409 },
    );
    const other = await createAssistant({ name: "Other", persona: "" }, trigger, null, db);
    await expect(editAssistant(other.id, { name: "ECHO" }, trigger, db)).rejects.toMatchObject({
      status: 409,
    });
  });

  /** The delete trace's timeline (headers carry no events). */
  async function deleteEvents(): Promise<{ message: string; level: string }[]> {
    const { traces } = await listTraces({ feature: "assistants" });
    const header = traces.find((t) => t.action === "delete");
    expect(header?.status).toBe("success");
    return (await getTraceDetail(header!.id))!.events;
  }

  it("deletes an assistant and tells a transport run elsewhere on the bus, or warns that it could not", async () => {
    await registerTransport(ACME, db);
    const created = await createAssistant({ name: "Doomed", persona: "" }, trigger, null, db);
    await removeAssistant(created.id, trigger, db);
    expect(await getAssistants(db)).toEqual([]);

    // The publish is env-gated: with a reachable bus the trace records the
    // published event; without one it must warn LOUDLY that sources were
    // not told. Either way the outcome is on the record — never silent.
    const events = await deleteEvents();
    const published = events.some((e) => /assistant\.deleted published/.test(e.message));
    const warned = events.some((e) => e.level === "warn" && /bus not configured/i.test(e.message));
    expect(published || warned).toBe(true);

    await expect(removeAssistant(created.id, trigger, db)).rejects.toMatchObject({ status: 404 });
  });

  it("deletes an assistant and tells a hosted transport to reconcile directly, with no bus involved", async () => {
    await registerTransport(ACME, db);
    const reconciled: string[] = [];
    registerHostedTransport({
      descriptor: { id: "acme", name: "Acme Chat", connectionConfigSchema: [], maxMessageLength: 1, typingRefreshMs: 1 },
      outbound: {} as never,
      menus: {} as never,
      statuses: () => [],
      tools: null,
      turns: {} as never,
      reconcile: (reason) => void reconciled.push(reason),
    });
    const created = await createAssistant({ name: "Doomed", persona: "" }, trigger, null, db);
    await removeAssistant(created.id, trigger, db);
    expect(reconciled).toEqual(["assistant.deleted"]);

    const events = await deleteEvents();
    expect(events.some((e) => /hosted transports told to reconcile: acme/.test(e.message))).toBe(true);
    expect(events.some((e) => /assistant\.deleted published|bus not configured/.test(e.message))).toBe(false);
  });

  it("records every mutation as a trace with the assistant related", async () => {
    const created = await createAssistant({ name: "Traced", persona: "" }, trigger, null, db);
    const { traces } = await listTraces({ feature: "assistants" });
    const create = traces.find((t) => t.action === "create");
    expect(create?.relatedIds?.assistants).toEqual([created.id]);
  });
});
