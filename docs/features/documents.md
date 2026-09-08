# Documents

**Feature ids:** `documents`, `mcp-tools-documents` · **Dashboard:** `/vision`
(the media gallery) · **SSE topic:** `vision`

A text-like file someone sends in a chat — a CSV export, a JSON dump, a
spreadsheet, notes — kept **whole** so an assistant can read it, page by page,
through one tool. Documents are the input the collections import will take;
on their own they answer "what does this file say" (user decision,
2026-09-08).

## What a document is

The contract decides (`packages/contracts/src/documents.ts`), and both sides
read the same definition: a transport decides what to forward with it, the
core refuses the same things again on ingest.

| Rule | Value |
| --- | --- |
| Formats | CSV, TSV, JSON, XLSX, TXT, MD — judged by the filename's extension first, the mime type second (`documentFormatOf`), because platforms guess mime types loosely (`text/plain` for a `.csv`, `application/octet-stream` for a `.xlsx`) while the name is what the person chose |
| Cap | `DOCUMENT_MAX_BYTES` = 10 MB. A contract constant, not a setting: a transport must know the cap **before** it downloads, and one definition read by both sides cannot drift |
| Anything else | A PDF, an archive, a binary — not media. A transport names it in the message text and forwards nothing; the core sees a message with words, not a failed attachment |

## How one travels

On the wire, a document is `transportMediaSchema` with `kind: "document"`, the
whole file as the one base64 frame, its `mimeType`, and the new `filename`.
The Telegram transport checks the platform's declared size against the cap so
an oversize file is never downloaded, and reports it as `unavailable` (the
core must still know the message HAD a document); the Discord transport
forwards the first readable attachment and names the rest.

The web chat takes a document on the same message route as an image or a
voice note (`document: { dataBase64, mimeType?, filename }`, capped to the
contract's bytes), through a second attach button in the composer. An
unsupported or oversize file is a refused post (`400`), not a message with a
hole in it.

## How one is kept

A document is a media row like a photo or a voice note, with one difference
that runs through the whole media lifecycle: it is **born `described`** — its
label (name, format, size) is its description from the moment it is stored —
and it **keeps its bytes**. A transport's photo is described by the vision
model and then loses its bytes (the platform is its own archive); a document
is never described, no backfill ever claims it, a describe pass that reaches
it skips ("a document is kept whole, never described"), and its bytes stay
because the core reads them later and the platform may not serve the file
again. The rows carry two new columns, `filename` and `size_bytes`, on both
`source_media` and `web_media` (migration `0020`).

An ingest that finds a document over the cap or not a carried format —
whatever the transport sent — stores it `unavailable` with the reason in the
hint.

## How one reads

In the transcript a document reads as ` [document: <label>, id <media id>]`
— the id is what the tool takes. In the turn that answers the message that
carried it, the model is told the same (the label, the id, and that the
content is not in the message), not the content: a 500-row export is not
something to paste into a prompt.

The **`read_document`** tool (`features/documents/server/mcp-tools.ts`)
reads only documents of the bound conversation — a document is that chat's
data, and an id from elsewhere answers "not in this conversation", which is
all a model may learn about it. It answers in windows:

| Format | Shape | Window |
| --- | --- | --- |
| CSV, TSV, XLSX | `rows` | A header (when the first row looks like one — all non-empty, non-numeric text) plus data rows: default 50, at most 200, with the total and `has_more`. A workbook lists its sheets and reads one at a time, by name or index |
| JSON, TXT, MD | `text` | A character range: default 6000, at most 20 000, with the total length and `has_more` |

The text rendering the model reads names the range and where to continue;
the structured content carries the same as data. A file that is not what its
format says (a workbook that is not a zip) is an honest error result, never a
guess.

The readers are the feature's own and dependency-free: a one-screen RFC 4180
parser (`csv.ts`) and a workbook reader (`xlsx.ts`) that walks the zip
container with Node's zlib and reads the three XML parts a cell grid needs —
shared strings, the sheet list, the cells. Formulas yield their cached
values; dates come out as Excel's serial numbers.

## Dashboard

A document shows in the media gallery on `/vision` as a file card — name,
size, a download — with the status "Kept". `GET /api/documents/{id}` serves
the bytes as a named download for any source's row. The web chat's thread
view shows a document message as a download link.

## Tracing

`mcp-tools-documents` carries every read; the tool call's own trace records
the window asked for and the range answered. Ingest and the turn record the
document as they do any media.

## Tests

Unit: `csv.test.ts`, `xlsx.test.ts` (against workbooks built from the same
XML parts a spreadsheet application writes, deflated and stored),
`read.test.ts` (windows, paging, caps, sheets), `format.test.ts` (the label
and the turn notes), `server/mcp-tools.test.ts` (the conversation scope,
paging, an unreadable file, the description), `packages/contracts`'s
`documents.test.ts` (the format predicate). Integration: the conversation
store keeps a document whole and out of the backfill's reach
(`server/source-store/source-store.integration.test.ts`); the web chat stores
one born described and refuses a non-document
(`features/web-chat/server/web-chat.integration.test.ts`). Each transport's
normalizer is tested in its own repository.
