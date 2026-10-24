import type { PlatformConnection, SendContext, TransportDescriptor } from "@assistants-swarm-hub/contracts";
import { describe, expect, it, vi } from "vitest";

import { isApiError } from "@/lib/api-error";

import { hostedMenus, hostedOutboundPort } from "./outbound";

/**
 * The in-process outbound port keeps the HTTP port's verdicts: an action
 * the platform lacks is a bad request, a platform refusal is unavailable
 * with the platform's words, a voice bubble the platform will not take
 * still arrives as text, a picture that failed is skipped rather than
 * failing the rest, and a refused delete is cosmetic.
 */

const descriptor: TransportDescriptor = {
  id: "acme",
  name: "Acme Chat",
  connectionConfigSchema: [],
  maxMessageLength: 2000,
  typingRefreshMs: 5000,
};

function setup(overrides: Partial<PlatformConnection> = {}, running = true) {
  let sent = 0;
  const connection: PlatformConnection = {
    identity: () => ({ id: "bot", identity: { botUsername: "acme_bot", botDisplayName: "Acme" } }),
    sendMessage: vi.fn(async () => ({ sourceMessageId: `m-${++sent}`, replyToSourceMessageId: null })),
    isDirectChat: async () => false,
    close: async () => undefined,
    ...overrides,
  };
  const published: Record<string, unknown>[] = [];
  const send: SendContext = {
    descriptor,
    publisher: {
      publish: async (event) => {
        published.push(event as unknown as Record<string, unknown>);
      },
      close: async () => undefined,
    },
    running: () => [],
    connectionFor: () => {
      if (!running) throw new Error("No running acme connection");
      return connection;
    },
  };
  const deps = { send, errorText: (err: unknown) => (err instanceof Error ? err.message : String(err)) };
  return { connection, published, port: hostedOutboundPort(deps), menus: hostedMenus(deps) };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("hostedOutboundPort", () => {
  it("is unavailable, with the reason, when no connection runs", async () => {
    const { port } = setup({}, false);
    const err = await failure(port.sendMessage("c", { text: "hi" }));
    expect(isApiError(err) && err.code).toBe("service_unavailable");
    expect((err as Error).message).toMatch(/No running acme connection/);
  });

  it("refuses an action the platform does not have as a bad request", async () => {
    const { port } = setup();
    const err = await failure(port.sendVoice("c", { audioBase64: "AAA", text: "spoken" }));
    expect(isApiError(err) && err.code).toBe("bad_request");
    expect((err as Error).message).toMatch(/no voice messages/);
  });

  it("falls back to text when the platform refuses the voice bubble", async () => {
    const { port, connection, published } = setup({
      sendVoice: vi.fn(async () => {
        throw new Error("voice disabled in this chat");
      }),
    });
    await expect(port.sendVoice("c", { audioBase64: "AAA", text: "spoken" })).resolves.toEqual({
      sourceMessageId: "m-1",
      asVoice: false,
    });
    expect(connection.sendMessage).toHaveBeenCalledWith("c", "spoken", expect.anything());
    expect(published.map((e) => e.content)).toEqual(["spoken"]);
  });

  it("reports a delivered voice message with the spoken text", async () => {
    const { port, published } = setup({
      sendVoice: vi.fn(async () => ({ sourceMessageId: "v-1", asVoice: true })),
    });
    await expect(port.sendVoice("c", { audioBase64: "AAA", text: "spoken" })).resolves.toEqual({
      sourceMessageId: "v-1",
      asVoice: true,
    });
    expect(published).toEqual([
      expect.objectContaining({ type: "message.delivered", sourceMessageId: "v-1", content: "spoken" }),
    ]);
  });

  it("skips a picture the platform refused and reports the ones it took, bytes included", async () => {
    let n = 0;
    const { port, published } = setup({
      sendPhoto: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new Error("too large");
        return { sourceMessageId: `p-${n}`, mediaId: `file-${n}` };
      }),
    });
    await expect(port.sendPhotos("c", { images: ["AAA", "BBB", "CCC"] })).resolves.toEqual({
      delivered: [
        { sourceMessageId: "p-1", stored: true },
        { sourceMessageId: "p-3", stored: true },
      ],
    });
    expect(published.map((e) => (e.image as { fileId: string; base64: string }))).toEqual([
      expect.objectContaining({ fileId: "file-1", base64: "AAA" }),
      expect.objectContaining({ fileId: "file-3", base64: "CCC" }),
    ]);
  });

  it("sends a file as base64 with its caption as the delivered content", async () => {
    const sendFile = vi.fn(async () => ({ sourceMessageId: "f-1" }));
    const { port, published } = setup({ sendFile });
    await expect(
      port.sendFile("c", { buffer: Buffer.from("bytes"), filename: "a.txt", mime: "text/plain", caption: "here" }),
    ).resolves.toEqual({ sourceMessageId: "f-1" });
    expect(sendFile).toHaveBeenCalledWith(
      "c",
      { base64: Buffer.from("bytes").toString("base64"), filename: "a.txt", mime: "text/plain" },
      { threadId: null, caption: "here" },
    );
    expect(published[0]).toMatchObject({ sourceMessageId: "f-1", content: "here" });
  });

  it("treats a delete the platform cannot or will not do as cosmetic", async () => {
    const { port: without } = setup();
    await expect(without.deleteMessage("c", "m")).resolves.toEqual({ deleted: false });
    const { port: refusing } = setup({
      deleteMessage: vi.fn(async () => {
        throw new Error("too old");
      }),
    });
    await expect(refusing.deleteMessage("c", "m")).resolves.toEqual({ deleted: false });
    const { port: able } = setup({ deleteMessage: vi.fn(async () => undefined) });
    await expect(able.deleteMessage("c", "m")).resolves.toEqual({ deleted: true });
  });

  it("relays a platform refusal of a send as unavailable, in the platform's words", async () => {
    const { port } = setup({
      sendMessage: vi.fn(async () => {
        throw new Error("bot was kicked from the chat");
      }),
    });
    const err = await failure(port.sendMessage("c", { text: "hi" }));
    expect(isApiError(err) && err.code).toBe("service_unavailable");
    expect((err as Error).message).toMatch(/kicked/);
  });
});

