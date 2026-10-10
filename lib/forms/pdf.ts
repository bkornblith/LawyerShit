import {
  PDFCheckBox,
  PDFDict,
  PDFStream,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFHexString,
  PDFTextField,
  StandardFonts,
  type PDFField,
  type PDFFont,
} from "@cantoo/pdf-lib";
import { CHECKED, type FieldValues, type FormField } from "./types";

// PDF work for the form filler. Runs on the server (reading new forms into the
// library) and in the browser (filling a form for download). Uses the
// @cantoo/pdf-lib fork because government forms are usually encrypted with an
// empty password, which plain pdf-lib can't open.

export class FormPdfError extends Error {}

export async function openPdf(bytes: Uint8Array | ArrayBuffer): Promise<PDFDocument> {
  try {
    // XFA (the Adobe LiveCycle layer on USCIS forms) is dropped on load; the
    // ordinary form fields underneath are what we read and fill.
    return await PDFDocument.load(bytes, { password: "", ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new FormPdfError(
      e instanceof Error && /password|encrypt/i.test(e.message)
        ? "This PDF is password-protected. Save an unlocked copy and upload that."
        : "This file couldn't be read as a PDF.",
    );
  }
}

/**
 * Reads a blank form: returns a clean, unencrypted copy to keep in the library
 * and the list of fillable fields.
 */
export async function prepareTemplate(bytes: Uint8Array | ArrayBuffer) {
  const doc = await openPdf(bytes);
  dropEncryptionLeftovers(doc);
  const fields = describeFields(doc);
  if (fields.length === 0) {
    throw new FormPdfError(
      "This PDF has no fillable fields. Upload the fillable version of the form (for USCIS forms, the one downloaded from uscis.gov).",
    );
  }
  const clean = await doc.save({ useObjectStreams: false });
  return { bytes: clean, fields, pageCount: doc.getPageCount() };
}

/**
 * The decrypted document can still carry the original cross-reference streams,
 * whose dictionaries point at the old /Encrypt entry. Saved as-is, the copy
 * would read as encrypted again, so remove them along with the entry itself.
 */
function dropEncryptionLeftovers(doc: PDFDocument) {
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : undefined;
    if (!dict) continue;
    if (dict.get(PDFName.of("Type")) === PDFName.of("XRef")) {
      ctx.delete(ref);
      continue;
    }
    if (dict.has(PDFName.of("Filter")) && dict.has(PDFName.of("O")) && dict.has(PDFName.of("U"))) {
      ctx.delete(ref); // the Standard security handler dictionary
    }
  }
}

function text(v: unknown): string {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return "";
}

/** "form1[0].#subform[3].Pt2Line4_DateOfBirth[0]" -> "Pt2Line4 Date Of Birth" */
function labelFromName(name: string): string {
  const last = name.split(".").pop() ?? name;
  return last
    .replace(/\[\d+\]/g, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function isSkipped(field: PDFField, label: string): boolean {
  // 2D barcodes are drawn by the form's own scripts; never fill them.
  if (/barcode/i.test(field.getName())) return true;
  // Locked signature boxes must be signed in ink. Other locked fields are kept:
  // on USCIS forms they are follow-up questions the form's scripts unlock once
  // an earlier answer is given, and those scripts don't run outside Acrobat.
  return field.isReadOnly() && /signature/i.test(`${field.getName()} ${label}`);
}

export function describeFields(doc: PDFDocument): FormField[] {
  const pageOf = new Map<string, number>();
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let j = 0; j < annots.size(); j++) {
      const ref = annots.get(j);
      if (ref instanceof PDFRef) pageOf.set(ref.toString(), i + 1);
    }
  });

  const out: FormField[] = [];
  for (const field of doc.getForm().getFields()) {
    const tooltip = text(field.acroField.dict.get(PDFName.of("TU"))).replace(/\s+/g, " ").trim();
    if (isSkipped(field, tooltip)) continue;
    let kind: FormField["kind"];
    if (field instanceof PDFTextField) kind = "text";
    else if (field instanceof PDFCheckBox) kind = "checkbox";
    else if (field instanceof PDFDropdown || field instanceof PDFOptionList) kind = "dropdown";
    else if (field instanceof PDFRadioGroup) kind = "radio";
    else continue; // buttons and signatures

    let page = 0;
    for (const w of field.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(w.dict);
      const p = ref ? pageOf.get(ref.toString()) : undefined;
      if (p) {
        page = p;
        break;
      }
    }

    const f: FormField = {
      key: `f${out.length + 1}`,
      name: field.getName(),
      kind,
      label: tooltip || labelFromName(field.getName()),
      page,
    };
    if (field instanceof PDFTextField) {
      const max = field.getMaxLength();
      if (max) f.maxLength = max;
      if (field.isMultiline()) f.multiline = true;
    }
    if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
      f.options = field.getOptions().filter((o) => o.trim() !== "");
    }
    out.push(f);
  }
  // Reading order: by page, keeping the PDF's own order within a page.
  return out
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.page || 999) - (b.f.page || 999) || a.i - b.i)
    .map(({ f }, i) => ({ ...f, key: `f${i + 1}` }));
}

