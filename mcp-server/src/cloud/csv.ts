export interface CsvSection {
  name: string;
  header: string[];
  rows: string[][];
}

export interface SectionedCsv {
  sections: CsvSection[];
  /** Original text makes an untouched parse/emit exactly lossless. */
  source?: string;
}

function parseRecords(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else field += ch;
      continue;
    }
    if (afterQuote) {
      if (ch === ",") { record.push(field); field = ""; afterQuote = false; }
      else if (ch === "\r" || ch === "\n") {
        record.push(field); records.push(record); record = []; field = ""; afterQuote = false;
        if (ch === "\r" && input[i + 1] === "\n") i++;
      } else throw new Error("invalid CSV character after closing quote");
    } else if (ch === '"') {
      if (field.length) throw new Error("invalid quote in unquoted CSV field");
      quoted = true;
    } else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\r" || ch === "\n") {
      record.push(field); records.push(record); record = []; field = "";
      if (ch === "\r" && input[i + 1] === "\n") i++;
    } else field += ch;
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (afterQuote || field.length || record.length) { record.push(field); records.push(record); }
  return records;
}

export function parseSectionedCsv(input: string | Uint8Array): SectionedCsv {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (text.charCodeAt(0) === 0xfeff) throw new Error("data.csv must not contain a UTF-8 BOM");
  const records = parseRecords(text);
  const sections: CsvSection[] = [];
  let current: CsvSection | undefined;
  for (const record of records) {
    if (record.length === 1 && record[0] === "") continue;
    const marker = record.length === 1 ? /^\[([^\]\r\n]+)\]$/.exec(record[0]!) : null;
    if (marker) {
      current = { name: marker[1]!, header: [], rows: [] };
      sections.push(current);
    } else if (!current) throw new Error("CSV row appears before a section marker");
    else if (!current.header.length) current.header = record;
    else current.rows.push(record);
  }
  for (const section of sections) if (!section.header.length) throw new Error(`section [${section.name}] has no header`);
  return { sections, source: text };
}

function writeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function writeCsvRow(fields: readonly string[]): string {
  return fields.map(writeField).join(",");
}

export function emitSectionedCsv(document: SectionedCsv): Uint8Array {
  if (document.source !== undefined) return new TextEncoder().encode(document.source);
  const lines = [""];
  for (const section of document.sections) {
    lines.push(`[${section.name}]`, writeCsvRow(section.header));
    for (const row of section.rows) lines.push(writeCsvRow(row));
  }
  lines.push("");
  return new TextEncoder().encode(lines.join("\r\n"));
}

export function findSection(document: SectionedCsv, name: string): CsvSection | undefined {
  return document.sections.find((section) => section.name === name);
}
