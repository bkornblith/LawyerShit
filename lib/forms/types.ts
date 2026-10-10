// Shared types for the form filler. A "form" is a blank fillable PDF in the
// firm's library plus a description of its fields.

export type FieldKind = "text" | "checkbox" | "dropdown" | "radio";

export type FormField = {
  /** Short stable key ("f12") used in prompts and the review screen. */
  key: string;
  /** The PDF's own field name, used to fill the field. */
  name: string;
  kind: FieldKind;
  /** The field's tooltip from the PDF (USCIS forms describe every field), or a cleaned-up name. */
  label: string;
  /** 1-based page number. */
  page: number;
  maxLength?: number;
  multiline?: boolean;
  /** Choices for dropdowns and radio groups. */
  options?: string[];
};

export type FormMeta = {
  id: string;
  name: string;
  description: string;
  /** Standing instructions for filling this form, e.g. "The petitioner is always the client." */
  instructions: string;
  fileName: string;
  pageCount: number;
  fields: FormField[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

/** What the library list shows; the field list is left out to keep it small. */
export type FormSummary = Omit<FormMeta, "fields"> & { fieldCount: number };

/** Field values keyed by FormField.key. Checkboxes use "checked" or "". */
export type FieldValues = Record<string, string>;

export type FillSuggestion = { value: string; basis: string };

export type FillResult = {
  values: Record<string, FillSuggestion>;
  /** Information the form asks for that the context didn't supply. */
  missing: string[];
  /** Anything the attorney should check before filing. */
  notes: string;
};

export const CHECKED = "checked";
