"use client";

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import { NOT_CLIENT_SIGNATURE, SIGNATURE_LABEL, contextSnippet, findMatches } from "./rules";
import type { Box, Finding, Rule } from "./types";

// PDF redaction, entirely in the browser. Text is located with pdf.js (or OCR
// for scanned pages), the attorney reviews the boxes, and the output is
// rebuilt from page images with the boxes burned in. Nothing from the
// original file survives in the output except those images: no text layer,
// form data, comments, attachments or metadata.

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    return pdfjs;
  });
  return pdfjsPromise;
}

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
}

// ---------------------------------------------------------------------------
// Page text with a way back from character offsets to boxes on the page.
// ---------------------------------------------------------------------------

type Span = { start: number; end: number; boxFor: (a: number, b: number) => Box; /** OCR guess too unsure to count as real text. */ weak?: boolean };
type PageText = { text: string; spans: Span[] };

const PAD = 2;

function bboxOf(points: [number, number][]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: x - PAD, y: y - PAD, w: Math.max(...xs) - x + 2 * PAD, h: Math.max(...ys) - y + 2 * PAD };
}

// Where character k falls along a text run, as a fraction of the run's width.
// Measuring with a similar font is far closer than assuming equal-width characters.
let measureCtx: CanvasRenderingContext2D | null = null;
function prefixRatio(str: string, k: number, family: string): number {
  if (k <= 0) return 0;
  if (k >= str.length) return 1;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return k / str.length;
  measureCtx.font = `100px ${family}`;
  const total = measureCtx.measureText(str).width;
  return total > 0 ? measureCtx.measureText(str.slice(0, k)).width / total : k / str.length;
}

type TextItem = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean };

async function textLayer(page: PDFPageProxy, vp: PageViewport): Promise<PageText> {
  const content = await page.getTextContent();
  const items = content.items.filter((it) => "str" in it) as unknown as (TextItem & { fontName: string })[];
  const styles = content.styles as Record<string, { fontFamily?: string }>;
  let text = "";
  const spans: Span[] = [];
  let prev: { x: number; y: number; size: number; dir: [number, number]; eol: boolean } | null = null;

  for (const it of items) {
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || it.height || 10;
    const dirLen = Math.hypot(a, b) || 1;
    const dir: [number, number] = [a / dirLen, b / dirLen];
    const up: [number, number] = [c / (Math.hypot(c, d) || 1), d / (Math.hypot(c, d) || 1)];

    if (prev) {
      if (prev.eol) {
        if (!text.endsWith("\n")) text += "\n";
      } else {
        // Distance from where the last item ended to where this one starts.
        const dx = e - prev.x;
        const dy = f - prev.y;
        const along = dx * prev.dir[0] + dy * prev.dir[1];
        const across = -dx * prev.dir[1] + dy * prev.dir[0];
        if (Math.abs(across) > prev.size * 0.6) text += "\n";
        else if (along > prev.size * 0.15 || along < -prev.size) text += " ";
      }
    }

    if (it.str.length > 0) {
      const len = it.str.length;
      const w = it.width;
      const origin: [number, number] = [e, f];
      const boxFor = (s: number, t: number): Box => {
        const family = styles[it.fontName]?.fontFamily ?? "sans-serif";
        const p = (k: number): [number, number] => {
          const r = prefixRatio(it.str, k, family);
          return [origin[0] + dir[0] * w * r, origin[1] + dir[1] * w * r];
        };
        const p0 = p(s);
        const p1 = p(t);
        const lo = 0.28 * size;
        const hi = 0.98 * size;
        const corners: [number, number][] = [
          [p0[0] - up[0] * lo, p0[1] - up[1] * lo],
          [p1[0] - up[0] * lo, p1[1] - up[1] * lo],
          [p1[0] + up[0] * hi, p1[1] + up[1] * hi],
          [p0[0] + up[0] * hi, p0[1] + up[1] * hi],
        ];
        return bboxOf(corners.map(([x, y]) => vp.convertToViewportPoint(x, y) as [number, number]));
      };
      spans.push({ start: text.length, end: text.length + len, boxFor });
      text += it.str;
    }
    prev = { x: e + dir[0] * it.width, y: f + dir[1] * it.width, size, dir, eol: it.hasEOL };
  }
  return { text, spans };
}

// ---------------------------------------------------------------------------
// OCR for scanned pages (tesseract.js, runs in the browser).
// ---------------------------------------------------------------------------

