// The synthetic transport package. What a real one exports is the same
// shape, built from a platform SDK; this one opens no connection and exists
// so the loader and the tool registration can be tested without a platform.
import { z } from "zod";

/**
 * Whether `candidate` is the zod this package resolved. The loader test
 * installs this package under its own `node_modules`, so the answer for the
 * core's zod must be `false` — that is the cross-copy condition under test.
 */
export const sameZod = (candidate) => candidate === z;

export default {
  descriptor: {
    id: "acme",
    name: "Acme Chat",
    connectionConfigSchema: [],
    maxMessageLength: 2000,
    typingRefreshMs: 5000,
  },
  adapter: {
    async connect() {
      throw new Error("the acme fixture opens no connection");
    },
  },
  async normalize() {
    return null;
  },
  addressing() {
    return { addressed: false, needsAnalyzer: false };
  },
  tools: {
    platform: "Acme",
    register(server) {
      server.registerTool(
        "acme__echo",
        {
          title: "Echo",
          description: "Returns the text, prefixed with the chat id.",
          inputSchema: {
            chatId: z.string().min(1).describe("The chat to echo into."),
            text: z.string().describe("What to echo."),
          },
        },
        async ({ chatId, text }) => ({
          content: [{ type: "text", text: `${chatId}: ${text}` }],
        }),
      );
    },
  },
};
