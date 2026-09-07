import {
  CONTRACT_MAJOR,
  transportCallbackResponseSchema,
  transportDesiredStateSchema,
  transportMessageLookupResponseSchema,
  type TransportCallbackRequest,
  type TransportDesiredState,
  type TransportMessageLookupResponse,
} from "@assistant-hub-swarm/contracts";

import { INTERNAL_TOKEN_HEADER } from "@assistant-hub-swarm/service";

import { describeError } from "./errors";
import type { TransportDescriptor } from "./types";

/**
 * Everything a transport says TO the core: registration and the desired
 * state, the mirror lookup a reaction tool needs, and the toast a menu press
 * wants back. Every transport did this identically, so it lives here once.
 */

const REGISTER_RETRY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface CoreApi {
  /** Register; the answer IS the desired state, so this doubles as the fetch. */
  register(): Promise<TransportDesiredState>;
  /** Register, retrying until the core answers — it may boot second. */
  registerUntilAccepted(): Promise<TransportDesiredState>;
  /** Refetch the desired state, on a config-changed event. */
  desiredState(): Promise<TransportDesiredState>;
  /** Ask the core's mirror about one message (the reaction tool's pre-check). */
  lookupMessage(params: {
    chatId: string;
    sourceMessageId: string;
    assistantId: string | null;
    direct: boolean;
  }): Promise<TransportMessageLookupResponse>;
  /** Forward a menu press and get the toast to answer with. */
  forwardMenuPress(body: TransportCallbackRequest): Promise<{ toast: string | null }>;
}

/** A body worth putting in a log line: one line, and not an essay. */
function summarize(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** The core's own `{ error: { message } }`, when that is what came back. */
function errorMessageOf(raw: string): string | null {
  if (!raw.startsWith("{")) return null;
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    const message = body.error?.message ?? body.message;
    return typeof message === "string" && message ? message : null;
  } catch {
    return null;
  }
}

export function createCoreApi(input: {
  descriptor: TransportDescriptor;
  baseUrl: string;
  token: string;
  /** The base URL this transport announces — what the core calls back. */
  selfUrl: string;
  onRetry?: (message: string) => void;
}): CoreApi {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const onRetry = input.onRetry ?? ((message: string) => console.warn(message));

  /**
   * Every call to the core, and every failure of one, worded the same way.
   * A failure here is nearly always an operator's problem — the wrong
   * `CORE_API_URL`, a core that is not up yet, a token it rejects, a proxy
   * answering in the core's place — and the log has to be enough to tell
   * those apart without attaching a debugger to a container.
   *
   * So each throw carries **where**: the method, the full URL and what came
   * back. **Why** stays in `cause`, which {@link describeError} unwraps at
   * the point of logging — saying it in both places printed everything
   * twice.
   */
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    const method = init?.method ?? "GET";
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          [INTERNAL_TOKEN_HEADER]: input.token,
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`${method} ${url} did not answer`, { cause: err });
    }
    if (!res.ok) {
      // The body is read as text and only then as JSON: a proxy, a gateway or
      // a core serving something else entirely answers HTML, and that page's
      // first line is more use than "answered 502" alone.
      const raw = (await res.text().catch(() => "")).trim();
      // A 409 is the contract-major handshake refusing this build by name.
      // It reads like any other failure here and is retried the same way,
      // because the fix is an operator updating one side or the other.
      const detail = errorMessageOf(raw) ?? (raw ? summarize(raw) : null);
      throw new Error(
        `${method} ${url} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}` +
          (detail ? `: ${detail}` : ""),
      );
    }
    const body = (await res.text().catch(() => "")).trim();
    try {
      return JSON.parse(body) as unknown;
    } catch (err) {
      throw new Error(
        `${method} ${url} answered ${res.status} with a body that is not JSON ` +
          `(${body ? summarize(body) : "empty body"})`,
        { cause: err },
      );
    }
  }

  /**
   * A schema failure here is not a bug in the core's answer, it is the two
   * sides disagreeing about the wire — so it says so, and names the major it
   * was reading the answer as.
   */
  function toContract<T>(schema: { parse: (value: unknown) => T }, value: unknown, what: string): T {
    try {
      return schema.parse(value);
    } catch (err) {
      throw new Error(
        `the core's ${what} does not match contract v${CONTRACT_MAJOR} as this SDK reads it`,
        { cause: err },
      );
    }
  }

  const register = async (): Promise<TransportDesiredState> =>
    toContract(
      transportDesiredStateSchema,
      await request("/api/internal/transports/register", {
        method: "POST",
        body: JSON.stringify({
          id: input.descriptor.id,
          name: input.descriptor.name,
          contractMajor: CONTRACT_MAJOR,
          baseUrl: input.selfUrl.replace(/\/$/, ""),
          mcpPath: input.descriptor.mcpPath ?? null,
          connectionConfigSchema: input.descriptor.connectionConfigSchema,
          transportConfigSchema: input.descriptor.transportConfigSchema ?? [],
        }),
      }),
      "registration answer",
    );

  return {
    register,

    async registerUntilAccepted() {
      const startedAt = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          return await register();
        } catch (err) {
          // Attempt and elapsed time are the difference between "the core is
          // still booting" and "this has been failing for an hour", which is
          // invisible in an identical line repeated every ten seconds.
          const waited = Math.round((Date.now() - startedAt) / 1000);
          onRetry(
            `registration of ${input.descriptor.id} with the core at ${baseUrl} failed ` +
              `(attempt ${attempt}, ${waited}s in): ${describeError(err)} — ` +
              `retrying in ${REGISTER_RETRY_MS / 1000}s`,
          );
          await new Promise((resolve) => setTimeout(resolve, REGISTER_RETRY_MS));
        }
      }
    },

    async desiredState() {
      return toContract(
        transportDesiredStateSchema,
        await request(`/api/internal/transports/${input.descriptor.id}/desired`),
        "desired state",
      );
    },

    async lookupMessage(params) {
      const query = new URLSearchParams({
        source: input.descriptor.id,
        chatId: params.chatId,
        sourceMessageId: params.sourceMessageId,
        ...(params.assistantId ? { assistantId: params.assistantId } : {}),
        ...(params.direct ? { direct: "true" } : {}),
      });
      return toContract(
        transportMessageLookupResponseSchema,
        await request(`/api/internal/transports/messages?${query.toString()}`),
        "message lookup answer",
      );
    },

    async forwardMenuPress(body) {
      return toContract(
        transportCallbackResponseSchema,
        await request("/api/internal/transports/callback", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        "menu-press answer",
      );
    },
  };
}