type OcrWorker = Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>;
let ocrWorker: Promise<OcrWorker> | null = null;

function getOcrWorker(): Promise<OcrWorker> {
  ocrWorker ??= import("tesseract.js").then((t) =>
    t.createWorker(["eng", "spa"], t.OEM.LSTM_ONLY, {
      // Served from this site (see scripts/copy-browser-assets.mjs), not a CDN.
      workerPath: "/tesseract/worker.min.js",
      corePath: "/tesseract/core",
      langPath: "/tesseract/lang",
      workerBlobURL: false,
    }),
  );
  return ocrWorker;
}

export async function shutdownOcr() {
  if (ocrWorker) {
    const w = ocrWorker;
    ocrWorker = null;
    await (await w).terminate();
  }
}

const OCR_SCALE = 300 / 72;

async function ocrLayer(page: PDFPageProxy): Promise<PageText> {
  const vp = page.getViewport({ scale: OCR_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, viewport: vp, intent: "print" }).promise;
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(canvas, {}, { blocks: true });
  canvas.width = canvas.height = 0;

  let text = "";
  const spans: Span[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        line.words.forEach((word, i) => {
          if (i > 0) text += " ";
          const { x0, y0, x1, y1 } = word.bbox;
          const len = word.text.length || 1;
          const boxFor = (s: number, t: number): Box =>
            bboxOf([
              [(x0 + ((x1 - x0) * s) / len) / OCR_SCALE, y0 / OCR_SCALE],
              [(x0 + ((x1 - x0) * t) / len) / OCR_SCALE, y1 / OCR_SCALE],
            ]);
          spans.push({ start: text.length, end: text.length + word.text.length, boxFor, weak: word.confidence < 60 || !/[\p{L}\p{N}]{2}/u.test(word.text) });
          text += word.text;
        });
        text += "\n";
      }
    }
  }
  return { text, spans };
}

function boxesForRange(pt: PageText, start: number, end: number): Box[] {
  const out: Box[] = [];
  for (const s of pt.spans) {
    if (s.end <= start || s.start >= end) continue;
    out.push(s.boxFor(Math.max(start, s.start) - s.start, Math.min(end, s.end) - s.start));
  }
  return mergeLineBoxes(out);
}

/** Join boxes that sit side by side on the same line into one bar. */
function mergeLineBoxes(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of boxes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - b.y) < b.h * 0.5 && Math.abs(last.h - b.h) < b.h * 0.5 && b.x - (last.x + last.w) < b.h * 1.5 && b.x >= last.x - 1) {
      const x = Math.min(last.x, b.x);
      const y = Math.min(last.y, b.y);
      last.w = Math.max(last.x + last.w, b.x + b.w) - x;
      last.h = Math.max(last.y + last.h, b.y + b.h) - y;
      last.x = x;
      last.y = y;
    } else out.push({ ...b });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Images on the page (for signature detection).
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

async function imageBoxes(pdfjs: Pdfjs, page: PDFPageProxy, vp: PageViewport): Promise<Box[]> {
  const ops = await page.getOperatorList();
  const { OPS } = pdfjs;
  const imageOps = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const out: Box[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0];
      if (Array.isArray(m) || ArrayBuffer.isView(m)) ctm = mul(ctm, Array.from(m as ArrayLike<number>) as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (imageOps.has(fn)) {
      const corners: [number, number][] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].map(([x, y]) => {
        const px = ctm[0] * x + ctm[2] * y + ctm[4];
        const py = ctm[1] * x + ctm[3] * y + ctm[5];
        return vp.convertToViewportPoint(px, py) as [number, number];
      });
      out.push(bboxOf(corners));
    }
  }
  return out;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------------------------------------------------------------------------
// Handwriting: dark or colored marks in a zone that aren't part of any text.
// ---------------------------------------------------------------------------

const INK_SCALE = 2;

