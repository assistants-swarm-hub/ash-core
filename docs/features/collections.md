# Collections

**Feature ids:** `collections`, `mcp-tools-collections` · **Dashboard:**
`/collections` · **SSE topic:** `collections`

An assistant's **structured data**: a watchlist, a reading list, recipes,
expenses — anything with repeating items. A collection is a table of **typed
columns the model proposes from the data and code enforces**; its rows are
filled from chat, from a file sent in the conversation, and by background
agents looking things up. Domain-agnostic by design: no template library, no
schema-less rows (user decisions, 2026-09-08).

The scenario it was built for: export a watchlist from a site, send the CSV to
a movie assistant, have it store the file; ask it to fill what the file lacks
and it works in the background; from then on a standing rule adds every link
of that kind, looks it up, presents it the usual way and asks for a rating.

## What a collection is

| Part | Rule |
| --- | --- |
| Owner | One assistant (`assistant_id`, cascade). Up to 16 per assistant |
| Columns | Up to 64, each `{ key, label, type, options?, scale?, isKey, requiredForComplete }`. Types: `text`, `long_text`, `number`, `date`, `url`, `image` (a URL the chat previews), `list`, `enum` (fixed options), `rating` (0..scale, default 10), `boolean` |
| Key | Exactly one `isKey` column (`text`, `number` or `url`): the item's identity — the site's id, the URL. A write whose key exists **updates** that row. The key column cannot change while rows exist |
| Complete | A row is complete when every `requiredForComplete` column holds a value; the rest are its **gaps**. Recomputed on every write and on a column change |
| Values | Checked against the column's type on every write — a bad value is refused with the column named, never coerced. Empty is accepted everywhere and stored as `null` (a gap) |
| Visibility | `private` (default): only senders holding owner rights see it. `shared`: anyone in a chat with the assistant may read and query. Writes are owner-only either way |
| Instructions | Two free texts the owner writes: how to **fill gaps** (which site, what to record) and how to **present** an item in chat. Composed verbatim into the assistant's prompt |
| Rows | Up to 50 000 per collection; query pages of up to 50 |

The rules live in `features/collections/columns.ts` (pure, client-safe), so
the service, the tools, the Route Handlers and the dashboard's editors judge
by the same code.

## Rights

Judged inside the service, never by a prompt: a chat caller is
`{ assistantId, ownerRights }` where owner rights are the source's owner stamp
on the sender (`sender.isOwner`) or the authority a standing task lent
(`authorityIsOwner`). A collection the caller may not see reads as unknown
(`not_found`), never as forbidden. The dashboard is scoped through assistant
ownership: a user-role account sees and edits its own assistants' collections.

## The prompt block

Every reply turn, task fire and background agent run gets a compact block
listing the collections it may see: name, **id**, row count, rows with gaps,
visibility, the columns in one line each, and the two instructions. It is
what makes the tools usable without a list tool — ids come from the block —
and it carries the number a fill loop ends on: a fire that reads "no gaps"
sends its one completion message and deletes its own task; one that reads
gaps starts a quiet agent and stays silent (decision 7).

In the reply and fire prompts the block sits in the system prompt above the
standing tasks (`buildSystemPrompt({ collections })`); in an agent run it sits
right after the persona. `buildCollectionsBlock` in `features/collections/format.ts`
owns the wording, and the Instructions tab previews exactly that text.

## Tools

Offered **per assistant by data presence**: `collections_create` always (the
first collection has to come from somewhere); the rest once the assistant has
at least one collection. The fact is resolved once per toolset by the
feature's scope-facts resolver (`collectionsScopeFacts`, run by the registry's
`resolveScope`) and read by its offer predicate. This varies by a stable fact
of the turn, not by message content, so the "no toolset routing" decision
stands.

| Tool | Input | Purpose |
| --- | --- | --- |
| `collections_create` | `name`, `description?`, `visibility?`, `fill_instruction?`, `presentation_instruction?`, `columns[]` | Create a collection from a confirmed proposal. Owner only |
| `collections_update` | `collection_id`, any of the above | Change texts, visibility or the column list (replaces it whole; a dropped column loses its values). Owner only |
| `collections_delete` | `collection_id` | Delete with every row. Owner only |
| `collection_import` | `document_id`, `collection_id` \| `proposal`, `mapping?`, `sheet?` | Import a document of this conversation in one call: map file columns onto collection columns (by header name, label, or an explicit mapping), check every value, upsert by key, report counts and per-row skip reasons. Owner only |
| `rows_add` | `collection_id`, `values` | Add an item, or update the one with that key. Owner only |
| `rows_update` | `collection_id`, `row_id` \| `key`, `values` | Change some columns of one item. Owner only |
| `rows_delete` | `collection_id`, `row_id` \| `key` | Delete one item. Owner only |
| `rows_get` | `collection_id`, `row_id` \| `key` | One item in full, with its gaps |
| `rows_query` | `collection_id`, `query?`, `filters?`, `gaps?`, `sort?`, `direction?`, `offset?`, `limit?` | Find items: typed column filters (`eq neq contains gt gte lt lte empty not_empty`), the gaps switch, a sort, free text, paging with the total and `has_more` |

