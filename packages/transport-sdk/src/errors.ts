/**
 * One way to put a thrown thing into a log line, and it is the only one this
 * SDK uses.
 *
 * `fetch failed` is the entire message Node's fetch throws for every network
 * failure there is — a refused connection, an unknown host, a DNS timeout, a
 * TLS refusal — and the reason it actually is sits a level down in `cause`,
 * or spread across an `AggregateError` when a name resolved to several
 * addresses and each of them failed differently. A service that logs only
 * `err.message` therefore tells its operator nothing they can act on, which
 * is exactly the log a transport that cannot reach its core used to print.
 *
 * So: name, message, the error code when the message does not already spell
 * it out, every aggregated error, and the whole `cause` chain.
 */

/** Deep enough for fetch's `TypeError → AggregateError → errno`, and stops. */
const MAX_DEPTH = 5;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  /** Node's `ECONNREFUSED`, `ENOTFOUND`, undici's `UND_ERR_*`. */
  code?: unknown;
  /** `AggregateError`: one entry per address that was tried. */
  errors?: unknown;
  cause?: unknown;
}

/**
 * Duck-typed rather than `instanceof Error`, because plenty of what gets
 * thrown across a process boundary is error-shaped without being an `Error`
 * (a `DOMException` from `AbortSignal.timeout`, a structured-cloned error, a
 * platform SDK's own reject value).
 */
const isErrorLike = (value: unknown): value is ErrorLike =>
  typeof value === "object" && value !== null && typeof (value as ErrorLike).message === "string";

export function describeError(err: unknown): string {
  return describe(err, 0);
}

function describe(err: unknown, depth: number): string {
  if (!isErrorLike(err)) return typeof err === "string" ? err : String(err);

  const parts = [headline(err)];
  const aggregated = Array.isArray(err.errors) ? err.errors : [];
  if (aggregated.length > 0 && depth < MAX_DEPTH) {
    // All of them: "IPv6 refused, IPv4 refused" and "IPv6 refused, IPv4 timed
    // out" are different problems with different fixes.
    parts.push(`[${aggregated.map((inner) => describe(inner, depth + 1)).join("; ")}]`);
  }
  if (err.cause != null && depth < MAX_DEPTH) {
    parts.push(`<- ${describe(err.cause, depth + 1)}`);
  }
  return parts.join(" ");
}

function headline(err: ErrorLike): string {
  const message = String(err.message).trim();
  const name = typeof err.name === "string" && err.name !== "Error" ? err.name : "";
  const code =
    typeof err.code === "string" && err.code && !message.includes(err.code) ? ` (${err.code})` : "";
  // An `AggregateError` fetch built itself carries no message at all: its
  // name and the list below it are the whole story, and "(no message)" in
  // front of them is just noise.
  const said = message ? (name ? `${name}: ${message}` : message) : name || "(no message)";
  return `${said}${code}`;
}
