import { isChecked } from "./pdf";
import { CHECKED, type FillResult, type FormField } from "./types";

/** Keeps only valid suggestions: known fields, allowed choices, ticked boxes. */
export function cleanSuggestions(fields: FormField[], raw: { key: string; value: string; basis: string }[]) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out: FillResult["values"] = {};
  for (const s of raw) {
    const f = byKey.get(s.key);
    const value = (s.value ?? "").trim();
    if (!f || !value) continue;
    const basis = (s.basis ?? "").trim();
    if (f.kind === "checkbox") {
      if (isChecked(value)) out[f.key] = { value: CHECKED, basis };
    } else if (f.kind === "dropdown" || f.kind === "radio") {
      const opt = f.options?.find((o) => o.trim().toLowerCase() === value.toLowerCase());
      if (opt) out[f.key] = { value: opt, basis };
    } else {
      out[f.key] = { value: f.maxLength ? value.slice(0, f.maxLength) : value, basis };
    }
  }
  return out;
}