describe("hostedMenus", () => {
  it("refuses menus on a platform without buttons and swallows a refused menu delete", async () => {
    const { menus } = setup();
    const err = await failure(
      menus.sendMenu({ chatId: "c", assistantId: "a", text: "t", keyboard: [], replyToSourceMessageId: "m" }),
    );
    expect(isApiError(err) && err.code).toBe("bad_request");
    await expect(menus.deleteMenu({ chatId: "c", assistantId: "a", sourceMessageId: "m" })).resolves.toBeUndefined();
  });

  it("posts, edits and removes a menu through the connection", async () => {
    const sendMenu = vi.fn(async () => ({ sourceMessageId: "menu-1" }));
    const editMenu = vi.fn(async () => undefined);
    const deleteMessage = vi.fn(async () => undefined);
    const { menus } = setup({ sendMenu, editMenu, deleteMessage });
    const keyboard = [[{ text: "Yes", callbackData: "y" }]];
    await expect(
      menus.sendMenu({ chatId: "c", assistantId: "a", text: "Pick", keyboard, replyToSourceMessageId: "m" }),
    ).resolves.toEqual({ sourceMessageId: "menu-1" });
    await menus.editMenu({ chatId: "c", assistantId: "a", sourceMessageId: "menu-1", text: "Done", keyboard: null });
    expect(editMenu).toHaveBeenCalledWith("c", "menu-1", { text: "Done", keyboard: null });
    await menus.deleteMenu({ chatId: "c", assistantId: "a", sourceMessageId: "menu-1" });
    expect(deleteMessage).toHaveBeenCalledWith("c", "menu-1");
  });
});
