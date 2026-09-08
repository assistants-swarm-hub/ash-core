import { inflateRawSync } from "node:zlib";

/**
 * A minimal reader for `.xlsx` workbooks: the cell values of each sheet as
 * rows of strings. An xlsx is a zip of XML parts, and this needs three of
 * them — the workbook's sheet list, the shared-strings table, and each
 * sheet's cell grid — so the zip container and the two XML shapes are read
 * here directly (Node's zlib inflates the entries) rather than through a
 * spreadsheet library the app would otherwise never need. Formulas yield
 * their cached values; dates come out as the serial numbers Excel stores.
 */

export interface XlsxSheet {
  name: string;
  /** Rows of cell values, left to right, gaps as empty strings. */
  rows: string[][];
}

// ---- the zip container --------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The central directory: every entry's name, method, size and local header offset. */
function readCentralDirectory(zip: Buffer): ZipEntry[] {
  // The end-of-central-directory record is the last thing in the file, its
  // signature scanned for backwards past an optional comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error("corrupt zip directory");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, inflated when deflated (method 8) or as stored (method 0). */
function readEntry(zip: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset;
  if (zip.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new Error("corrupt zip entry");
  const nameLength = zip.readUInt16LE(at + 26);
  const extraLength = zip.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported zip method ${entry.method}`);
}

// ---- the XML parts ------------------------------------------------------------

/** Decode the five XML entities and numeric references. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/** The text of every `<t>` run inside one `<si>` or `<is>` element, joined. */
function richText(xml: string): string {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) out += decodeXml(match[1]);
  return out;
}

/** The shared-strings table, by index. */
function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) strings.push(richText(match[1]));
  return strings;
}

/** A column reference (`A`, `AB`) as a 0-based index. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** One sheet's cells as rows, from its XML. */
function readSheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRe.exec(xml))) {
    const attrs = match[1];
    const body = match[2] ?? "";
    const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
    if (!ref) continue;
    const col = columnIndex(ref[1]);
    const rowIndex = parseInt(ref[2], 10) - 1;
    const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
    let value = "";
    if (type === "s") {
      const idx = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      value = idx != null ? (sharedStrings[parseInt(idx, 10)] ?? "") : "";
    } else if (type === "inlineStr") {
      value = richText(body);
    } else {
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      value = raw != null ? decodeXml(raw) : "";
      if (type === "b") value = value === "1" ? "TRUE" : "FALSE";
    }
    while (rows.length <= rowIndex) rows.push([]);
    const row = rows[rowIndex];
    while (row.length < col) row.push("");
    row[col] = value;
  }
  // Rows the grid never mentioned are empty rows; a trailing run of them is noise.
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

/** The workbook's sheets in order, with the part each one lives in. */
function readSheetList(workbookXml: string, relsXml: string | null): { name: string; part: string }[] {
  const rels = new Map<string, string>();
  if (relsXml) {
    const re = /<Relationship\s([^>]*?)\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(relsXml))) {
      const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
      if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, ""));
    }
  }
  const sheets: { name: string; part: string }[] = [];
  const re = /<sheet\s([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = re.exec(workbookXml))) {
    n++;
    const name = decodeXml(/\bname="([^"]*)"/.exec(match[1])?.[1] ?? `Sheet${n}`);
    const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1];
    const part = (rid && rels.get(rid)) || `worksheets/sheet${n}.xml`;
    sheets.push({ name, part: `xl/${part}` });
  }
  return sheets;
}

/** Every sheet of a workbook as rows of strings. Throws on a file that is not one. */
export function readXlsx(file: Buffer): XlsxSheet[] {
  const entries = readCentralDirectory(file);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const part = (name: string): string | null => {
    const entry = byName.get(name);
    return entry ? readEntry(file, entry).toString("utf8") : null;
  };
  const workbook = part("xl/workbook.xml");
  if (!workbook) throw new Error("not an xlsx workbook");
  const sharedStrings = readSharedStrings(part("xl/sharedStrings.xml"));
  return readSheetList(workbook, part("xl/_rels/workbook.xml.rels")).map((sheet) => ({
    name: sheet.name,
    rows: readSheetRows(part(sheet.part) ?? "", sharedStrings),
  }));
}
