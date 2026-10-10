import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { analyzeDocx, applyDocx, docxText } from "../lib/redaction/docx";
import { buildRules } from "../lib/redaction/rules";
import { EMPTY_CONTEXT } from "../lib/redaction/types";

const rules = buildRules({
  ...EMPTY_CONTEXT,
  fullName: "Juan Carlos García López",
  dateOfBirth: "1990-03-14",
  aNumber: "012345678",
  street: "123 West 45th Street Apt 4B",
  city: "Brooklyn",
  state: "NY",
  zip: "11201",
});

describe("docx redaction", () => {
  it("removes the client's details and keeps everyone else's", async () => {
    const buf = readFileSync("tests/fixtures/sample.docx");
    const session = await analyzeDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), rules);
    const selected = new Set(session.findings.filter((f) => f.selected).map((f) => f.id));
    const images = session.findings.filter((f) => f.category === "signature" && f.text === "[image]");
    expect(images.length).toBe(1);
    const blob = await applyDocx(session, selected);
    const out = Buffer.from(await blob.arrayBuffer());
    const text = await docxText(new Blob([out]));
    for (const gone of ["Juan", "López", "Lopez", "March 14, 1990", "A012345678", "123 West 45th", "11201", "03/14/1990"]) {
      expect(text).not.toContain(gone);
    }
    for (const kept of ["Maria Garcia", "Julia Kwong", "Pedro Martinez", "01/02/1985", "A-987-654-321", "Signature of Preparer"]) {
      expect(text).toContain(kept);
    }
    const zip = await JSZip.loadAsync(out);
    const media = Object.keys(zip.files).filter((p) => p.startsWith("word/media/"));
    expect(media.length).toBe(1); // the preparer's signature image stays, the applicant's is gone
    expect(await zip.file("docProps/core.xml")!.async("string")).not.toContain("Juan");
  });
});
