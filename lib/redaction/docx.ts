import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { NOT_CLIENT_SIGNATURE, SIGNATURE_LABEL, contextSnippet, findMatches } from "./rules";
import type { Finding, Rule } from "./types";

// Word (.docx) redaction. Matched text is replaced in the file itself with
// black block characters on black shading, so the original words are gone
// from the document, not just covered. Tracked changes are accepted first so
// deleted text can't hide client details, and signature images near a
// client signature line are removed from the package along with their files.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const V = "urn:schemas-microsoft-com:vml";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const BLOCK = "█";

// Run-property children must appear in this order or Word reports the file as damaged.
const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline",
  "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing",
  "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText",
  "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath",
];

type XDoc = ReturnType<DOMParser["parseFromString"]>;
type XEl = ReturnType<XDoc["createElementNS"]>;
type XNode = XEl["firstChild"];

type Segment = { node: XEl; start: number; end: number; editable: boolean };
type Para = { part: string; el: XEl; text: string; segments: Segment[] };

type TextFinding = Finding & { kind: "text"; para: Para; start: number; end: number };
type ImageFinding = Finding & { kind: "image"; part: string; drawing: XEl };
type DocxFinding = TextFinding | ImageFinding;

export type DocxSession = {
  zip: JSZip;
  docs: Map<string, XDoc>;
  findings: DocxFinding[];
  /** Words in the whole document, for the "nothing found" check. */
  fullText: string;
};

function isPart(path: string): boolean {
  return /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(path);
}

function els(root: XDoc | XEl, ns: string, name: string): XEl[] {
  return Array.from(root.getElementsByTagNameNS(ns, name) as unknown as ArrayLike<XEl>);
}

function nearest(node: XNode | null, ns: string, name: string): XEl | null {
  let cur = node?.parentNode ?? null;
  while (cur) {
    if (cur.nodeType === 1 && (cur as XEl).localName === name && (cur as XEl).namespaceURI === ns) return cur as XEl;
    cur = cur.parentNode;
  }
  return null;
}

function remove(node: XNode | null) {
  node?.parentNode?.removeChild(node);
}

/** Accept tracked changes: drop deletions, keep insertions as normal text. */
function acceptRevisions(doc: XDoc) {
  for (const name of ["del", "moveFrom"]) els(doc, W, name).forEach(remove);
  for (const name of ["ins", "moveTo"]) {
    for (const el of els(doc, W, name)) {
      // Paragraph-mark revisions live inside rPr and have no content; just drop them.
      if (el.parentNode && (el.parentNode as XEl).localName === "rPr") {
        remove(el);
        continue;
      }
      while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el);
      remove(el);
    }
  }
  for (const name of ["rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange", "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd"]) {
    els(doc, W, name).forEach(remove);
  }
}

function collectParagraphs(part: string, doc: XDoc): Para[] {
  return els(doc, W, "p").map((p) => {
    const segments: Segment[] = [];
    let text = "";
    const walk = (node: XNode | null) => {
      for (let c = node?.firstChild ?? null; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        const el = c as XEl;
        if (el.namespaceURI === W && el.localName === "p") continue; // nested paragraph (text box): handled on its own
        if (el.namespaceURI === W && el.localName === "t") {
          const s = el.textContent ?? "";
          segments.push({ node: el, start: text.length, end: text.length + s.length, editable: true });
          text += s;
        } else if (el.namespaceURI === W && (el.localName === "tab" || el.localName === "br" || el.localName === "cr")) {
          if (el.parentNode && (el.parentNode as XEl).localName === "r") {
            segments.push({ node: el, start: text.length, end: text.length + 1, editable: false });
            text += el.localName === "tab" ? "\t" : "\n";
          }
        } else {
          walk(el);
        }
      }
    };
    walk(p);
    return { part, el: p, text, segments };
  });
}

function signatureImageFindings(part: string, paras: Para[], doc: XDoc): ImageFinding[] {
  const out: ImageFinding[] = [];
  const seen = new Set<XEl>();
  paras.forEach((para, i) => {
    if (!SIGNATURE_LABEL.test(para.text) || NOT_CLIENT_SIGNATURE.test(para.text)) return;
    // Signature images sit on the label's line or a few lines above it, never past another signature line.
    for (let j = i; j >= Math.max(0, i - 3); j--) {
      if (j < i && SIGNATURE_LABEL.test(paras[j].text)) break;
      const drawings = [...els(paras[j].el, W, "drawing"), ...els(paras[j].el, W, "pict")];
      for (const d of drawings) {
        if (seen.has(d)) continue;
        seen.add(d);
        out.push({
          kind: "image",
          id: "",
          part,
          drawing: d,
          category: "signature",
          label: "Signature image",
          text: "[image]",
          context: `Image near “${para.text.trim().slice(0, 60)}”`,
          selected: true,
        });
      }
    }
  });
  void doc;
  return out;
}

