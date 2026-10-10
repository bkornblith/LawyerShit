"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { buildRules, findMatches, normalizeANumber, providedCategories } from "@/lib/redaction/rules";
import { CATEGORY_LABELS, EMPTY_CONTEXT, type Box, type Category, type ClientContext, type Finding } from "@/lib/redaction/types";
import ClientForm from "./ClientForm";
import PdfReview from "./PdfReview";
import FindingsList from "./FindingsList";

type Phase = "setup" | "working" | "review" | "done";
type Kind = "pdf" | "docx";
type Result = { url: string; name: string; size: number; warning?: string };

const ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function kindOf(file: File): Kind | "doc" | null {
  const n = file.name.toLowerCase();
  if (n.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".doc")) return "doc";
  return null;
}

function redactedName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} - REDACTED${name.slice(dot)}` : `${name} - REDACTED`;
}

export default function Redactor() {
  const [ctx, setCtx] = useState<ClientContext>(EMPTY_CONTEXT);
  const [file, setFile] = useState<File | null>(null);
  const [ocr, setOcr] = useState(true);
  const [phase, setPhase] = useState<Phase>("setup");
  const [progress, setProgress] = useState<{ msg: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("pdf");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [pdf, setPdf] = useState<{ doc: PDFDocumentProxy; pages: { index: number; width: number; height: number; ocr: boolean; hasText: boolean }[] } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const bufferRef = useRef<ArrayBuffer | null>(null);
  const manualCount = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const rules = useMemo(() => buildRules(ctx), [ctx]);

  // Drop everything about the document when leaving the page.
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);
  useEffect(() => {
    return () => {
      pdf?.doc.loadingTask.destroy();
    };
  }, [pdf]);

  function clearDocument() {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setFindings([]);
    setPdf(null);
    setFile(null);
    bufferRef.current = null;
    setError(null);
    setPhase("setup");
    if (fileInput.current) fileInput.current.value = "";
  }

  function newClient() {
    clearDocument();
    setCtx(EMPTY_CONTEXT);
  }

  function pickFile(f: File | null) {
    setError(null);
    if (!f) return setFile(null);
    const k = kindOf(f);
    if (k === "doc") {
      setError("Older .doc files can't be read here. Open it in Word and use File > Save As > Word Document (.docx), or save it as a PDF.");
      return;
    }
    if (!k) {
      setError("Please choose a PDF or a Word (.docx) file.");
      return;
    }
    setFile(f);
  }

  async function analyze() {
    if (!file) return;
    if (!ctx.fullName.trim()) {
      setError("Enter the client's full name.");
      return;
    }
    if (ctx.aNumber.trim() && !normalizeANumber(ctx.aNumber)) {
      setError("The A-number should have 8 or 9 digits.");
      return;
    }
    setError(null);
    setPhase("working");
    setProgress({ msg: "Opening the file", done: 0, total: 1 });
    try {
      const buf = await file.arrayBuffer();
      bufferRef.current = buf;
      const k = kindOf(file) as Kind;
      setKind(k);
      if (k === "pdf") {
        const { openPdf, analyzePdf } = await import("@/lib/redaction/pdf");
        // pdf.js takes ownership of the bytes it is given, so hand it a copy.
        const doc = await openPdf(buf.slice(0));
        const a = await analyzePdf(doc, rules, { ocr, onProgress: (msg, done, total) => setProgress({ msg, done, total }) });
        setPdf({ doc: a.doc, pages: a.pages });
        setFindings(a.findings);
      } else {
        const { analyzeDocx } = await import("@/lib/redaction/docx");
        const s = await analyzeDocx(buf.slice(0), rules);
        setFindings(s.findings.map(({ id, category, label, text, context, selected, note }) => ({ id, category, label, text, context, selected, note })));
      }
      setPhase("review");
    } catch (e) {
      console.error(e);
      setError(e instanceof Error && /password/i.test(e.message) ? "This PDF is password-protected. Remove the password and try again." : `Couldn't read this file: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("setup");
    }
    setProgress(null);
  }

  function toggle(id: string, value?: boolean) {
    setFindings((fs) => fs.map((f) => (f.id === id ? { ...f, selected: value ?? !f.selected } : f)));
  }
  function setAll(category: Category, value: boolean) {
    setFindings((fs) => fs.map((f) => (f.category === category ? { ...f, selected: value } : f)));
  }
  function addBox(page: number, box: Box) {
    const id = `m${manualCount.current++}`;
    setFindings((fs) => [...fs, { id, category: "manual", label: "Drawn box", text: "", context: `Box drawn on page ${page + 1}`, selected: true, page, boxes: [box] }]);
  }
  function removeFinding(id: string) {
    setFindings((fs) => fs.filter((f) => f.id !== id));
  }

  async function build() {
    if (!file || !bufferRef.current) return;
    setPhase("working");
    setError(null);
    try {
      let blob: Blob;
      let warning: string | undefined;
      if (kind === "pdf" && pdf) {
        const { buildRedactedPdf } = await import("@/lib/redaction/pdf");
        const byPage = new Map<number, Box[]>();
        for (const f of findings) {
          if (!f.selected || f.page === undefined || !f.boxes) continue;
          byPage.set(f.page, [...(byPage.get(f.page) ?? []), ...f.boxes]);
        }
        const bytes = await buildRedactedPdf(pdf.doc, byPage, { onProgress: (msg, done, total) => setProgress({ msg, done, total }) });
        blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      } else {
        const { analyzeDocx, applyDocx, docxText } = await import("@/lib/redaction/docx");
        setProgress({ msg: "Rewriting the document", done: 0, total: 1 });
        // Start from a fresh copy so building twice never compounds edits.
        const session = await analyzeDocx(bufferRef.current.slice(0), rules);
        const chosen = new Set(findings.filter((f) => f.selected).map((f) => f.id));
        blob = await applyDocx(session, chosen);
        // Double-check: anything that would normally be redacted and wasn't deliberately left in.
        const kept = new Set(findings.filter((f) => !f.selected).map((f) => f.text.toLowerCase()));
        const left = findMatches(await docxText(blob), rules).filter((m) => m.defaultOn && !kept.has(m.text.toLowerCase()));
        if (left.length) warning = `After redaction, ${left.length} possible client detail(s) still appear: ${left.slice(0, 5).map((m) => `“${m.text}”`).join(", ")}. Open the file and check.`;
      }
      if (result) URL.revokeObjectURL(result.url);
      setResult({ url: URL.createObjectURL(blob), name: redactedName(file.name), size: blob.size, warning });
      setPhase("done");
    } catch (e) {
      console.error(e);
      setError(`Couldn't build the redacted file: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("review");
    }
    setProgress(null);
  }

  const selected = findings.filter((f) => f.selected);
  const missing = providedCategories(ctx).filter((c) => !selected.some((f) => f.category === c));
  const scanned = pdf?.pages.filter((p) => p.ocr).length ?? 0;
  const noText = pdf?.pages.filter((p) => !p.hasText).length ?? 0;

  return (
    <div className="redactor">
      <div className="page-head">
        <h1>Redact client information</h1>
        <p className="muted">
          Files are processed inside your browser and are never uploaded or stored. The output has the client&apos;s details removed, not just
          covered.
        </p>
      </div>

      {error && <p className="notice error">{error}</p>}

      {phase === "setup" && (
        <div className="setup-grid">
          <section className="panel">
            <h2>1. Client details</h2>
            <p className="muted small">Only these details are redacted. Anyone else named in the document is left alone.</p>
            <ClientForm value={ctx} onChange={setCtx} />
          </section>
          <section className="panel">
            <h2>2. Document</h2>
            <label
              className={`drop ${file ? "has-file" : ""}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickFile(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <input ref={fileInput} type="file" accept={ACCEPT} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
              {file ? (
                <>
                  <strong>{file.name}</strong>
                  <span className="muted small">{file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`} · click to choose a different file</span>
                </>
              ) : (
                <>
                  <strong>Drop a PDF or Word file here</strong>
                  <span className="muted small">or click to choose one (.pdf or .docx)</span>
                </>
              )}
            </label>
            <label className="check">
              <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
              <span>Read scanned pages with OCR (slower; for scans and photos of documents)</span>
            </label>
            <button className="btn primary wide" disabled={!file || !ctx.fullName.trim()} onClick={analyze}>
              Find the client&apos;s information
            </button>
          </section>
        </div>
      )}

      {phase === "working" && progress && (
        <div className="panel working">
          <p>{progress.msg}…</p>
          <progress max={Math.max(progress.total, 1)} value={progress.done} />
        </div>
      )}

      {phase === "review" && (
        <div className="review">
          <div className="review-bar panel">
            <div>
              <strong>{file?.name}</strong>
              <p className="muted small">
                {selected.length} item{selected.length === 1 ? "" : "s"} will be blacked out.
                {kind === "pdf" && " Click a box to include or skip it. Drag on a page to black out anything else, like a handwritten signature."}
              </p>
              {missing.length > 0 && (
                <p className="notice warn small">
                  Nothing selected for: {missing.map((c) => CATEGORY_LABELS[c as Category]).join(", ")}. If it is in the document, it may be
                  written differently. Check the pages and draw boxes where needed.
                </p>
              )}
              {kind === "pdf" && scanned > 0 && <p className="notice small">{scanned} scanned page(s) were read with OCR. Check those pages closely.</p>}
              {kind === "pdf" && noText > 0 && (
                <p className="notice warn small">{noText} page(s) had no readable text. Review them by eye and draw boxes over anything that needs to go.</p>
              )}
            </div>
            <div className="review-actions">
              <button className="btn ghost" onClick={clearDocument}>
                Cancel
              </button>
              <button className="btn primary" onClick={build}>
                Create redacted {kind === "pdf" ? "PDF" : "Word file"}
              </button>
            </div>
          </div>
          <div className={kind === "pdf" ? "review-grid" : ""}>
            {kind === "pdf" && pdf && <PdfReview doc={pdf.doc} pages={pdf.pages} findings={findings} onToggle={toggle} onAddBox={addBox} />}
            <FindingsList findings={findings} onToggle={toggle} onSetAll={setAll} onRemove={removeFinding} showPages={kind === "pdf"} />
          </div>
        </div>
      )}

      {phase === "done" && result && (
        <div className="panel done">
          <h2>Your redacted file is ready</h2>
          {result.warning && <p className="notice warn">{result.warning}</p>}
          <a className="btn primary" href={result.url} download={result.name}>
            Download {result.name}
          </a>
          <p className="muted small">
            {kind === "pdf"
              ? "Each page was rebuilt as an image with the redactions burned in, so the hidden text can't be copied, searched or recovered. Open it and look it over before sending."
              : "The client's details were replaced in the file itself, tracked changes were accepted, and the author fields were cleared. Open it and look it over before sending."}
          </p>
          <div className="row">
            <button className="btn" onClick={() => setPhase("review")}>
              Back to review
            </button>
            <button className="btn" onClick={clearDocument}>
              Another document for this client
            </button>
            <button className="btn ghost" onClick={newClient}>
              New client
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
