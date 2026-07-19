import { unzipSync, zipSync } from "fflate";
import { emitSectionedCsv, findSection, parseSectionedCsv, type SectionedCsv } from "./csv.js";

export function packEnvelope(document: SectionedCsv): Uint8Array {
  return zipSync({ "data.csv": [emitSectionedCsv(document), { level: 6 }] });
}

export function unpackEnvelope(bytes: Uint8Array): SectionedCsv {
  if (bytes.length < 30 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new Error("invalid ZIP envelope: missing local file header");
  }
  const method = bytes[8]! | (bytes[9]! << 8);
  if (method !== 8) throw new Error(`invalid ZIP envelope: data.csv must use Deflate method 8 (found ${method})`);
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); }
  catch (error) { throw new Error(`invalid ZIP envelope: ${(error as Error).message}`); }
  const names = Object.keys(files);
  if (!names.includes("data.csv")) throw new Error("ZIP envelope is missing data.csv");
  if (names.length !== 1) throw new Error("ZIP envelope must contain only data.csv");
  let document: SectionedCsv;
  try { document = parseSectionedCsv(files["data.csv"]!); }
  catch (error) { throw new Error(`invalid data.csv: ${(error as Error).message}`); }
  const versions = findSection(document, "SysVersions");
  const versionIndex = versions?.header.indexOf("FileVersion") ?? -1;
  if (!versions || versionIndex < 0 || versions.rows[0]?.[versionIndex] !== "3") {
    throw new Error('unsupported or missing SysVersions FileVersion (expected "3")');
  }
  // No line-ending validation on inbound envelopes: quoted values may legally
  // contain bare CR/LF (multiline notes), and acceptance is defined by
  // docs/mcp-cloud.md as ZIP + data.csv + parseable CSV + FileVersion only.
  return document;
}
