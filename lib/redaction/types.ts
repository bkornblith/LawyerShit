// Shared types for the redaction engine. The engine is format-agnostic:
// `rules.ts` turns a client's details into search rules, and each format
// adapter (pdf.ts, docx.ts) finds those rules in its own text and removes them.

/** What the attorney tells us about the client. Only these values are redacted. */
export type ClientContext = {
  /** Full legal name, e.g. "Juan Carlos García López". */
  fullName: string;
  /** Other names the client has used (maiden names, aliases, other spellings). */
  otherNames: string[];
  /** ISO date (YYYY-MM-DD) as produced by <input type="date">. */
  dateOfBirth: string;
  /** Alien Registration Number, any format ("A-123-456-789", "123456789", 8 digits). */
  aNumber: string;
  /** Street line including any apartment/unit, e.g. "123 Main St Apt 4B". */
  street: string;
  city: string;
  state: string;
  zip: string;
  /** Anything else to black out wherever it appears (phone, passport no., email). */
  extraTerms: string[];
};

export const EMPTY_CONTEXT: ClientContext = {
  fullName: "",
  otherNames: [],
  dateOfBirth: "",
  aNumber: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  extraTerms: [],
};

export type Category = "name" | "dob" | "a-number" | "address" | "signature" | "other" | "manual";

export const CATEGORY_LABELS: Record<Category, string> = {
  name: "Client name",
  dob: "Date of birth",
  "a-number": "A-number",
  address: "Address",
  signature: "Signature",
  other: "Other client details",
  manual: "Drawn by hand",
};

/** Decides whether a match starts out selected, given the text around it. */
export type DefaultCheck = (raw: string, start: number, end: number) => { on: boolean; note?: string };

export type Rule = {
  id: string;
  category: Category;
  /** Human description of what the rule looks for, e.g. "Full name". */
  label: string;
  /** Matched against folded text (lowercase, accents removed, same length as the original). */
  regex: RegExp;
  /** Partial rules (a lone surname, a lone city) lose to full rules when they overlap. */
  partial?: boolean;
  defaultOn: boolean | DefaultCheck;
  note?: string;
};

export type TextMatch = {
  ruleId: string;
  category: Category;
  label: string;
  start: number;
  end: number;
  /** The matched text as it appears in the document. */
  text: string;
  defaultOn: boolean;
  note?: string;
};

/** Axis-aligned box in page points (unscaled viewport, rotation applied, origin top-left). */
export type Box = { x: number; y: number; w: number; h: number };

/** One thing the attorney can approve or reject in the review step. */
export type Finding = {
  id: string;
  category: Category;
  label: string;
  text: string;
  context: string;
  selected: boolean;
  note?: string;
  /** PDF only: where to draw. One finding may span several boxes (e.g. across lines). */
  page?: number;
  boxes?: Box[];
};