export async function analyzeDocx(data: ArrayBuffer, rules: Rule[]): Promise<DocxSession> {
  const zip = await JSZip.loadAsync(data);
  if (!zip.file("word/document.xml")) throw new Error("This doesn't look like a Word (.docx) file.");
  const docs = new Map<string, XDoc>();
  const findings: DocxFinding[] = [];
  let fullText = "";

  const parts = Object.keys(zip.files).filter(isPart).sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));
  for (const part of parts) {
    const xml = await zip.file(part)!.async("string");
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    acceptRevisions(doc);
    docs.set(part, doc);
    const paras = collectParagraphs(part, doc);
    for (const para of paras) {
      fullText += para.text + "\n";
      for (const m of findMatches(para.text, rules)) {
        findings.push({
          kind: "text",
          id: "",
          para,
          start: m.start,
          end: m.end,
          category: m.category,
          label: m.label,
          text: m.text,
          context: contextSnippet(para.text, m.start, m.end),
          selected: m.defaultOn,
          note: m.note,
        });
      }
    }
    findings.push(...signatureImageFindings(part, paras, doc));
  }
  findings.forEach((f, i) => (f.id = `d${i}`));
  return { zip, docs, findings, fullText };
}

function setRunProp(doc: XDoc, rPr: XEl, name: string, attrs: Record<string, string>) {
  for (const c of Array.from(rPr.childNodes as unknown as ArrayLike<XNode>)) {
    if (c && c.nodeType === 1 && (c as XEl).localName === name) remove(c);
  }
  const el = doc.createElementNS(W, `w:${name}`);
  for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(W, `w:${k}`, v);
  const rank = RPR_ORDER.indexOf(name);
  let before: XNode | null = null;
  for (let c = rPr.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && RPR_ORDER.indexOf((c as XEl).localName ?? "") > rank) {
      before = c;
      break;
    }
  }
  rPr.insertBefore(el, before);
}

function blackRun(doc: XDoc, template: XEl | null, text: string): XEl {
  const r = doc.createElementNS(W, "w:r");
  const rPr = template ? (template.cloneNode(true) as XEl) : doc.createElementNS(W, "w:rPr");
  // Never leave a redaction as hidden text.
  for (const c of Array.from(rPr.childNodes as unknown as ArrayLike<XNode>)) {
    if (c && c.nodeType === 1 && (c as XEl).localName === "vanish") remove(c);
  }
  setRunProp(doc, rPr, "color", { val: "000000" });
  setRunProp(doc, rPr, "highlight", { val: "black" });
  setRunProp(doc, rPr, "shd", { val: "clear", color: "auto", fill: "000000" });
  r.appendChild(rPr);
  const t = doc.createElementNS(W, "w:t");
  t.setAttribute("xml:space", "preserve");
  t.appendChild(doc.createTextNode(text));
  r.appendChild(t);
  return r;
}

function plainRun(doc: XDoc, template: XEl | null, children: XNode[]): XEl {
  const r = doc.createElementNS(W, "w:r");
  if (template) r.appendChild(template.cloneNode(true));
  for (const c of children) r.appendChild(c!);
  return r;
}

/** Replace parts of one <w:t> with black runs. `ranges` are offsets within the node's text. */
function redactTextNode(doc: XDoc, t: XEl, ranges: [number, number][]) {
  const run = t.parentNode as XEl | null;
  if (!run || run.localName !== "r") {
    // Unusual structure: blank the text in place.
    const s = t.textContent ?? "";
    let out = s;
    for (const [a, b] of ranges) out = out.slice(0, a) + BLOCK.repeat(b - a) + out.slice(b);
    while (t.firstChild) t.removeChild(t.firstChild);
    t.appendChild(doc.createTextNode(out));
    return;
  }
  const rPr = els(run, W, "rPr").find((e) => e.parentNode === run) ?? null;
  const before: XNode[] = [];
  const after: XNode[] = [];
  let seen = false;
  for (let c = run.firstChild; c; c = c.nextSibling) {
    if (c === rPr) continue;
    if (c === t) seen = true;
    else (seen ? after : before).push(c);
  }
  const s = t.textContent ?? "";
  const pieces: XEl[] = [];
  let pos = 0;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  for (const [a, b] of sorted) {
    if (a > pos) pieces.push(plainTextRun(doc, rPr, s.slice(pos, a)));
    pieces.push(blackRun(doc, rPr, BLOCK.repeat(Math.max(1, b - a))));
    pos = Math.max(pos, b);
  }
  if (pos < s.length) pieces.push(plainTextRun(doc, rPr, s.slice(pos)));

  const parent = run.parentNode!;
  const newRuns = [...(before.length ? [plainRun(doc, rPr, before)] : []), ...pieces, ...(after.length ? [plainRun(doc, rPr, after)] : [])];
  for (const nr of newRuns) parent.insertBefore(nr, run);
  parent.removeChild(run);
}

function plainTextRun(doc: XDoc, rPr: XEl | null, text: string): XEl {
  const t = doc.createElementNS(W, "w:t");
  t.setAttribute("xml:space", "preserve");
  t.appendChild(doc.createTextNode(text));
  return plainRun(doc, rPr, [t]);
}

