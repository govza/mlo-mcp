import { describe, expect, it } from "vitest";
import { emitSectionedCsv, parseSectionedCsv } from "../../src/cloud/csv.js";

describe("sectioned CSV", () => {
  it("parses RFC-4180 commas, doubled quotes, and multiline fields", () => {
    const source = '\r\n[Known]\r\nA,B\r\n"comma,value","a ""quote""\r\nand line"\r\n\r\n';
    const parsed = parseSectionedCsv(source);
    expect(parsed.sections[0]!.rows[0]).toEqual(["comma,value", 'a "quote"\r\nand line']);
    expect(new TextDecoder().decode(emitSectionedCsv(parsed))).toBe(source);
  });

  it("preserves unknown sections, extra columns, and boundary CRLF byte-identically", () => {
    const source = "\r\n[SysVersions]\r\nFileVersion,ProgramVersion,Edition,Future\r\n3,6.1.3,MLO-Windows,x\r\n[Future.Section]\r\nUnknown,More\r\na,b\r\n\r\n";
    const parsed = parseSectionedCsv(source);
    expect(parsed.sections[0]!.header.at(-1)).toBe("Future");
    expect(parsed.sections[1]!.name).toBe("Future.Section");
    expect(emitSectionedCsv(parsed)).toEqual(new TextEncoder().encode(source));
  });

  it("emits generated documents with CRLF boundaries", () => {
    const bytes = emitSectionedCsv({ sections: [{ name: "X", header: ["A"], rows: [["b\nc"]] }] });
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("\r\n")).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text).toContain('"b\nc"');
  });
});
