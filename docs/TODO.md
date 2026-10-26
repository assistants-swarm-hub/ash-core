# TODO

The working tracker for pending work. It replaced `NEXTJS_REWRITE_PLAN.md` and
`NEXTJS_REWRITE_PROGRESS.md` (retired 2026-07-27): the v1 rewrite is complete,
so the phase plan, per-feature progress tables, session logs and the historical
Decision Notes are archive material — recoverable from git history — and only
the still-actionable information was carried forward here.

How to use this file:

- Update it before and after substantial work; statuses are `todo`,
  `in-progress`, `blocked`, `done`, `deferred`.
- A `done` entry records proof (files changed, tests run, build/typecheck/lint
  status, remaining risks) — and is then **pruned** once the work is shipped and
  documented under `docs/`. Git history is the archive; this file holds only
  open work.
- A `blocked` entry records the blocker, the attempted approach, and the next
  decision needed.
- Decisions are made by asking the user and recording the outcome against the
  entry it belongs to, here (no `docs/decisions/*.md` files).
- At handoff, leave short notes here: current state, next best task, known
  pitfalls, commands that passed or failed.

## Current state

The v2 redesign is complete (2026-08-31; design in `docs/PLAN.md`). Instead
of renaming the old repository, the redesign branch became `main` of a fresh
repository —
[assistants-swarm-hub/ash-core](https://github.com/assistants-swarm-hub/ash-core)
(user decision, 2026-09-01); the old `llm-tg-bot-nextjs` repo stays behind as
the archive. Commit-on-main is back in force. Entries below dated before
2026-08-21 predate the redesign — re-check their file paths against the
current tree before acting on them.

## A name in the text is not who the message is for (`todo` — improvement, 2026-08-27)

The deterministic name check answers "does this text contain the assistant's
display name", and the turn treats that as "this message is for me". Those are
different questions, and in a chat holding more than one assistant the
difference shows.

**Live evidence (two-bot group, 2026-08-27).** One human message named both
assistants and asked one of them to do something *about* the other — the shape
of "Ada, ask Grace about her day". Both assistants opened a turn and both
answered: Grace's verdict was `source: "name"`, `matchedText: "Grace"`, matched
on the word that was the *object* of the request, not its addressee. Her own
reply said so:

> I'm not sure if you're asking me to ask myself or if you want Ada to do it,
> but if it's up to me: …

The model spotted an addressing error the regex cannot, because
`matchBotName` sees presence, never direction. Same mechanism produces the
other misses of this family: "tell Ada I said hi" (a third party is asked to
relay), "Ada already answered that" (the name is the subject of a remark),
"unlike Ada, I think…" (a comparison).

**Why it is not simply a bug.** The check is the v1 rule and it is right far
more often than it is wrong — a name spoken in a group usually IS a summons.
It also costs nothing, and it is the reason a summons is never missed to a
provider failure. The failure is confined to messages that mention an
assistant without addressing it, which in a single-assistant chat is rare and
in a multi-assistant chat is routine.

**Decision (user, 2026-08-27): keep the short-circuit.** Asked whether the
name question should go to the analyzer instead, the answer was no — surface
the behaviour rather than change it. Shipped that day (`1bdfbbf`): a
deterministic verdict now carries a note in the Debug timeline naming what
decided and stating that there is no analyzer request/response to read, so the
decision is legible even though it is regex-made. **This entry is the
improvement that was deliberately not taken**, kept because the failure mode
is real and multi-assistant chats make it common.

If it is taken later, the shape is known:

- Keep every **structural** verdict as-is (`private`, `reply`, `mention`,
  `command`). Those are facts Telegram hands us — a reply target, a message
  entity — not readings of prose, and they carry no direction ambiguity.
- Route only the **name** question to the analyzer, which already answers a
  harder version of it (which word is the display name, in what spelling) and
  would gain the easier one (is the message directed at that name).
- Cost is small and well aimed: the analyzer already runs on every other
  undecided group message, so this adds calls **only** for messages that
  contain the name literally — the exact set where the decision matters.
- Watch the failure direction. The name check fails closed today only in the
  sense that it over-answers; an analyzer that mis-reads direction would
  under-answer, and a missed summons is the more expensive error (see the
  reverted pre-filter, 2026-07-20). Any move here wants the enum + citation +
  verifier discipline the existing analyzer already has, not a looser prompt.

Acceptance criteria, if picked up:

- A message naming an assistant as the object of a request ("Ada, ask Grace
  about her day") opens a turn for the addressee only.
- A message naming an assistant as the addressee still answers, with a verdict
  carrying the analyzer exchange behind it.
- Both live shapes above are pinned by tests over recorded messages, not by a
  new lexical rule anywhere in code.
- The Debug note keeps working: a verdict with no exchange still says why.

Dependencies: none. Related: the loop guard bounds how far a mis-addressed
bot-to-bot exchange can run, so this is a quality problem, not a runaway one.

## The served model leaks its deliberation (`todo` — guarded, model unchanged, 2026-08-24)

The chat model in the operator's dev setup
(`Huihui-gemma-4-26B-A4B-it-abliterated` UD-Q4_K_M on llama.cpp b10588) stops
using its thought channel at production prompt scale and writes its working-out
as the answer. Probed directly against the endpoint, replaying the exact request
behind trace `3491c387`, 8–10 samples per condition:

| condition | leaked |
| --- | --- |
| what the app sends (no reasoning param) | 6/8 … 10/10 |
| `temperature: 0.2` | 8/8 |
| `chat_template_kwargs: {enable_thinking: true}` | 7/8 |
| `chat_template_kwargs: {enable_thinking: false}` | 0/8 |

`reasoning_content` was empty in every one of those calls — the channel is never
opened, so llama.cpp has nothing to strip. Ruled out by measurement: the server's
parser (a *short* prompt to the same model/server channels correctly), truncation
(a cut-off thought returns the reasoning field set and content empty, never raw
CoT), the 17 tool definitions (reproduces without them), and sampling temperature
(lower is worse). Tool calling is unaffected either way (4/4 `tasks_create`).

**Guarded, not fixed** (`d5e548b`, reply integrity, see
[bot-messaging.md](features/bot-messaging.md#reply-integrity--deliberation-is-not-an-answer)):
the turn detects the leak mechanically and retries, which recovered 10/10 live.
The cost is a wasted generation — up to ~40s when the leak runs to the token cap.

**Open, needs the operator**: this is a model/template defect, and the honest fix
is serving a model whose thought channel llama.cpp can parse at this prompt size.
Turning thinking off for replies is **rejected** (user decision, 2026-08-24) — it
is the one thing measured to stop the leak outright, and it is not on the table.
Re-run the probe against any replacement model before trusting it.

## The honesty gate cannot judge a retrospective turn (`todo` — observing, 2026-08-15)

Operator trace `0e0a924f…` (`bot-messaging` / `reply`, 2026-08-14 21:37Z). The
user asked *"what do you mean?"* about the bot's previous message, the bot
explained what that message had been, and the gate read the explanation as a
fresh claim — retried, got the same explanation, suppressed it, and answered a
clarifying question with the ⚠️ system notice. 53 seconds, two generations, no
answer.

Why it cannot come out otherwise as written:

1. The gate sees only `request` + `reply` (`buildActionClaimMessages`), never the
   conversation. Its own exemption — *"describes what someone ELSE did, or what
   happened earlier in the conversation"* — is therefore unreachable: a
   first-person past-tense recap is indistinguishable from a fresh claim, and the
   `someone ELSE` clause anchors the bullet to third parties.
2. `ACTION_CLAIM_ENFORCEMENT_DIRECTIVE` offers two options that both fail on this
   shape. There is no tool to call (the "action" is a message already written),
   and "say plainly you did not do it" contradicts what the bot did write. The
   second strike is guaranteed.

Not entirely a false positive: the claim (*"marked it as complete"*) was itself
confabulated about the previous turn, which only wrote `👍 Done.` to a `hello`.
That earlier turn is the deeper bug and is in a different trace.

**Half shipped 2026-08-24 (`b8ebf18`)**, after the same shape recurred live
(trace `10e34de6…`: the bot said *"I've already told you"* — true, and visible in
the window — and the gate suppressed it as a performed action). Point 1 is
closed: `ActionClaimInput` carries the turn's own conversation window and the
rules name speech about one's earlier messages (*told, said, answered,
explained*) as never an action.

**Still open — point 2.** `ACTION_CLAIM_ENFORCEMENT_DIRECTIVE` still offers two
options that both fail on a retrospective turn: there is no tool to call, and
"say plainly you did not do it" contradicts what the bot did write. If the gate
misfires on such a turn again, the second strike is still guaranteed.

## Voice: why transcription is failing in production (`blocked`, 2026-08-14)

Reported by the operator, 2026-08-14: voice messages come back with no
transcript. Two distinct symptoms on prod (`/api/health` reports **1.40.0**):

1. Media cards reading "Transcribed" with `(no speech)` and no content
   (~12:29–12:30 GMT+3).
2. `voice`/`transcribe` traces ending in `error` at **0 ms / 2 ms / 14 ms**, on
   three consecutive message ids in the same second (13:06:03 GMT+3) — the
   vision backfill working a batch.

Symptom 1 is **fixed** (next section): an empty answer was being stored as a
terminal `(no speech)`. Symptom 2 is the underlying failure and is still
**unknown** — sub-15 ms means the transcribe threw *before the wire*, so it is
configuration or a local process, not the endpoint. Candidates, in order:

- `toWavForTranscription` (`features/vision/server/service.ts`) — an ffmpeg
  spawn/transcode failure. ENOENT fails in single-digit ms, which fits best.
- `createOpenAiClient` (`server/llm/client.ts`) refusing an `anthropic` audio
  role in `transcriptions` mode — an instant, named `ApiError`.

**Blocker:** no authenticated access to `/debug`. The Browser pane blocks every
`/_next/static/*` asset with `net::ERR_BLOCKED_BY_CLIENT` (the `/login`
document itself is 200), so the page never hydrates and the sign-in form is
inert; the Claude-in-Chrome extension is not connected either. `/api/health` is
public and was the only reachable signal.

**Next decision needed:** the operator pastes the error message and event list
from one 13:06 `transcribe` trace (or its JSON bundle). That one string
separates ffmpeg-missing from a backend refusal — they read nothing alike.
Note that symptom 1's fix converts these into *more* such traces rather than
fewer: failures that were previously laundered into `(no speech)` now surface
as errors, which is the point.

## Backend normalization layer (`in-progress`, 2026-08-07)

User decision, 2026-08-07: "bot breaks every time I switch backend… implement an
adaptation/normalization layer per backend instead of layers of fixes every
time." Step zero, ahead of the reply-latency work below.

Decisions taken with the user before implementing:

- **Scope**: all five endpoints get their own backend selector (LLM, embedding,
  image, speech, transcription) — they can genuinely be different servers.
- **Tool loop**: `runToolLoop` stays hand-rolled; the AI SDK is transport only.
  The SDK's agent has no stall guard, no `compact()`, no forced tools-free final
  round, and no per-round usage reporting — and Analytics groups on the round.
- **Backends**: Ollama, llama.cpp, vLLM, and a generic OpenAI-compatible
  fallback (the default, and what every pre-existing settings row resolves to).
- **Detection**: manual dropdown plus a Detect button that fingerprints the
  endpoint. Never automatic — a silent change is the bug class this prevents.
- **Speech/transcription**: keep the `openai` SDK internally.
  `@ai-sdk/openai-compatible` supports chat, completion, embedding and image
  models only — it has no transcription or speech model type.
- **Cutover**: adapter layer first with no behavior change, then the latency
  work as a separate change, so a regression has one candidate cause.

Confirmed breakages the layer must pin (user, 2026-08-07): thinking/reasoning
control, context-overflow error shape, served-model-id normalization. Tool-call
dialect was explicitly *not* one of them — **until 2026-08-08**, when a live turn
emitted its tool call inside the reasoning channel and the round came back empty
(see "the tool call went into the reasoning channel" below). Handled generically
in the tool loop for now; if it recurs it belongs here, in the Ollama adapter.

### Done so far

- `lib/llm-backend.ts` — client-safe ids/labels/coercion.
- `server/llm/backends/` — adapter interface, four adapters, registry, endpoint
  fingerprinting. Pure: no fetch, no SDK, so every quirk is testable without a
  server.
- `db/schema.ts` + `db/migrations/0047_bouncy_ink.sql` — five backend columns,
  `NOT NULL DEFAULT 'openai-compatible'` so existing rows keep current behavior.
- Settings zod schemas, repository, service, and `LlmConnection` carry the
  backend. It follows the **host**, like the API key: an endpoint that falls
  back to the LLM connection inherits its backend too.
- `server/llm/backends/backends.test.ts` — 17 tests.

Proof: `npm run lint` clean, `npm run typecheck` clean, `npm run test`
1002 passed / 21 failed — the same 21 fail on a stashed clean tree
(`ytdlp-binary`, `media-download`; environment-dependent, unrelated).

**Migration not applied locally** — no Postgres reachable at the configured
`DATABASE_URL`. It is generated and committed; apply on deploy with
`npm run db:migrate`.

### How the vendor fields reach the wire

`providerOptions[<provider name>]` is the seam, exactly as the provider's docs
describe. The typed options schema
(`{user, reasoningEffort, textVerbosity, strictJsonSchema}`) is `$strip`, which
reads like it would discard everything else — it does not. The model spreads the
raw `providerOptions` entry into the request body and filters out **only** those
four known keys (`@ai-sdk/openai-compatible/dist/index.js`, the
`Object.fromEntries(...)` spread in `getArgs`). Every other key — `think`,
`chat_template_kwargs`, `reasoning_format` — is passed straight through.

So an adapter's `chatBodyExtras()` maps onto `providerOptions` directly and no
`fetch` shim is needed. Two consequences for the adapters:

- Genuine vendor fields use their **wire spelling** (`think`,
  `chat_template_kwargs`, `reasoning_format`) and pass through untouched.
- `reasoningEffort` is the exception and must use the **camelCase typed name**.
  The model writes `reasoning_effort` into the body *after* the passthrough
  spread, so a snake-case `reasoning_effort` is overwritten by the unset typed
  option and never reaches the endpoint. Found by the end-to-end test, not by
  reading the code.

`server/llm/transport.ts` is the single wire, and `server/llm/transport.test.ts`
pins the passthrough against the real provider with a stub `fetch` — asserting
the behavior rather than the declaration, because reading the declaration got it
wrong once.

The conversation stays in OpenAI's message shape and is converted once at the
transport boundary. `./tool-loop` owns the conversation and appends assistant
turns to it verbatim across rounds, so that shape is a stable internal DTO;
converting at the edge leaves the loop, the browser agent, and the MCP tool
bridge untouched by the transport swap.

`chatCompletion` and the tool loop's round factory both run on the transport.
Migration `0047` is applied to the dev DB and the existing row backfilled to
`openai-compatible`.

Behavior is deliberately unchanged until an operator names a backend: the
classifiers still pass `reasoning: "low"`, which on the generic adapter produces
the identical `reasoning_effort: "low"` body they always sent, and the reply path
passes no reasoning preference at all.

Two things improved for free by moving off the OpenAI SDK:

- **Error bodies survive.** `APICallError` keeps `responseBody`, where the OpenAI
  SDK discarded any JSON error body that was not its own `{error:{}}` shape —
  the "500 status code (no body)" problem `fetchWithErrorDetail` exists to work
  around. `isContextOverflowError` and `toLlmError` now read it.
- **`isContextOverflowError` takes the backend**, so an adapter's phrasings are
  tried after the shared concept matcher.

### Measured against the live Ollama (0.32.6, 12B thinking model)

One classifier prompt, identical verdict every time:

| body                       | completion tokens | latency |
| -------------------------- | ----------------- | ------- |
| (nothing)                  | 135               | 2269 ms |
| `reasoning_effort: "low"`  | 94                | 1784 ms |
| `reasoning_effort: "none"` | **17**            | **802 ms** |

So `"low"` — what the bot has been sending all along — is **not** a weaker
"off". It still thinks. `"none"` is the switch, and it is now what the Ollama
adapter emits for `reasoning: "off"`.

Also measured, and why the adapter does *not* send `think`: Ollama's native flag
works on `/api/chat` (17 tokens, 816 ms, no thinking) but the OpenAI-compatible
`/v1/chat/completions` route this app speaks **ignores it** — 128 completion
tokens with it and without. `chat_template_kwargs: {thinking:false}` and
`options: {think:false}` were also tried on `/v1` and did not disable it.

llama.cpp mappings remain **documented, not measured** — no live instance. Its
tests assert the body produced, not a server's answer. vLLM was measured live on
2026-08-12 — see "vLLM measured live" below: the mapping is right, the
deployment is not.

### Settings UI

`features/settings/ui/BackendField.tsx` — one dropdown + Detect control, used by
the LLM section in `SettingsForm` and by all four optional sections through
`ConnectionSection`. A section reusing the LLM connection shows no control: it
inherits that endpoint's backend at read time, so persisting one would be a
second, silently-ignored source of truth.

`POST /api/settings/detect-backend` fingerprints an endpoint. Ollama's
`/api/version` is tried before vLLM's bare `/version` — both answer `{version}`,
and the reverse order would let a generic body claim an Ollama host.

Verified in the browser against the live endpoint: the control renders in the
Core tab, Detect returned "Detected Ollama 0.32.6" and set the dropdown, and
saving persisted `llm_backend = 'ollama'` while leaving the four inheriting
sections untouched.

### Two bugs the live check caught that nothing mocked could

1. **System turns were rejected outright.** The AI SDK refuses `system` messages
   inside `messages` unless `allowSystemInMessages` is set, steering callers to
   its single `instructions` field. That does not fit this app — the reply prompt
   places system turns *between* other turns deliberately (time context after the
   history window, language directive last, at maximum recency). Left unset,
   **every reply would have failed on deploy** with `AI_InvalidPromptError`. Now
   pinned by a test that asserts the sent role order.
2. **The backend never reached the wire.** Ten call sites built their connection
   as `{ baseUrl, apiKey }`, dropping `backend`, so `adapterFor` fell back to the
   generic adapter and the operator's choice did nothing. Fixed at every site.
   The footgun remains: a bare object literal silently loses the field. Worth
   making the runtime itself an `LlmConnection` that callers spread.

### Measured through the app's own code path, live

Same classifier prompt, identical verdict, only the stored backend differing:

| `llm_backend`        | completion tokens | latency | reasoning |
| -------------------- | ----------------- | ------- | --------- |
| `openai-compatible`  | 149               | 2519 ms | 431 chars |
| `ollama`             | **17**            | **683 ms** | **0**  |

### Embeddings and images

Both run on the AI SDK provider now, through the shared `server/llm/provider.ts`
factory that chat also uses — it exists so the three cannot drift on the two
things easy to get subtly wrong: base URL normalization and the
`providerOptions` key. Chat briefly had its own copy that skipped the URL
normalization, which worked only because the stored setting already ended in
`/v1`; an operator entering `http://host:11434` would have hit the wrong path.

Verified live against `bge-m3:latest`: probe reports 1024 dimensions, and a
3-input batch keeps one vector per input **in order** — vector 1 has similarity
1.0 against the same text embedded alone, versus 0.45 cross. That check exists
because `embedMany` pairs vectors to inputs *positionally*: the provider maps
`response.data` straight across and discards each entry's `index`, which the old
code placed by. An arity check now stands in for that guard — a short or padded
response fails loudly instead of misaligning every vector after the gap.

Images are unverified: `image_model` is `docker.io/ai/stable-diffusion:Q4`, which
the configured endpoint does not serve (a Docker Model Runner leftover), and
Ollama has no `/v1/images/generations` at all. The port typechecks and the code
path is the same one embeddings proved; the endpoint is what is missing.

The `openai` package stays for speech, transcription, and `listModels` — the
first two have no model type in `@ai-sdk/openai-compatible`, and the provider
exposes no model listing.

Also fixed while here: a fired deadline now names the endpoint. The AI SDK paths
bound themselves with `AbortSignal`, which throws a bare `TimeoutError` whose
message ("The operation was aborted due to timeout") names neither the host nor
the attempt — useless in a trace read months later.

### Remaining

- Nothing outstanding on the normalization layer itself.
- Watch the first production reply traces after deploy: `addressing-check` and
  `chat-rule-match` should drop from ~135 completion tokens to ~17, and the
  `reasoning` field on their responses should be gone.

### Reply calls keep thinking (user decision, 2026-08-07 — do not retry)

Turning reasoning off on the **reply** path was measured against the live
endpoint and **rejected**. It is not a latency trade, it is a correctness
regression, and the second failure below is the one this bot already has a gate
for.

Three runs each, gemma4:12b, live:

*"split a 2400 bill between 5, two ate half"* — correct answer $600 / $300:

| reasoning | result |
| --------- | ------ |
| on        | **3/3 correct** |
| off       | **0/3 correct** — $480/$240, a garbled half-answer, $533.33/$266.67 |

*"did she push it yet?"* over history where only Bea can know — the bot should
ask her or say it does not know:

| reasoning | result |
| --------- | ------ |
| on        | 3/3 fine: *"@Bea, have you pushed the changes?"* / *"She hasn't mentioned if she pushed it yet."* |
| off       | 3/3 **fabricated**: *"Not yet, still checking the logs."* / *"Not yet. Checking now."* |

That last one asserts a fact it cannot know *and* an action it is not
performing — exactly what `runActionClaimGate` exists to catch. So it is also
**slower**, not faster: those replies trip the gate, which forces a regeneration
plus a re-check. Two extra calls to save 800 ms.

Tool *selection* alone survives reasoning-off (3/3 correct tool, 772 ms vs
4704 ms), but it cannot be isolated: `runToolLoop` only learns a round was the
final answer when it comes back with no tool calls, and that same call is the
one that wrote the reply.

### gemma4:26b benchmarked and rejected (2026-08-07 — do not retry)

The dashboard's Model performance card shows `gemma4:26b` at **2.3x the
tokens/sec of 12b**, which read as free speed. A controlled benchmark against the
live endpoint says the opposite: **12b is faster on every call shape**, and
neither model made a mistake.

Both models warmed first (a cold VRAM load would otherwise be charged to
whichever case ran first) and grouped per model to avoid swap thrash. Median of
3 runs each:

| case                     | 12b p50 | 26b p50 | tok/s 12b | tok/s 26b | correct |
| ------------------------ | ------- | ------- | --------- | --------- | ------- |
| classifier (reasoning off) | **646 ms**  | 800 ms   | 26.3 | 21.3 | 3/3 both |
| short reply              | **1689 ms** | 2050 ms  | 59.2 | 37.6 | 3/3 both |
| arithmetic               | **6215 ms** | 6674 ms  | 71.8 | 44.2 | 3/3 both |
| tool selection           | **2619 ms** | 4241 ms  | 61.5 | 41.5 | 3/3 both |
| big prompt (~26k tokens) | **6097 ms** | 10134 ms | 53.3 | 43.3 | 3/3 both |

26b is the more *concise* model — 295 tokens to 12b's 446 on the arithmetic, 77
to 100 on the short reply — but its lower throughput more than cancels that.

**Why the dashboard disagreed, and what to do about it.** `tokensPerSec` on the
Model performance card is `completionTokens / latency` summed over calls made at
different times under different load. Latency there includes time queued behind
other work on a serial endpoint, so the number measures *how busy the box was
while that model happened to be in use*, not how fast the model is. 12b carries
3,189 lifetime calls including every busy period; 26b carries 228, mostly from
quiet ones. The card is not wrong about what it reports — it is a poor proxy for
model speed, and it was read as one here. Worth a hint on the card saying so
before it misleads someone again.

### vLLM measured live (`done` pending live reply verification, 2026-08-12)

**Resolved by the operator on 2026-08-12**: the vLLM config was changed and
re-measured with raw curl against the endpoint. The default request (the reply
path's shape) now thinks and comes back parsed — reasoning in the `reasoning`
field (which the vllm adapter reads), `content` holding only the clean
answer. The classifier shape (`chat_template_kwargs: {enable_thinking:false}`
+ `reasoning_effort`) stays properly off: 11 completion tokens, no reasoning.
Two background traces (history-summaries, memory-extraction) errored with 502
during the restart window — transient, they retry on schedule. Remaining
proof wanted: one live bot reply trace showing reasoning in the response body
and no transcript-marker echo. The original findings below are kept for the
record.

The operator switched chat to a live vLLM (0.26.0, `https://vllm.tcloud.monster`,
`gemma4-12b`) on 2026-08-11 and reported two regressions the next day: replies
leaking transcript markers (`[reply to #560]` delivered to Telegram) and no
reasoning anywhere in Debug. Both trace to one fact, measured with raw curl
against the endpoint:

- **Default template never thinks.** A plain chat completion answers directly —
  19 completion tokens on a live reply trace, `reasoning: ''`. The reply path
  sends `reasoning: default` (leave the model alone) by design, so on this
  server every reply runs thinking-off — the exact mode measured on 2026-08-07
  to produce fabricated facts and wrong arithmetic ("Reply calls keep thinking",
  above). The transcript-marker echo is the same degradation showing up as
  format mimicry.
- **`chat_template_kwargs: {enable_thinking: true}` is broken server-side.**
  Non-streaming, the model thinks (192 completion tokens, `finish_reason: stop`)
  but the response arrives with **both `content` and `reasoning` null/empty** —
  the server's parsing swallows the entire answer. Streaming the same request
  shows why: everything lands in `content` as raw text beginning with Gemma's
  literal `thought` marker — no reasoning parser is separating the channels.
  So the app must NOT force the kwarg on this server: replies would come back
  empty. The vllm adapter's `readReasoning` (`reasoning`/`reasoning_content`)
  is correct — the field exists in the schema and is simply never populated.

**Blocker**: app-side nothing can restore thinking here; the fix is in the vLLM
launch (a reasoning parser that understands the Gemma `thought` format +
template defaulting to thinking on), or keeping chat on llama.cpp (which parses
Gemma thinking natively into `reasoning_content` — the 3-way benchmark already
ranked it best for chat replies). Next decision needed: the operator picks
which; nothing to change in this repo either way.

A code-side mitigation (`stripTranscriptEcho`, mechanically removing echoed
transcript markers from reply text before delivery) was shipped and **reverted
the same day (user decision, 2026-08-12): no code solutions to LLM output
problems.** Model misbehavior is fixed at the LLM level — prompt, model choice,
serving configuration — never by post-processing its text in code. Do not
re-add a reply-text sanitizer. What stays is the LLM-level part: an explicit
input-only rule about the transcript format in `BASE_SYSTEM_PROMPT`'s Reply
format block. The real fix for the leakage is restoring thinking (the blocker
above).

## Reply latency (`todo`, 2026-08-07)

From the production trace/analytics review, 2026-08-07 (1,939 traces,
2026-07-22 → 2026-08-07):

- Replies run **p50 36.8s, p90 86.8s**.
- **90% of every generated token is hidden `reasoning`** — a measured reply
  averaged 78 characters of answer against 3,895 of reasoning. One sample reply
  that emitted no reasoning returned an 80-character answer in **3.0s** against
  **49.3s** for a same-sized answer with 10,964 characters of reasoning.
- The two pre-reply gates (`addressing-check` 206 min, `chat-rule-match` 123 min)
  are **37% of all LLM wall time**, against 60 min for reply generation itself —
  and both sit on the critical path, costing the median reply ~13.5s before
  generation starts. 1,704 of those turns ended in silence.
- `gemma4:26B` measured **2.3x faster per token** than `gemma4:12b` across every
  call kind — worth checking the 12b's GPU layer split.
- ~~Interactive calls bypass the priority gate with no concurrency limit~~ —
  capped at 4 on 2026-08-07.
- ~~The 24h history window is injected as one message, invalidating the KV
  prefix~~ — **measured and wrong**. The real cache-breaker was the per-sender
  blocks sitting *above* the window; fixed 2026-08-07.

Blocked on the normalization layer above by user decision (2026-08-07): the
thinking fix is exactly a per-backend knob, so it lands after the seam exists.

## Live checks not yet run (`todo`)

Eleven checks written down between 2026-07-29 and 2026-09-02 and never reported
as run. The work each belongs to shipped and is documented under `docs/`, so
the entries that carried them were pruned — git history has the full write-ups.
The "pending production deploy" half of those old labels is long satisfied (the
platform has released since); what is left is the live half.

- **Hosted-backend directives** (2026-08-14) — read the first live trace on a
  hosted backend and confirm the tool-call and system-turn directives still land
  the way they were tuned to.
- **Anthropic backend, key in hand** (2026-08-14) — the operator's step, since
  the assistant never handles keys: create the backend with a real key, Test
  connection should list `claude-*` models, then point the chat or vision role
  at it. Same for the Gemini backend type.
- **Reasoning-channel re-emission** (2026-08-07) — the photo-reply retry is one
  extra round, not a cure. If the model re-emits into the reasoning channel a
  second time the turn still fails; watch whether it does.
- **Agent failure verdict** (2026-08-12) — a real failed run (an
  impossible download) should settle `failed` carrying the quoted reason, and a
  yt-dlp failure away from the big media platforms should show retry and
  fallback attempts in the run activity before any failure report.
- **Cancelling a task from a group** (2026-08-05) — ask the bot in a group to
  cancel a task and confirm it disappears from the tasks page. The run worth
  watching is a *failed* cancel: the bot must not claim success it did not have.
- **A rule turn that calls no tool** (2026-08-03) — post a media link in a
  rule-bearing group and confirm the video arrives; the failure path is the
  patient one to watch.
- **yt-dlp updater against real GitHub** (2026-08-01) — never run live; the
  tests stub `fetch`. First real proof is **Run now** on the updater card and a
  version badge that moves.
- **Poller survives an outage** (2026-08-01) — pull the network for a few
  minutes with the bot running: status should flip to error with
  `reconnecting automatically`, log one line, and the bot should be back
  within ~15s.
- **Agent chat delivery** (2026-08-01) — send a media video link through
  the bot: the ack should arrive without a ping and vanish when the video posts,
  and the video should play inline carrying the reply.
- **Classifier token cap** (2026-08-01) — confirm addressing-check traces parse
  and completion tokens stay well under the 3,000 cap. A `finish_reason:
  "length"` means the cap is too low.
- **Overview Start/Stop while signed in** (2026-09-02) — the routes were proved
  to exist, but the preview browser holds no session, so a signed-in click on
  the Overview bot control's Start/Stop was never exercised.

## Other open items

- **MCP tools: platform tools on the transport, everything else the user's
  own (`todo`, raised by the user 2026-09-02)** — The user's direction: a
  transport exposes only its platform's tools (Telegram: reply, send, react),
  and a person connects their own MCP servers to an assistant — a Home
  Assistant server to control a smart home, say — with no relation to any
  transport. **What exists already matches the split**
  (`docs/features/tool-connections.md`): each transport's MCP server is a
  *managed* connection scoped to that source; any account adds a remote MCP
  server on `/tools` (`POST /api/tool-connections`: URL + auth headers,
  discover → apply), scoped to all or chosen assistants; the core's own tools
  (history, memory, tasks, browsing, images) are in-process. **What falls
  short for the Home Assistant case, to decide with the user:**
  1. A `user`-role account's connections must target public addresses
     (`isSafePublicUrl` — the SSRF guard), so a LAN Home Assistant
     (`http://homeassistant.local:8123/mcp_server/sse`) is refused unless an
     admin owns the connection. Options: a per-deployment allowlist of private
     hosts the admin grants; or admin-only for private endpoints (status quo).
  2. Only header auth (`authHeaders`, e.g. a long-lived Bearer token). OAuth
     2.1 MCP servers (the growing default) cannot be connected. Would need the
     authorization-code flow with token storage per connection.
  3. Discover → Apply is manual: a user who adds a server must press Apply
     before the assistant sees the tools; a server that adds tools later
     shows drift until re-applied. Fine for operators, unexplained for a
     first-time user — the Tools page could apply on create for user-owned
     connections (the managed rows already do).
  4. Per-assistant scope only; no per-chat or per-person scope (v2 decision).
     A person's private tools (their own home) are usable by everyone who can
     talk to that assistant. Worth revisiting: bind a user-owned connection
     to the owner's linked identities so only their turns get the tools.
  5. Transport tools are one server per transport, offered whole. If a
     transport grows tools that only some assistants should have, the
     managed connection's assistant selection already covers it.
  6. The `stdio` transport is modelled but refused (the core makes the calls
     over HTTP); local stdio MCP servers need a bridge.
  Recommended next step: confirm items 1, 3 and 4 with the user, then a small
  entry per item. No tool-routing/capability router (standing decision).

- **A transport's admin on/off switch has no route or UI (`todo`, 2026-09-01)**
  — `server/transports/service.ts` has `setTransportEnabled` and the
  `transports.enabled` column folds into the desired state (a disabled
  transport runs nothing), but nothing calls it: there is no `PATCH
  /api/transports/{id}` and no control on the dashboard, so the column stays
  at its default. PLAN.md's "appears in the dashboard, where an admin enables
  it" is unimplemented. Small: one account-level route gated to admins plus a
  toggle where the registered transports are listed.

- **Telegram-only surfaces in the core (`todo` — needed before a second
  transport is useful to an operator; recorded 2026-09-01)** — the runtime
  contract is source-agnostic (registration, ingest, turn pipeline, delivery,
  tool scoping, outbound port), but several dashboard and content surfaces are
  keyed by the literal `"tg"`: the Overview bot card
  (`server/transports/status.ts`), the history/search/summaries/analytics
  content plane (`server/source/tg-content.ts`, user decision 2026-08-27 that
  the content plane is Telegram-only), the Users/Groups directories
  (`features/known-users`, `features/known-groups`, `DIRECTORY_SOURCES`), the
  vision gallery (`features/vision/server/repository.ts`), scoped-ref defaults
  in memory/tasks/self-improvement writes, timed task fires
  (`features/tasks/server/fire.ts` binds `source: "tg"`, so a scheduled task
  always delivers through Telegram), the trace trigger kind
  (`"telegram"`), and three literal registries a new source id must be added
  to (`SOURCE_IDS`, `TRANSPORT_SOURCE_IDS`, the app-scope select in
  `ConnectionsManager.tsx`). The full list with file paths is in
  `docs/development/adding-a-transport.md` ("Known Telegram-only surfaces").
  Widening each is a lookup over the registered transports instead of a
  literal; decide with the user whether to do it ahead of a second transport
  or alongside one.

- **Local Telegram Bot API server (`todo`; operator-requested, 2026-08-01)** —
  the standard Bot API caps bot uploads at 50 MB, which is what forces the
  attach-or-fail path for most videos. Running the official
  `telegram-bot-api` server locally raises the ceiling to 2 GB, so nearly every
  browser-agent download could actually reach the chat. Scope when picked up: a
  new Compose service, grammY pointed at the local endpoint (`apiRoot`), token
  logout/login migration between cloud and local API, and a decision on where
  its file store lives. New infrastructure — present the design per the
  Decision Notes process before building.

- **Ukrainian idiomatic joke requests never trigger tools on gemma4:12b
  (`blocked` on a model decision;** from the 2026-07-27 "lied about scheduling"
  trace `64067530…`**)** — a persona-mode, third-person recurring gag request
  in idiomatic Ukrainian ("let \<persona\> send everyone ... once a day",
  phrased colloquially) made the model claim it had scheduled the task without
  calling `tasks_create`. Fixes landed: the base prompt's Honesty rules now
  bind action claims to tool calls (in character too), the Conversation rules
  treat third-person requests about the bot as requests to it, and the
  `tasks_create` description covers joke/third-person recurring phrasings —
  verified live: the model no longer fabricates the action, and both the
  identical English joke phrasing and a plain Ukrainian daily-reminder request
  now select `tasks_create`. But the idiomatic-Ukrainian variant failed 5/5
  live runs — a cross-lingual gap in gemma4:12b itself. The English variant is
  pinned in `features/scheduled-tasks/server/tool-selection.integration.test.ts`;
  the Ukrainian one is deliberately NOT pinned in code (no Cyrillic in code —
  user rule, 2026-07-27) and lives only in the exported trace. Next decision
  needed (operator): try a stronger/tool-tuned model in Settings for the reply
  path, or accept the gap; re-verify against the trace phrasing after any
  model change. Related observation feeding the same decision: the plain
  English "what reminders do I have?" live case intermittently fabricates a
  full reminder list without calling `tasks_list` (seen 2 of ~6 live suite
  runs, 2026-07-27) — same bluffing pattern, worth including when evaluating a
  replacement model.

- **Context-free reminders + bluffing instead of searching history
  (`in-progress`;** from the 2026-07-28 traces `257ad4e9…` and `925ecf31…`, plus
  the operator's account of how the task was set up**)** — one incident, two
  defects, at opposite ends of the same feature.

  *What happened.* A person was discussed in the chat over several days. A user
  asked the bot to remind another participant daily who that person is. The bot
  created a scheduled task whose instruction was the surface phrasing of the
  request ("remind X who \<person\> is") rather than the substance, so every fire
  delivered that sentence back — a reminder that points at a fact instead of
  carrying it. When the reminded user then asked outright who the person was, the
  bot never called a history tool across five consecutive turns
  (`finish_reason: stop`, zero tool calls, all 21 tools offered), accused them of
  faking amnesia, and answered with an empty metaphor. Its own reasoning trace
  states it cannot find the term, then improvises anyway.

  *Root cause of the reminder half.* `fireScheduledTask` composes base prompt +
  persona + specialist + language + directive and **loads no transcript at all**
  (`features/scheduled-tasks/server/fire.ts`), so the firing model has no way to
  know what the instruction refers to. `tasks_create` only ever asked for a
  "self-contained" instruction without saying that self-contained means carrying
  the facts.

  *Fixes landed* (design decision — operator, 2026-07-28: fix at **both** ends
  rather than either alone, since a 12B model may miss either step):
  1. **Grounding** block in `BASE_SYSTEM_PROMPT`
     (`features/bot-messaging/server/prompt.ts`) — factual claims limited to
     transcript / durable memory / this-turn tool results; searching history is
     mandatory for an unfindable reference; "I don't know" is an acceptable
     answer; covering a gap by accusing the asker is forbidden; the persona
     governs tone and never truth.
  2. **`TASKS_CREATE_DESCRIPTION`** (extracted to an exported constant so it can
     be pinned) — states that a fire sees only the instruction text, requires
     `history_search` → `history_get_in_range` before creating a task that
     references chat-specific people/events/topics, requires the findings be
     written into the instruction, and says to ask the user rather than store an
     empty pointer. Same rule echoed on the `instruction` field of
     `tasks_create`/`tasks_update`.
  3. **`buildTaskDirectiveMessage`** (`fire.ts`) — second line of defence: tells
     the fire it has no transcript, to look the reference up in history before
     writing, and to be honest rather than parrot the directive when the lookup
     comes up empty. The fire already runs with the full toolset bound to the
     task's chat, so the lookup is available.

  Files changed: `features/bot-messaging/server/prompt.ts` + `prompt.test.ts`,
  `features/scheduled-tasks/server/mcp-tools.ts` + `mcp-tools.test.ts`,
  `features/scheduled-tasks/server/fire.ts` + `fire.test.ts`. Verified:
  `npm test` (74 files, 727 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Live re-test of the reply half: failed* (trace `f79f84a2…`, 2026-07-28). Asked
  "хто такий Мурадян?" the bot again called no tool and again answered with a
  metaphor. Its reasoning block names the source explicitly: *"looking at my
  previous response (#13164), I defined it as a symbol of bypassing direct routes"*,
  padded with general knowledge (*"in common underground/internet/tech contexts
  (especially in Ukraine), 'Muradyan' often refers to…"*). The term occurs five
  times in the 24-hour window: twice asserted by the bot, three times as
  participants asking what it means. **No human ever said what it is** — the bot
  invented it, then read its own invention back as established fact.

  *Root cause of the miss.* Grounding declared "the transcript" a source
  wholesale, and a bot line is transcript. The rule's own bot-specific clause
  ("if you cannot back it up, say so") reads as being about *honesty under
  challenge*, not about *what counts as evidence*, so a self-confirming loop
  passed it.

  *Second round of fixes* (design decision — operator, 2026-07-28: **rank the
  sources**, prioritize user-sourced information over bot-sourced; enforcement
  stays in the prompt — *"we never solve model problems by code"* — so no gating,
  forced retrieval, or verifier pass):
  4. **Grounding** rewritten around source rank: fact = what a *person here*
     said, durable memory, or a this-turn tool result. The bot's own messages are
     "never a source" and are declared unreliable outright — wrong, stale,
     polluted by the conversation, or invented. People outrank the bot; a user
     correction is taken as correct. A term appearing *only* in the bot's own
     lines is named as the not-known case, with re-deriving a meaning from its
     own earlier wording forbidden. Mirrors what memory extraction already does
     (`EXTRACTION_SYSTEM` refuses to harvest facts from bot lines).
  5. **`TRANSCRIPT_PREAMBLE`** (`features/history/server/format.ts`) — says it at
     the point of use: the other people's lines are what was said, the bot's own
     are not evidence and may be wrong or invented.
  6. **History tool results carry provenance**
     (`features/history/server/mcp-tools.ts`) — each line names its author in
     words (`a participant` / `you (the bot)`) instead of the wire role, and a
     result whose every row is bot-authored appends
     `SELF_AUTHORED_ONLY_NOTE` ("…this result confirms nothing… Treat this as not
     found."). The only code-side change, and only because the prompt's source
     ranking is unusable if a lookup hands back rows without saying whose they
     are. `structuredContent.role` is unchanged for machine consumers.

  Files changed (round 2): `features/bot-messaging/server/prompt.ts` +
  `prompt.test.ts`, `features/history/server/format.ts` + `format.test.ts`,
  `features/history/server/mcp-tools.ts` + new `mcp-tools.test.ts`. Verified:
  `npm test` (75 files, 739 passed), `npm run lint`, `npm run typecheck` — all
  clean.

  *Third round: dedicated `context` field* (rework — user direction, 2026-07-31:
  instead of one-liner instructions the bot has to **gather and save context**
  when creating a task; asking for the facts to be woven into the instruction
  text, round 1's approach, still produced one-liners in practice):
  7. **`scheduled_tasks.context` column** (nullable text; migration
     `db/migrations/0045_first_metal_master.sql`) threaded through the row
     mapper, repository insert/update, service create/update (trim + 4000-char
     bound, blank stores null), and `ScheduledTask`.
  8. **Tool contract**: `tasks_create` gains a **required** `context` input —
     the gathered background, written self-contained for a reader with no chat
     transcript; `''` allowed only for a fully self-contained instruction.
     `TASKS_CREATE_DESCRIPTION` reworked around "GATHER CONTEXT BEFORE
     CREATING" (from the visible conversation or `history_search` /
     `history_get_in_range`), keeping the ask-instead-of-storing-a-pointer and
     third-person/gag rules. `tasks_update` gains an optional `context`
     replacement; `tasks_get`/`tasks_list` structured views include it.
  9. **Fire prompt** (`buildTaskDirectiveMessage`) — a "Saved context" block
     carries the stored background into the fire; the history lookup stays as
     fallback for tasks that predate the field.
  10. **Dashboard** — optional Context textarea on create and edit
     (`ScheduledTasksManager`), context shown on task cards; dashboard API
     create/patch accept it (`context: null` clears on patch).

  Files changed (round 3): `db/schema.ts` + migration 0045,
  `features/scheduled-tasks/{types.ts, server/repository.ts, server/schema.ts,
  server/service.ts, server/mcp-tools.ts, server/fire.ts,
  ui/ScheduledTasksManager.tsx}`, `app/api/scheduled-tasks/route.ts`, tests
  (`fire.test.ts`, `mcp-tools.test.ts`, `scheduled-tasks.integration.test.ts`).
  Verified: `npm run lint`, `npm run typecheck` clean; `npm test` 84 files /
  852 passed; `npm run test:integration` 25 files / 338 passed (11 live files
  skipped); `npm run build` green after the operator re-ran the `data/pg`
  chmod (the recurrence is tracked below).

  *New evidence for the model half* (trace `e5f96e23…`, 2026-07-31): asked (in
  Ukrainian) to *update* the Muradyan task with the PS5/donations backstory,
  gemma4:12b's reasoning correctly narrowed to the scheduled task and literally
  ended "Let's do that check" (meaning `tasks_list`) — then the generation
  emitted a plain chat message claiming the context was saved
  (`finish_reason: stop`, `tool_calls: null`, all 25 tools offered). The
  decision died crossing from the reasoning channel to generation; no prompt
  text can bind that. Two levers, both operator decisions: (a) the standing
  model-replacement question below; (b) injecting the chat's scheduled tasks
  into the reply-turn system context (like memory/rules) so "the task" resolves
  without a `tasks_list` round-trip — costs tokens per turn, not implemented.

  **Remaining risk / next step (operator):** still unverified live, and still the
  same gemma4:12b tool-avoidance pattern as the `tasks_list` fabrication in the
  item above — round 1's prompt text was ignored, and rounds 2–3 add more prompt
  text plus a required tool field, so the model may ignore them too. Re-run
  live: ask the bot who "Мурадян" is again; a pass is "I don't know / nobody
  here ever said". Also re-run the task half (create a reminder that references
  a chat-only topic — a pass now includes a filled `context` on the created
  row; then ask the bot what that topic is). Existing thin task instructions
  are deliberately **not** migrated — operator fixes those through the bot
  (decision, 2026-07-28); old rows simply have `context = null` and keep the
  history-lookup fallback. If the model still refuses to search, this folds
  into the same model-replacement decision. Known remaining laundering path,
  not addressed: `history_recall_topics`
  serves daily topic summaries, which are written over both sides of the
  conversation — a bot-invented term can therefore re-enter through a summary
  with no author attached. Decide whether summaries should mark, or exclude,
  bot-sourced content.

- **`npm run build` dies on `data/pg` whenever the bundled Postgres recreates it
  (`done` for now — one host-side fix, may recur).** Turbopack walks the project
  tree and `data/pg` is created `drwx------` owned by the container's postgres uid,
  so the build ends in `Permission denied (os error 13) … reading dir "…/data/pg"`
  with a `TurbopackInternalError` — nothing to do with the code (`eslint.config.mjs`
  already ignores `data/**` for the same reason; Turbopack has no equivalent).
  The operator ran the chmod on 2026-07-29 and the build was green again. It
  **recurred** on 2026-07-31 (a fresh Postgres volume recreated the dir); the
  operator re-ran the chmod the same day. **Recurred again on 2026-08-01**,
  blocking the build check for the chat-delivery overhaul above, and **still
  failing later the same day** for the poller-supervision work. Four recurrences
  now — worth a documented pre-build step (or a Turbopack-side exclusion if one
  appears).

- **Traces bind-mount permissions (`blocked` on an operator decision;** from
  the 2026-07-22 prod data-loss incident**)** — Docker auto-creates
  `./data/traces` root-owned while the app runs as the non-root `app` user, so
  trace flushes fail with EACCES (now surfaced via the data-loss banner, the
  Overview card and `/api/health`). Host-side workaround: chown the bind mount
  to the container's `app` uid. The permanent Dockerfile fix (root entrypoint
  chowns the mount, then drops to `app` via su-exec) was proposed but not
  implemented — a container security-posture change that needs the operator's
  decision.
- **Search-engine cascade (operator's call)** — engines rank themselves by
  success stats, so the blocked-engines-first configured order self-heals; the
  open question is adding **Brave** as a fourth engine (measured best on
  2026-07-26: 45 relevant results).
- **Memory General-knowledge cleanup (verify)** — the wrong pre-fix lines in
  the General knowledge document (2026-07-17 incident) needed manual removal on
  `/memory`; the pruning merge only runs when a new `general` note arrives.
  Verify the cleanup happened; drop this item if it did.