async function inkFinder(page: PDFPageProxy, pt: PageText): Promise<(zone: Box) => Box | null> {
  const vp = page.getViewport({ scale: INK_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvas, viewport: vp, intent: "print" }).promise;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const textBoxes = pt.spans.filter((s) => !s.weak).map((s) => s.boxFor(0, s.end - s.start));

  return (zone: Box) => {
    const x0 = Math.max(0, Math.floor(zone.x * INK_SCALE));
    const y0 = Math.max(0, Math.floor(zone.y * INK_SCALE));
    const w = Math.min(canvas.width - x0, Math.ceil(zone.w * INK_SCALE));
    const h = Math.min(canvas.height - y0, Math.ceil(zone.h * INK_SCALE));
    if (w <= 0 || h <= 0) return null;
    const px = ctx.getImageData(x0, y0, w, h).data;
    const inText = (x: number, y: number) => textBoxes.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    const rows: number[][] = [];
    for (let y = 0; y < h; y++) {
      const row: number[] = [];
      for (let x = 0; x < w; x++) {
        const k = (y * w + x) * 4;
        const r = px[k], g = px[k + 1], b = px[k + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (lum < 150 || (sat > 70 && lum < 230)) {
          if (!inText((x0 + x) / INK_SCALE, (y0 + y) / INK_SCALE)) row.push(x);
        }
      }
      rows.push(row);
    }
    // Long horizontal runs are signature lines and table rules, not handwriting.
    let count = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rows.forEach((row, y) => {
      if (row.length > w * 0.5) return;
      for (const x of row) {
        count++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    });
    const bw = (maxX - minX) / INK_SCALE;
    const bh = (maxY - minY) / INK_SCALE;
    if (count < 60 || bh < 5 || bw < 15) return null;
    const pad = 4;
    return { x: (x0 + minX) / INK_SCALE - pad, y: (y0 + minY) / INK_SCALE - pad, w: bw + 2 * pad, h: bh + 2 * pad };
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type PdfPage = { index: number; width: number; height: number; ocr: boolean; hasText: boolean };
export type PdfAnalysis = { doc: PDFDocumentProxy; pages: PdfPage[]; findings: Finding[] };
export type Progress = (msg: string, done: number, total: number) => void;

export async function analyzePdf(doc: PDFDocumentProxy, rules: Rule[], opts: { ocr: boolean; onProgress?: Progress }): Promise<PdfAnalysis> {
  const pdfjs = await loadPdfjs();
  const pages: PdfPage[] = [];
  const findings: Finding[] = [];
  let n = 0;
  const add = (f: Omit<Finding, "id">) => findings.push({ ...f, id: `p${n++}` });

  for (let i = 1; i <= doc.numPages; i++) {
    opts.onProgress?.(`Reading page ${i} of ${doc.numPages}`, i - 1, doc.numPages);
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    let pt = await textLayer(page, vp);
    let ocr = false;
    const textChars = pt.text.replace(/\s/g, "").length;
    if (textChars < 30 && opts.ocr) {
      opts.onProgress?.(`Page ${i} looks scanned, reading it with OCR`, i - 1, doc.numPages);
      pt = await ocrLayer(page);
      ocr = true;
    }
    pages.push({ index: i - 1, width: vp.width, height: vp.height, ocr, hasText: pt.text.replace(/\s/g, "").length >= 30 });

    for (const m of findMatches(pt.text, rules)) {
      add({
        category: m.category,
        label: m.label,
        text: m.text,
        context: contextSnippet(pt.text, m.start, m.end),
        selected: m.defaultOn,
        note: m.note ?? (ocr ? "Found by OCR, check the box covers it" : undefined),
        page: i - 1,
        boxes: boxesForRange(pt, m.start, m.end),
      });
    }

    // Filled-in form fields and comment boxes keep their text outside the page content.
    const annots = await page.getAnnotations({ intent: "print" });
    for (const an of annots) {
      const values: string[] = [];
      if (typeof an.fieldValue === "string") values.push(an.fieldValue);
      else if (Array.isArray(an.fieldValue)) values.push(...an.fieldValue.filter((v: unknown) => typeof v === "string"));
      if (an.contentsObj?.str) values.push(an.contentsObj.str);
      if (an.textContent && Array.isArray(an.textContent)) values.push(an.textContent.join(" "));
      for (const v of values) {
        const ms = findMatches(v, rules);
        if (ms.length === 0 || !an.rect) continue;
        const [x1, y1, x2, y2] = an.rect as number[];
        const box = bboxOf([vp.convertToViewportPoint(x1, y1) as [number, number], vp.convertToViewportPoint(x2, y2) as [number, number]]);
        add({
          category: ms[0].category,
          label: `${ms[0].label} (form field)`,
          text: v,
          context: `Form field: ${v}`,
          selected: ms.some((m) => m.defaultOn),
          note: ms[0].note,
          page: i - 1,
          boxes: [box],
        });
      }
    }

    // Signatures: images (or blank zones) beside a client signature label.
    const images = (await imageBoxes(pdfjs, page, vp)).filter((b) => b.w * b.h < vp.width * vp.height * 0.4);
    let ink: ((zone: Box) => Box | null) | null = null;
    let inkBox: Box | null = null;
    const labelRe = new RegExp(SIGNATURE_LABEL.source, "gi");
    let lm: RegExpExecArray | null;
    while ((lm = labelRe.exec(pt.text))) {
      const lineStart = pt.text.lastIndexOf("\n", lm.index) + 1;
      const lineEndIdx = pt.text.indexOf("\n", lm.index);
      const line = pt.text.slice(lineStart, lineEndIdx === -1 ? undefined : lineEndIdx);
      // Labels are short; a "signature" mentioned in a paragraph of instructions is not a signature line.
      if (NOT_CLIENT_SIGNATURE.test(line) || line.trim().length > 80) continue;
      const labelBoxes = boxesForRange(pt, lm.index, lm.index + lm[0].length);
      if (labelBoxes.length === 0) continue;
      const lb = labelBoxes[0];
      const lineH = Math.max(lb.h, 10);
      // Where a signature for this label would be: above it, or to its right on the same line.
      const zone: Box = { x: lb.x - 20, y: lb.y - lineH * 4, w: Math.min(vp.width - lb.x + 20, 320), h: lineH * 5 };
      const near = images.filter((b) => overlaps(b, zone));
      if (near.length) {
        for (const b of near) {
          add({
            category: "signature",
            label: "Signature image",
            text: "[image]",
            context: `Image near “${line.trim().slice(0, 60)}”`,
            selected: true,
            page: i - 1,
            boxes: [b],
          });
        }
      } else if ((ink ??= await inkFinder(page, pt)) && (inkBox = ink(zone))) {
        add({
          category: "signature",
          label: "Handwritten signature",
          text: "[ink]",
          context: `Ink near “${line.trim().slice(0, 60)}”`,
          selected: true,
          note: "Check the box covers the whole signature",
          page: i - 1,
          boxes: [inkBox],
        });
      } else {
        add({
          category: "signature",
          label: "Possible signature area",
          text: "[area]",
          context: `Near “${line.trim().slice(0, 60)}”`,
          selected: false,
          note: "Check the page: select this if the client signed here, or draw a box",
          page: i - 1,
          boxes: [{ x: lb.x - 4, y: lb.y - lineH * 3, w: Math.min(vp.width - lb.x, 260), h: lineH * 4 }],
        });
      }
    }
    page.cleanup();
  }
  opts.onProgress?.("Done", doc.numPages, doc.numPages);
  return { doc, pages, findings };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export async function renderPage(doc: PDFDocumentProxy, index: number, scale: number, canvas: HTMLCanvasElement): Promise<void> {
  const page = await doc.getPage(index + 1);
  const vp = page.getViewport({ scale });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const pdfjs = await loadPdfjs();
  await page.render({ canvas, viewport: vp, intent: "print", annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE }).promise;
}

/**
 * Build the redacted PDF: every page becomes an image with the boxes painted
 * solid black into the pixels.
 */
export async function buildRedactedPdf(
  doc: PDFDocumentProxy,
  boxesByPage: Map<number, Box[]>,
  opts: { dpi?: number; onProgress?: Progress } = {},
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  const scale = (opts.dpi ?? 200) / 72;
  const canvas = document.createElement("canvas");
  for (let i = 0; i < doc.numPages; i++) {
    opts.onProgress?.(`Building page ${i + 1} of ${doc.numPages}`, i, doc.numPages);
    await renderPage(doc, i, scale, canvas);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    for (const b of boxesByPage.get(i) ?? []) {
      ctx.fillRect(Math.floor(b.x * scale), Math.floor(b.y * scale), Math.ceil(b.w * scale) + 1, Math.ceil(b.h * scale) + 1);
    }
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode page"))), "image/jpeg", 0.9));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const page = out.addPage([canvas.width / scale, canvas.height / scale]);
    page.drawImage(img, { x: 0, y: 0, width: canvas.width / scale, height: canvas.height / scale });
  }
  canvas.width = canvas.height = 0;
  out.setTitle("Redacted document");
  out.setAuthor("");
  out.setSubject("");
  out.setKeywords([]);
  out.setCreator("Davis & Kwong toolkit");
  out.setProducer("Davis & Kwong toolkit");
  opts.onProgress?.("Done", doc.numPages, doc.numPages);
  return out.save();
}