Every tool self-describes and names no other tool. Every row answer is one
line per item — `id · col=value; … [gaps: …]` — plus the structured form.

### Search

`rows_query`'s free text is **semantic** when an embedding model is configured
(Settings): the text is embedded with the memory feature's client and rows are
ranked by cosine distance over `collection_rows.embedding`, filters still
applied. Without a model it is a substring match over the row's cells. Rows are
embedded from a `label: value` rendering of their filled cells on every write
(and per batch on import), best-effort: a failing endpoint costs the vector,
never the write.

## Import

The one-confirmation flow (decision 12): the assistant reads the document's
header with `read_document`, proposes a collection (name, typed columns, the
key, the "needed for complete" set) and the mapping, asks once, then calls
`collection_import`. Code parses CSV, TSV, XLSX (one sheet, by name or index)
or a JSON array of objects, maps by header name or label unless told otherwise,
checks every value like any other write, merges a repeated key within the file
(the later record's cells win), updates existing rows without blanking what
the file lacks, and reports `inserted / updated / skipped[]` with reasons.
The trace records the mapping, the counts and the skips; rows remember the
document as `source_document_ref` (`<source>:document:<media id>`). Only a
document of the bound conversation can be imported — the same rule as reading
one.

## The fill-the-gaps loop

No worker (decision 6): "fill the gaps" makes the assistant create an interval
Task in the chat; every fire reads the block, and while it shows gaps it starts
one quiet background agent (`start_agent`) whose goal is the batch — query with
`gaps: true`, look each item up per the fill instruction, `rows_update` it.
The agent runner executes one run at a time, so a later fire simply re-queries
and continues. When the block shows no gaps the fire sends the completion
message and deletes its own task. Progress on the dashboard is complete/total,
live.

The standing rule ("whenever I send a link of this kind …") is a prompt-kind
Task; the rating is asked in plain text and applied in the next turn with
`rows_update` (decision 8).

## Dashboard

`/collections` — account level. The assistant is a URL facet (`?assistant=`),
the selected collection a parameter (`?collection=`), the tab another
(`?tab=`). Cards show rows, gaps and a completeness bar. Per collection, the
shared Tabs:

- **Rows** — search (`q`), gaps switch, sort and direction, typed filters
  (`filters` as JSON in the URL), pagination; add, edit (a form per column
  type) and delete rows. Images render as thumbnails, URLs as links.
- **Columns** — the column editor: key, label, type, options, scale, the key
  column (pinned while rows exist), the required set. Saving reshapes every
  row.
- **Instructions** — name, description, visibility, the two instructions, and
  a live preview of the prompt block.
- **Activity** — the collection's traces, each linking into Debug.

Export CSV downloads the whole collection with the column keys as header. The
page live-updates over the `collections` topic.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/collections?assistant=` | — | `Collection[]` of the caller's assistants |
| `POST` | `/api/collections` | `{ assistantId, name, description?, visibility?, fillInstruction?, presentationInstruction?, columns }` | The collection — **201** |
| `GET` / `PATCH` / `DELETE` | `/api/collections/{id}` | any editable subset | The collection / `{ deleted: true }` |
| `GET` | `/api/collections/{id}/rows?q&gaps&sort&direction&offset&limit&filters` | — | `{ rows, offset, limit, total, hasMore, semantic }` |
| `POST` | `/api/collections/{id}/rows` | `{ values }` | `{ row, created }` — **201** when new, 200 on a key update |
| `GET` / `PATCH` / `DELETE` | `/api/collections/{id}/rows/{rowId}` | `{ values }` | The row / `{ deleted: true }` |
| `GET` | `/api/collections/{id}/export` | — | CSV download |

All account level, gated through the collection's assistant.

## Tracing

Every mutation is a `collections` trace related to the collection id:
`create`, `update` (with the changed fields and rows reshaped), `delete`,
`row-add`, `row-update`, `row-delete`, `import` (the document, the mapping,
the headers, every batch's counts, the skips). Tool calls trace under
`mcp-tools-collections`. The reply, fire and agent traces record
`collectionsApplied` / `collectionsComposed`.

## Tests

- `features/collections/columns.test.ts` — the column rules and value typing.
- `features/collections/format.test.ts` — the prompt block.
- `features/collections/server/mcp-tools.test.ts` — registration, the offer
  rule, rights and provenance handed to the service, the import's
  conversation scope.
- `features/collections/server/collections.integration.test.ts` — the
  service against a real database: rights, identity by key, typed refusals,
  gaps, the query, reshaping, caps, export, import.
- `features/mcp-tools/server/service.test.ts` — the catalog and what a turn
  without a collection is offered.
