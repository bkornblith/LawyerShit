import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFTextField } from "@cantoo/pdf-lib";
import { fillPdf, prepareTemplate } from "../lib/forms/pdf";

// The public, encrypted USCIS I-360 (as downloaded from uscis.gov).
const i360 = readFileSync(new URL("./fixtures/i-360.pdf", import.meta.url));

describe("prepareTemplate", () => {
  it("opens an encrypted USCIS form and lists its fields with their tooltips", async () => {
    const t = await prepareTemplate(i360);
    expect(t.pageCount).toBe(19);
    expect(t.fields.length).toBeGreaterThan(400);
    expect(t.fields.some((f) => /barcode/i.test(f.name))).toBe(false);
    const family = t.fields.find((f) => f.name.endsWith("Pt1Line1_FamilyName[0]"))!;
    expect(family).toMatchObject({ kind: "text", page: 1 });
    expect(family.label).toMatch(/Family Name/);
    const state = t.fields.find((f) => f.name.endsWith("Pt1Line6_State[0]"))!;
    expect(state.kind).toBe("dropdown");
    expect(state.options).toContain("NY");
    // Fields come in page order with keys f1, f2, ...
    expect(t.fields[0].key).toBe("f1");
    const pages = t.fields.map((f) => f.page);
    expect([...pages].sort((a, b) => a - b)).toEqual(pages);
    // The stored copy is no longer encrypted.
    const reopened = await PDFDocument.load(t.bytes);
    expect(reopened.isEncrypted).toBe(false);
  });
});

describe("fillPdf", () => {
  it("fills text, checkbox and dropdown fields and leaves others blank", async () => {
    const t = await prepareTemplate(i360);
    const by = (suffix: string) => t.fields.find((f) => f.name.endsWith(suffix))!;
    const family = by("Pt1Line1_FamilyName[0]");
    const apt = by("Pt1Line6_Unit[1]");
    const state = by("Pt1Line6_State[0]");
    const given = by("Pt1Line1_GivenName[0]");
    const aNumber = by("Pt1Line4_AlienNumber[0]");
    const { bytes, skipped } = await fillPdf(t.bytes, t.fields, {
      [family.key]: "García López",
      [given.key]: "Juan 你",
      [apt.key]: "checked",
      [state.key]: "ny",
      [aNumber.key]: "0123456789999",
    });
    expect(skipped).toEqual([]);
    const form = (await PDFDocument.load(bytes)).getForm();
    expect((form.getField(family.name) as PDFTextField).getText()).toBe("García López");
    expect((form.getField(given.name) as PDFTextField).getText()).toBe("Juan ?");
    expect((form.getField(apt.name) as PDFCheckBox).isChecked()).toBe(true);
    expect((form.getField(state.name) as PDFDropdown).getSelected()).toEqual(["NY"]);
    expect((form.getField(aNumber.name) as PDFTextField).getText()!.length).toBe(aNumber.maxLength);
    expect((form.getField(by("Pt1Line6_CityOrTown[0]").name) as PDFTextField).getText()).toBeUndefined();
  });
});

import { splitLabel } from "../lib/forms/labels";

describe("splitLabel", () => {
  it("separates the USCIS part heading from the item", () => {
    expect(splitLabel("Part 1. Information About Person or Organization Filing This Petition. 6. Mailing Address. Enter Zip Code.")).toEqual({
      section: "Part 1. Information About Person or Organization Filing This Petition",
      item: "6. Mailing Address. Enter Zip Code.",
    });
    expect(splitLabel("Part 4. Processing Information. Is the person a U.S. citizen? Select Yes.").section).toBe("Part 4. Processing Information");
    expect(splitLabel("Pt1Line1 Family Name")).toEqual({ section: "", item: "Pt1Line1 Family Name" });
  });
});

describe("locked fields", () => {
  it("keeps follow-up fields the form's scripts would unlock, but not ink signature boxes", async () => {
    const t = await prepareTemplate(i360);
    expect(t.fields.some((f) => f.name.endsWith("Pt8Line4b_NameOfParent[0]"))).toBe(true);
    expect(t.fields.some((f) => f.name.endsWith("Pt11Line6_Signature[0]"))).toBe(false);
    const parent = t.fields.find((f) => f.name.endsWith("Pt8Line4b_NameOfParent[0]"))!;
    const { bytes } = await fillPdf(t.bytes, t.fields, { [parent.key]: "Rosa Hernández" });
    const field = (await PDFDocument.load(bytes)).getForm().getTextField(parent.name);
    expect(field.getText()).toBe("Rosa Hernández");
    expect(field.isReadOnly()).toBe(false);
  });
});

import { cleanSuggestions } from "../lib/forms/suggestions";
import type { FormField } from "../lib/forms/types";

describe("cleanSuggestions", () => {
  const fields: FormField[] = [
    { key: "f1", name: "a", kind: "text", label: "A-Number", page: 1, maxLength: 9 },
    { key: "f2", name: "b", kind: "checkbox", label: "Yes", page: 1 },
    { key: "f3", name: "c", kind: "checkbox", label: "No", page: 1 },
    { key: "f4", name: "d", kind: "dropdown", label: "State", page: 1, options: ["NY", "NJ"] },
  ];
  it("drops unknown fields, unticked boxes and invalid choices, and trims to length", () => {
    expect(
      cleanSuggestions(fields, [
        { key: "f1", value: "0123456789", basis: "notes" },
        { key: "f2", value: "checked", basis: "notes" },
        { key: "f3", value: "unchecked", basis: "notes" },
        { key: "f4", value: "ny", basis: "passport" },
        { key: "f9", value: "x", basis: "" },
      ]),
    ).toEqual({
      f1: { value: "012345678", basis: "notes" },
      f2: { value: "checked", basis: "notes" },
      f4: { value: "NY", basis: "passport" },
    });
    expect(cleanSuggestions(fields, [{ key: "f4", value: "CA", basis: "" }])).toEqual({});
  });
});