function relsPath(part: string): string {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

async function removeImage(session: DocxSession, f: ImageFinding, relDocs: Map<string, XDoc>) {
  const doc = session.docs.get(f.part)!;
  const ids = new Set<string>();
  for (const blip of els(f.drawing, A, "blip")) {
    const id = blip.getAttributeNS(R, "embed") || blip.getAttributeNS(R, "link");
    if (id) ids.add(id);
  }
  for (const img of els(f.drawing, V, "imagedata")) {
    const id = img.getAttributeNS(R, "id");
    if (id) ids.add(id);
  }
  // Swap the drawing for a black "[SIGNATURE REDACTED]" run.
  const run = nearest(f.drawing, W, "r");
  const rPr = run ? els(run, W, "rPr").find((e) => e.parentNode === run) ?? null : null;
  const replacement = blackRun(doc, rPr, "[SIGNATURE REDACTED]");
  if (run?.parentNode) {
    run.parentNode.insertBefore(replacement, run);
    run.parentNode.removeChild(run);
  } else {
    remove(f.drawing);
  }

  // Drop the image file itself unless something else still points at it.
  const rp = relsPath(f.part);
  if (!relDocs.has(rp)) {
    const xml = await session.zip.file(rp)?.async("string");
    if (!xml) return;
    relDocs.set(rp, new DOMParser().parseFromString(xml, "text/xml"));
  }
  const rels = relDocs.get(rp)!;
  const stillUsed = new XMLSerializer().serializeToString(doc);
  for (const rel of els(rels, REL, "Relationship")) {
    const id = rel.getAttribute("Id") ?? "";
    if (!ids.has(id) || stillUsed.includes(`"${id}"`)) continue;
    const target = rel.getAttribute("Target") ?? "";
    remove(rel);
    if (rel.getAttribute("TargetMode") === "External") continue;
    const base = f.part.slice(0, f.part.lastIndexOf("/") + 1);
    const path = target.startsWith("/") ? target.slice(1) : normalize(base + target);
    session.zip.remove(path);
  }
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== ".") out.push(seg);
  }
  return out.join("/");
}

function scrubMetadata(xml: string): string {
  // Clear author, editor, title and similar fields that may carry a client's name.
  return xml.replace(
    /<((?:dc|cp|ep|vt)?:?(?:creator|lastModifiedBy|title|subject|description|keywords|category|Company|Manager))(\s[^>]*)?>[\s\S]*?<\/\1>/g,
    (_m, tag, attrs = "") => `<${tag}${attrs}></${tag}>`,
  );
}

/** Build the redacted .docx from the findings the attorney kept selected. */
export async function applyDocx(session: DocxSession, selectedIds: Set<string>): Promise<Blob> {
  const chosen = session.findings.filter((f) => selectedIds.has(f.id));

  // Text: gather ranges per <w:t> node, then rewrite each node once.
  const perNode = new Map<XEl, { part: string; ranges: [number, number][] }>();
  for (const f of chosen) {
    if (f.kind !== "text") continue;
    for (const seg of f.para.segments) {
      if (!seg.editable || seg.end <= f.start || seg.start >= f.end) continue;
      const a = Math.max(f.start, seg.start) - seg.start;
      const b = Math.min(f.end, seg.end) - seg.start;
      const entry = perNode.get(seg.node) ?? { part: f.para.part, ranges: [] };
      entry.ranges.push([a, b]);
      perNode.set(seg.node, entry);
    }
  }
  for (const [node, { part, ranges }] of perNode) redactTextNode(session.docs.get(part)!, node, ranges);

  const relDocs = new Map<string, XDoc>();
  for (const f of chosen) if (f.kind === "image") await removeImage(session, f, relDocs);

  // Image descriptions (alt text) can carry names too.
  for (const doc of session.docs.values()) {
    for (const el of [...els(doc, "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "docPr")]) {
      el.removeAttribute("descr");
      el.removeAttribute("title");
    }
  }

  const ser = new XMLSerializer();
  for (const [part, doc] of session.docs) session.zip.file(part, ser.serializeToString(doc));
  for (const [path, doc] of relDocs) session.zip.file(path, ser.serializeToString(doc));
  for (const meta of ["docProps/core.xml", "docProps/app.xml"]) {
    const xml = await session.zip.file(meta)?.async("string");
    if (xml) session.zip.file(meta, scrubMetadata(xml));
  }
  session.zip.remove("docProps/custom.xml");

  return session.zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}

/** Plain text of a .docx, for checking the output. */
export async function docxText(data: ArrayBuffer | Blob): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  let text = "";
  for (const part of Object.keys(zip.files).filter(isPart)) {
    const doc = new DOMParser().parseFromString(await zip.file(part)!.async("string"), "text/xml");
    for (const p of collectParagraphs(part, doc)) text += p.text + "\n";
  }
  return text;
}
