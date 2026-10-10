import type { ClientContext, DefaultCheck, Rule, TextMatch } from "./types";

// ---------------------------------------------------------------------------
// Text folding. Rules run against a lowercase, accent-free copy of the text
// that has exactly the same length as the original, so match offsets map
// straight back onto the document.
// ---------------------------------------------------------------------------

export function fold(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    if (code < 128) {
      out += ch.toLowerCase();
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      out += ch; // surrogate half: leave alone, keeps length
      continue;
    }
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += f.length >= 1 ? f[0] : ch;
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const B = "(?<![\\p{L}\\p{N}])"; // word start
const E = "(?![\\p{L}\\p{N}])"; // word end
const ND = "(?<!\\d)"; // not preceded by a digit
const NDE = "(?!\\d)"; // not followed by a digit

function re(body: string): RegExp {
  return new RegExp(body, "gu");
}

/** Lowercased, accent-free tokens of a name or phrase. */
function tokens(s: string): string[] {
  return fold(s)
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[.'"]+|[.'"]+$/g, ""))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const NAME_SEP = "[\\s.,\\-]+";
const PARTICLES = new Set(["de", "del", "la", "las", "los", "da", "das", "do", "dos", "van", "von", "der", "di", "du", "le", "el", "y", "e", "bin", "ibn", "al"]);

/** A name token: hyphens inside it may also appear as spaces. */
function nameTok(t: string): string {
  return t.split("-").map(esc).join("[\\s\\-]*");
}

/** Full token or its initial ("Carlos" or "C."). */
function tokOrInitial(t: string): string {
  return `(?:${nameTok(t)}|${esc(t[0])}\\.?)`;
}

/**
 * Patterns for one person's name in the orders it shows up in on immigration
 * paperwork: "Juan Carlos Garcia", "Juan C. Garcia", "Juan Garcia",
 * "GARCIA, Juan Carlos", "Garcia Juan".
 */
function namePatterns(name: string): string[] {
  const t = tokens(name);
  if (t.length === 0) return [];
  if (t.length === 1) return [nameTok(t[0])];
  const first = t[0];
  const last = t[t.length - 1];
  const middles = t.slice(1, -1);
  const pats: string[] = [];

  // Natural order, middle names optional or as initials.
  const mid = middles.map((m) => `(?:${NAME_SEP}${tokOrInitial(m)})?`).join("");
  pats.push(`${nameTok(first)}${mid}${NAME_SEP}${nameTok(last)}`);

  // Two-surname names ("Juan Garcia Lopez") are often written with only the first surname.
  if (t.length >= 3) {
    const mid2 = t.slice(1, -2).map((m) => `(?:${NAME_SEP}${tokOrInitial(m)})?`).join("");
    pats.push(`${nameTok(first)}${mid2}${NAME_SEP}${nameTok(t[t.length - 2])}`);
  }

  // Surname first, with or without a comma, given/middle names after.
  const surnames = t.length >= 3 ? `(?:${nameTok(t[t.length - 2])}${NAME_SEP})?${nameTok(last)}` : nameTok(last);
  const after = middles
    .filter((m) => t.length < 3 || m !== t[t.length - 2])
    .map((m) => `(?:${NAME_SEP}${tokOrInitial(m)})?`)
    .join("");
  pats.push(`${surnames}${NAME_SEP}${nameTok(first)}${after}`);
  return pats;
}

// Words that commonly sit next to a name without being another person's name.
const NOT_A_NAME = new Set(
  (
    "a an and or of the to in on at by for from with as is was are be been mr mrs ms miss dr sr jr " +
    "name names client applicant respondent petitioner beneficiary declarant defendant plaintiff " +
    "family given first last middle full legal surname print printed type typed sign signed signature " +
    "date dob birth born address street city state zip country number no re regarding matter case " +
    "file alien uscis immigration court judge honorable dear sincerely attorney counsel esq esquire " +
    "affidavit declaration statement letter exhibit page section part item yes not dated i we he she " +
    "his her their my our you your this that these those who whom said also hereby certify"
  ).split(" "),
);

function wordBefore(raw: string, start: number): string | null {
  const m = /([\p{L}][\p{L}'\-]*)[ \t]+$/u.exec(raw.slice(Math.max(0, start - 40), start));
  return m ? m[1] : null;
}
function wordAfter(raw: string, end: number): string | null {
  const m = /^[ \t]+([\p{L}][\p{L}'\-]*)/u.exec(raw.slice(end, end + 40));
  return m ? m[1] : null;
}

/**
 * A lone first or last name is the client's unless it sits right next to a
 * word that looks like someone else's name ("Maria Garcia" when the client is
 * Juan Garcia). Those start unselected so the attorney decides.
 */
function lonePartCheck(clientTokens: Set<string>): DefaultCheck {
  return (raw, start, end) => {
    for (const w of [wordBefore(raw, start), wordAfter(raw, end)]) {
      if (!w) continue;
      const f = fold(w).replace(/[.'\-]/g, "");
      if (f.length < 2 || clientTokens.has(f) || NOT_A_NAME.has(f) || PARTICLES.has(f)) continue;
      if (/^\p{Lu}/u.test(w)) {
        return { on: false, note: `Next to "${w}", may be someone else` };
      }
    }
    return { on: true };
  };
}

// ---------------------------------------------------------------------------
// Dates of birth
// ---------------------------------------------------------------------------

const MONTHS: string[][] = [
  ["january", "jan", "enero", "ene", "janvier"],
  ["february", "feb", "febrero", "fevrier"],
  ["march", "mar", "marzo", "mars"],
  ["april", "apr", "abril", "abr", "avril"],
  ["may", "mayo", "mai"],
  ["june", "jun", "junio", "juin"],
  ["july", "jul", "julio", "juillet"],
  ["august", "aug", "agosto", "ago", "aout"],
  ["september", "sept", "sep", "septiembre", "setiembre", "set", "septembre"],
  ["october", "oct", "octubre", "octobre"],
  ["november", "nov", "noviembre", "novembre"],
  ["december", "dec", "diciembre", "dic", "decembre"],
];

function datePatterns(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return [];
  const [, yyyy, mm, dd] = m;
  const yy = yyyy.slice(2);
  const mo = Number(mm);
  const d = Number(dd);
  const M = `0?${mo}`;
  const D = `0?${d}`;
  const S = "\\s*[\\/\\-.]\\s*";
  const Y = `(?:${yyyy}|${yy})`;
  const month = `(?:${MONTHS[mo - 1].join("|")})\\.?`;
  const ord = "(?:st|nd|rd|th|o|º|°)?";
  return [
    `${ND}${M}${S}${D}${S}${Y}${NDE}`, // 03/14/1990, 3-14-90
    `${ND}${D}${S}${M}${S}${Y}${NDE}`, // 14/03/1990 (foreign documents)
    `${ND}${yyyy}${S}${M}${S}${D}${NDE}`, // 1990-03-14
    `${ND}${mm}${dd}${yyyy}${NDE}`, // 03141990 (form boxes)
    `${B}${month}\\s*${D}${ord},?\\s*${yyyy}${NDE}`, // March 14, 1990
    `${ND}${D}${ord}\\s*(?:of\\s+|de\\s+)?${month}\\s*,?\\s*(?:of\\s+|de\\s+|del\\s+)?${yyyy}${NDE}`, // 14 March 1990, 14 de marzo de 1990
  ];
}

// ---------------------------------------------------------------------------
// A-numbers
// ---------------------------------------------------------------------------

export function normalizeANumber(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 9) return digits;
  if (digits.length === 8) return "0" + digits;
  return null;
}

function aNumberPatterns(input: string): string[] {
  const n = normalizeANumber(input);
  if (!n) return [];
  const spaced = (ds: string) => ds.split("").join("[\\s\\-.]{0,3}");
  const prefix = `(?:${B}a[\\s\\-#:.]{0,3})?`;
  const pats = [`${prefix}${ND}${spaced(n)}${NDE}`];
  if (n.startsWith("0")) pats.push(`${prefix}${ND}${spaced(n.slice(1))}${NDE}`);
  return pats;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const ADDRESS_WORDS: string[][] = [
  ["street", "st", "str"],
  ["avenue", "ave", "av", "avn"],
  ["road", "rd"],
  ["boulevard", "blvd", "boul"],
  ["drive", "dr"],
  ["lane", "ln"],
  ["place", "pl"],
  ["court", "ct"],
  ["terrace", "ter", "terr"],
  ["parkway", "pkwy", "pky"],
  ["highway", "hwy"],
  ["square", "sq"],
  ["circle", "cir"],
  ["plaza", "plz"],
  ["turnpike", "tpke"],
  ["expressway", "expy"],
  ["north", "n"],
  ["south", "s"],
  ["east", "e"],
  ["west", "w"],
  ["northeast", "ne"],
  ["northwest", "nw"],
  ["southeast", "se"],
  ["southwest", "sw"],
  ["first", "1st"],
  ["second", "2nd"],
  ["third", "3rd"],
  ["fourth", "4th"],
  ["fifth", "5th"],
  ["sixth", "6th"],
  ["seventh", "7th"],
  ["eighth", "8th"],
  ["ninth", "9th"],
  ["tenth", "10th"],
  ["saint", "st"],
  ["mount", "mt"],
  ["fort", "ft"],
];
const UNIT_WORDS = ["apartment", "apt", "unit", "suite", "ste", "#", "no", "number", "num", "room", "rm", "floor", "fl", "flr"];

function addressTok(t: string): string {
  if (UNIT_WORDS.includes(t)) return `(?:${UNIT_WORDS.map(esc).join("|")})\\.?`;
  const alts = new Set([t]);
  for (const group of ADDRESS_WORDS) if (group.includes(t)) group.forEach((g) => alts.add(g));
  return `(?:${[...alts].sort((a, b) => b.length - a.length).map(esc).join("|")})\\.?`;
}

function addressTokens(s: string): string[] {
  return (fold(s).match(/#|[^\s,.#]+/g) ?? []).filter(Boolean);
}

/** Street patterns: the whole line, and the part before any apartment/unit designator. */
function streetPatterns(street: string): string[] {
  const t = addressTokens(street);
  if (t.length === 0) return [];
  const build = (ts: string[]) =>
    ts
      .map((tok, i) => {
        const p = addressTok(tok);
        if (i === 0) return p;
        // Unit designators are optional ("Apt 4B" vs "4B") and may run into the number ("#4B").
        if (UNIT_WORDS.includes(tok)) return `(?:[\\s,.]*${p})?`;
        const prevUnit = UNIT_WORDS.includes(ts[i - 1]);
        return `${prevUnit ? "[\\s,.\\-]*" : "[\\s,.]+"}${p}`;
      })
      .join("");
  const pats = [`${B}${build(t)}${E}`];
  const unitAt = t.findIndex((tok, i) => i > 0 && UNIT_WORDS.includes(tok));
  if (unitAt > 1) pats.push(`${B}${build(t.slice(0, unitAt))}${E}`);
  return pats;
}

const STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado",
  ct: "connecticut", de: "delaware", dc: "district of columbia", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky",
  la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota",
  ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
  nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota",
  oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia",
  wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming", pr: "puerto rico",
};

function statePattern(state: string): string | null {
  const s = fold(state).trim().replace(/\./g, "");
  if (!s) return null;
  let abbr = s.length === 2 ? s : Object.keys(STATES).find((k) => STATES[k] === s);
  const full = abbr ? STATES[abbr] : s;
  const alts = [full.split(" ").map(esc).join("\\s+")];
  if (abbr) alts.push(`${esc(abbr[0])}\\.?${esc(abbr[1])}\\.?`);
  return `(?:${alts.join("|")})`;
}

// ---------------------------------------------------------------------------
// Signatures: typed electronic signatures ("/s/ Juan Garcia") are caught here;
// signature images and handwriting are handled by the PDF/Word adapters.
// ---------------------------------------------------------------------------

/** Labels that mark a signature line. */
export const SIGNATURE_LABEL = /signature|sign\s+here|firma|signed\s+by|\(sign\)/i;
/** Signature lines that belong to someone other than the client. */
export const NOT_CLIENT_SIGNATURE =
  /preparer|attorney|representative|interpreter|translator|notary|witness|officer|g-28|accredited|counsel|esq|employer|sponsor|petitioner's attorney|judge|official/i;

// ---------------------------------------------------------------------------
// Rule building
// ---------------------------------------------------------------------------

export function buildRules(ctx: ClientContext): Rule[] {
  const rules: Rule[] = [];
  let n = 0;
  const add = (r: Omit<Rule, "id">) => rules.push({ ...r, id: `r${n++}` });

  const names = [ctx.fullName, ...ctx.otherNames].map((s) => s.trim()).filter(Boolean);
  const clientTokens = new Set(names.flatMap(tokens).map((t) => t.replace(/[.'\-]/g, "")));

  for (const name of names) {
    const pats = namePatterns(name);
    if (pats.length === 0) continue;
    const alt = pats.map((p) => `(?:${p})`).join("|");
    add({ category: "signature", label: "Typed signature", regex: re(`\\/s\\/\\s*(?:${alt})${E}`), defaultOn: true });
    add({ category: "name", label: name === ctx.fullName.trim() ? "Full name" : "Other name", regex: re(`${B}(?:${alt})${E}`), defaultOn: true });
  }

  // Lone first or last names (e.g. "Family Name: GARCIA" on a form).
  const lone = new Set<string>();
  for (const name of names) {
    const t = tokens(name);
    if (t.length < 2) continue;
    for (const part of t) if (part.replace(/[.\-']/g, "").length >= 3 && !PARTICLES.has(part)) lone.add(part);
  }
  for (const part of lone) {
    add({
      category: "name",
      label: "Part of name",
      regex: re(`${B}${nameTok(part)}${E}`),
      partial: true,
      defaultOn: lonePartCheck(clientTokens),
    });
  }

  const dob = datePatterns(ctx.dateOfBirth);
  if (dob.length) add({ category: "dob", label: "Date of birth", regex: re(dob.map((p) => `(?:${p})`).join("|")), defaultOn: true });

  const an = aNumberPatterns(ctx.aNumber);
  if (an.length) add({ category: "a-number", label: "A-number", regex: re(an.map((p) => `(?:${p})`).join("|")), defaultOn: true });

  for (const p of streetPatterns(ctx.street)) {
    add({ category: "address", label: "Street address", regex: re(p), defaultOn: true });
  }
  const state = statePattern(ctx.state);
  const zip = ctx.zip.replace(/[^\d\-]/g, "");
  const zip5 = zip.slice(0, 5);
  const cityToks = tokens(ctx.city);
  const cityPat = cityToks.length ? cityToks.map(addressTok).join("[\\s.]+") : null;
  const zipPat = /^\d{5}$/.test(zip5) ? `${ND}${zip5}(?:\\s*-\\s*\\d{4})?${NDE}` : null;
  if (cityPat && state) {
    const tail = zipPat ? `(?:[\\s,]+${zipPat})?` : "";
    add({ category: "address", label: "City and state", regex: re(`${B}${cityPat}[\\s,]+${state}${E}${tail}`), defaultOn: true });
  }
  if (state && zipPat) {
    add({ category: "address", label: "State and ZIP", regex: re(`${B}${state}[\\s,]+${zipPat}`), defaultOn: true });
  }
  if (zipPat) add({ category: "address", label: "ZIP code", regex: re(zipPat), partial: true, defaultOn: true });
  if (cityPat) {
    add({
      category: "address",
      label: "City alone",
      regex: re(`${B}${cityPat}${E}`),
      partial: true,
      defaultOn: false,
      note: "A city on its own may not be the client's address",
    });
  }

  for (const term of ctx.extraTerms.map((s) => s.trim()).filter((s) => s.length >= 2)) {
    const digits = term.replace(/\D/g, "");
    // Phone numbers, passport numbers and the like: match the digits with any punctuation between.
    const body =
      /^[\d\s\-().+\/#]+$/.test(term) && digits.length >= 4
        ? `${ND}${digits.split("").join("[\\s\\-().\\/]*")}${NDE}`
        : `${B}${tokens(term).map(esc).join("[\\s,]+")}${E}`;
    add({ category: "other", label: `“${term}”`, regex: re(body), defaultOn: true });
  }
  return rules;
}

/**
 * Run every rule over `raw` and return non-overlapping matches. Full matches win
 * over partial ones, then longer over shorter.
 */
export function findMatches(raw: string, rules: Rule[]): TextMatch[] {
  const folded = fold(raw);
  const all: (TextMatch & { partial: boolean })[] = [];
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(folded))) {
      if (m[0].length === 0) {
        rule.regex.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      const d = typeof rule.defaultOn === "function" ? rule.defaultOn(raw, start, end) : { on: rule.defaultOn };
      all.push({
        ruleId: rule.id,
        category: rule.category,
        label: rule.label,
        start,
        end,
        text: raw.slice(start, end),
        defaultOn: d.on,
        note: d.note ?? rule.note,
        partial: !!rule.partial,
      });
    }
  }
  all.sort((a, b) => Number(a.partial) - Number(b.partial) || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: TextMatch[] = [];
  for (const m of all) {
    if (kept.some((k) => m.start < k.end && k.start < m.end)) continue;
    const { partial: _p, ...rest } = m;
    kept.push(rest);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

/** A short snippet of surrounding text for the review list, with the match between MARK_OPEN and MARK_CLOSE. */
export function contextSnippet(raw: string, start: number, end: number, pad = 40): string {
  const before = raw.slice(Math.max(0, start - pad), start).replace(/\s+/g, " ");
  const after = raw.slice(end, end + pad).replace(/\s+/g, " ");
  return `${start > pad ? "…" : ""}${before}${MARK_OPEN}${raw.slice(start, end).replace(/\s+/g, " ")}${MARK_CLOSE}${after}${end + pad < raw.length ? "…" : ""}`;
}

/** Which of the client's details the attorney filled in, for "nothing found" warnings. */
export function providedCategories(ctx: ClientContext): string[] {
  const out: string[] = [];
  if (ctx.fullName.trim()) out.push("name");
  if (datePatterns(ctx.dateOfBirth).length) out.push("dob");
  if (normalizeANumber(ctx.aNumber)) out.push("a-number");
  if (ctx.street.trim() || ctx.zip.trim()) out.push("address");
  return out;
}