/** Replaces characters the standard PDF font can't draw (accents are kept where it can). */
function drawable(value: string, font: PDFFont): string {
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of value.replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0)!;
    if (ch === "\n" || supported.has(code)) {
      out += ch;
      continue;
    }
    const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    out += [...plain].every((c) => supported.has(c.codePointAt(0)!)) ? plain : "?";
  }
  return out;
}

function matchOption(value: string, options: string[]): string | undefined {
  const v = value.trim().toLowerCase();
  return options.find((o) => o === value) ?? options.find((o) => o.trim().toLowerCase() === v);
}

export function isChecked(value: string | undefined): boolean {
  return !!value && /^(checked|true|yes|x|on)$/i.test(value.trim());
}

/**
 * Fills a blank form with the given values and returns the new PDF. Fields left
 * blank stay blank. The result stays editable unless `flatten` is set.
 */
export async function fillPdf(
  template: Uint8Array | ArrayBuffer,
  fields: FormField[],
  values: FieldValues,
  opts: { flatten?: boolean } = {},
): Promise<{ bytes: Uint8Array; skipped: string[] }> {
  const doc = await openPdf(template);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const skipped: string[] = [];

  for (const f of fields) {
    const raw = values[f.key];
    if (raw === undefined) continue;
    let field: PDFField;
    try {
      field = form.getField(f.name);
    } catch {
      skipped.push(f.label);
      continue;
    }
    try {
      // Unlock follow-up fields we fill so they can still be corrected in a PDF editor.
      if (raw.trim() && field.isReadOnly()) field.disableReadOnly();
      if (field instanceof PDFTextField) {
        let v = drawable(raw, font);
        if (!field.isMultiline()) v = v.replace(/\n+/g, " ");
        const max = field.getMaxLength();
        if (max && v.length > max) v = v.slice(0, max);
        field.setText(v || undefined);
      } else if (field instanceof PDFCheckBox) {
        if (isChecked(raw)) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const opt = raw.trim() ? matchOption(raw, field.getOptions()) : undefined;
        if (opt) field.select(opt);
        else {
          field.clear();
          if (raw.trim()) skipped.push(f.label);
        }
      } else if (field instanceof PDFRadioGroup) {
        const opt = raw.trim() ? matchOption(raw, field.getOptions()) : undefined;
        if (opt) field.select(opt);
        else {
          field.clear();
          if (raw.trim()) skipped.push(f.label);
        }
      }
    } catch {
      skipped.push(f.label);
    }
  }

  form.updateFieldAppearances(font);
  // Ask PDF viewers to redraw fields too, in case a field uses a font we didn't embed.
  form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
  if (opts.flatten) form.flatten();
  return { bytes: await doc.save({ useObjectStreams: false }), skipped };
}

export { CHECKED };
