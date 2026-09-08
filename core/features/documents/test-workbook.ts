import { deflateRawSync } from "node:zlib";

/**
 * Test fixtures for the workbook reader: a zip writer and a two-sheet
 * workbook built from the same XML parts a spreadsheet application writes,
 * with the entries deflated (as real files are) or stored. A test helper,
 * not shipped code — it lives beside the reader so the two cannot drift.
 */

/** Build a zip with the given entries — deflated (method 8) or stored (method 0). */
export function buildZip(entries: { name: string; data: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data, "utf8");
    const data = entry.deflate === false ? raw : deflateRawSync(raw);
    const method = entry.deflate === false ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Watchlist" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>`;

const SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>Title</t></si><si><t>Year</t></si><si><r><t>Heat</t></r><r><t xml:space="preserve"> &amp; Cold</t></r></si><si><t>Inception</t></si></sst>`;

const SHEET1 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Seen</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1995</v></c><c r="C2" t="b"><v>1</v></c></row>
<row r="4"><c r="A4" t="s"><v>3</v></c><c r="C4" t="b"><v>0</v></c></row>
</sheetData></worksheet>`;

const SHEET2 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>only &#x41; note &#66;</t></is></c></row>
</sheetData></worksheet>`;

/**
 * A two-sheet workbook: "Watchlist" (a header, a full row, a gap, a partial
 * row — shared, rich, inline and boolean cells) and "Notes & more" (one
 * inline string with numeric references).
 */
export function buildWorkbook(deflate = true): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: "<Types/>", deflate },
    { name: "xl/workbook.xml", data: WORKBOOK, deflate },
    { name: "xl/_rels/workbook.xml.rels", data: RELS, deflate },
    { name: "xl/sharedStrings.xml", data: SHARED, deflate },
    { name: "xl/worksheets/sheet1.xml", data: SHEET1, deflate },
    { name: "xl/worksheets/sheet2.xml", data: SHEET2, deflate },
  ]);
}
