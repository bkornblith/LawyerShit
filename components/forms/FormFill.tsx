"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitLabel } from "@/lib/forms/labels";
import { CHECKED, type FieldValues, type FillResult, type FormField, type FormMeta } from "@/lib/forms/types";

type Phase = "context" | "working" | "review";
type Show = "all" | "filled" | "claude";

// Small uploads go through the site (Vercel caps requests at 4.5 MB). Larger
// ones go straight to the private Blob store and are deleted after the fill.
const DIRECT_MAX = 4 * 1024 * 1024;
const STAGED_MAX = 20 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.eml,image/jpeg,image/png,image/gif,image/webp,image/heic";

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Phone photos of documents are large; shrink them before sending. */
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < 600 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function FieldInput({ field, value, onChange }: { field: FormField; value: string; onChange: (v: string) => void }) {
  if (field.kind === "checkbox") {
    return <input type="checkbox" checked={value === CHECKED} onChange={(e) => onChange(e.target.checked ? CHECKED : "")} />;
  }
  if (field.kind === "dropdown" || field.kind === "radio") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" />
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (field.multiline) {
    return <textarea rows={3} value={value} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
  }
  return <input value={value} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />;
}

export default function FormFill({ id }: { id: string }) {
  const [form, setForm] = useState<FormMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("context");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [values, setValues] = useState<FieldValues>({});
  const [result, setResult] = useState<FillResult | null>(null);
  const [show, setShow] = useState<Show>("all");
  const [query, setQuery] = useState("");
  const [fileName, setFileName] = useState("");
  const [flatten, setFlatten] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const template = useRef<ArrayBuffer | null>(null);
  const started = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    fetch(`/api/forms/${id}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "Couldn't load the form.");
        setForm(json.form);
        setStaging(!!json.stagedUploads);
        setFileName(`${json.form.name} - filled`);
      })
      .catch((e) => setLoadError(e.message));
  }, [id]);

  useEffect(() => {
    if (phase !== "working") return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const maxBytes = staging ? STAGED_MAX : DIRECT_MAX;

  async function addFiles(list: FileList | null) {
    if (!list) return;
    const added = await Promise.all([...list].map(shrinkImage));
    setFiles((prev) => [...prev, ...added]);
    if (fileInput.current) fileInput.current.value = "";
  }

  /** Uploads the files to staging/ and returns the request for the fill route. */
  async function stagedRequest(): Promise<RequestInit> {
    const { upload } = await import("@vercel/blob/client");
    const folder = `staging/${crypto.randomUUID()}`;
    setUploading(true);
    try {
      const staged = await Promise.all(
        files.map(async (f) => {
          const type = f.type || "application/octet-stream";
          const blob = await upload(`${folder}/${f.name.replace(/[^\w.\- ]+/g, "_")}`, f, {
            access: "private",
            handleUploadUrl: "/api/forms/upload",
            contentType: type,
            multipart: f.size > 5 * 1024 * 1024,
          });
          return { pathname: blob.pathname, name: f.name, type: f.type };
        }),
      );
      return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes, staged }) };
    } catch {
      throw new Error("The documents couldn't be uploaded. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  async function runClaude() {
    if (!notes.trim() && files.length === 0) return setError("Add some notes about the client or attach their documents first.");
    if (totalBytes > maxBytes) {
      return setError(`The files add up to ${mb(totalBytes)}; the most Claude can take at once is ${mb(maxBytes)}. Remove some or upload smaller copies.`);
    }
    setError(null);
    started.current = Date.now();
    setElapsed(0);
    setPhase("working");
    try {
      let init: RequestInit;
      if (staging && totalBytes > DIRECT_MAX) {
        init = await stagedRequest();
      } else {
        const body = new FormData();
        body.set("notes", notes);
        for (const f of files) body.append("files", f);
        init = { method: "POST", body };
      }
      const res = await fetch(`/api/forms/${id}/fill`, init);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        throw new Error(
          json?.error ?? (res.status === 504 ? "Claude took too long. Try again, or with fewer documents." : "Something went wrong. Try again."),
        );
      }
      const r = json as FillResult;
      setResult(r);
      setValues(Object.fromEntries(Object.entries(r.values).map(([k, s]) => [k, s.value])));
      setShow(Object.keys(r.values).length ? "claude" : "all");
      setPhase("review");
    } catch (e) {
      setError((e as Error).message);
      setPhase("context");
    }
  }

  function fillByHand() {
    setError(null);
    setResult(null);
    setShow("all");
    setPhase("review");
  }

  async function download() {
    if (!form) return;
    setDownloading(true);
    setError(null);
    try {
      if (!template.current) {
        const res = await fetch(`/api/forms/${id}/pdf`);
        if (!res.ok) throw new Error("Couldn't load the blank form.");
        template.current = await res.arrayBuffer();
      }
      const { fillPdf } = await import("@/lib/forms/pdf");
      const out = await fillPdf(template.current.slice(0), form.fields, values, { flatten });
      setSkipped(out.skipped);
      const url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(fileName.trim() || form.name).replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setError((e as Error).message || "Couldn't build the PDF.");
    }
    setDownloading(false);
  }

  function startOver() {
    if (!confirm("Clear this client's notes, documents and answers and start again?")) return;
    setNotes("");
    setFiles([]);
    setValues({});
    setResult(null);
    setSkipped([]);
    setError(null);
    setPhase("context");
  }

  const filledCount = Object.values(values).filter((v) => v).length;

  const groups = useMemo(() => {
    if (!form) return [];
    const q = query.trim().toLowerCase();
    const visible = form.fields.filter((f) => {
      if (show === "filled" && !values[f.key]) return false;
      if (show === "claude" && !result?.values[f.key]) return false;
      return !q || f.label.toLowerCase().includes(q) || (values[f.key] ?? "").toLowerCase().includes(q);
    });
    const out: { key: string; page: number; section: string; fields: { field: FormField; item: string }[] }[] = [];
    for (const field of visible) {
      const { section, item } = splitLabel(field.label);
      const last = out[out.length - 1];
      if (last && last.page === field.page && last.section === section) last.fields.push({ field, item });
      else out.push({ key: `${field.page}-${section}-${field.key}`, page: field.page, section, fields: [{ field, item }] });
    }
    return out;
  }, [form, show, query, values, result]);

  if (loadError) {
    return (
      <>
        <p>
          <Link href="/tools/forms">← Form library</Link>
        </p>
        <div className="notice error">{loadError}</div>
      </>
    );
  }
  if (!form) return <p className="muted">Loading the form…</p>;

  return (
    <>
      <p className="small">
        <Link href="/tools/forms">← Form library</Link>
      </p>
      <div className="page-head">
        <h1>{form.name}</h1>
        {form.description && <p className="muted">{form.description}</p>}
      </div>
      {error && <div className="notice error">{error}</div>}

      {phase === "context" && (
        <div className="setup-grid">
          <div className="panel stack">
            <h2>About the client</h2>
            <label>
              <span>Notes for Claude</span>
              <textarea
                rows={12}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={
                  "Anything Claude should know: who the client is, their role on this form, facts not in the documents.\n\n" +
                  "e.g. Client is Maria Lopez Hernandez, filing as an SIJ self-petitioner. Born 03/14/2008 in San Pedro Sula, Honduras. " +
                  "Lives with her aunt at 123 W 45th St, Apt 4B, Brooklyn NY 11201. Entered without inspection 06/2022. SIJ order from Kings County Family Court attached."
                }
              />
            </label>
            {form.instructions && (
              <p className="muted small">
                <strong>Standing instructions for this form:</strong> {form.instructions}
              </p>
            )}
          </div>
          <div className="panel">
            <h2>Client documents</h2>
            <label className="drop">
              <input ref={fileInput} type="file" multiple accept={ACCEPT} onChange={(e) => addFiles(e.target.files)} />
              <strong>Add documents</strong>
              <span className="muted small">Passport, birth certificate, court orders, intake notes. PDF, Word, photos or text.</span>
            </label>
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <span>{f.name}</span>
                    <span className="muted small">{mb(f.size)}</span>
                    <button className="link" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </li>
                ))}
                <li className={totalBytes > maxBytes ? "over" : "muted small"}>
                  Total {mb(totalBytes)} of {mb(maxBytes)}
                </li>
              </ul>
            )}
            <div className="stack">
              <button className="btn primary wide" onClick={runClaude}>
                Fill the form with Claude
              </button>
              <button className="btn wide" onClick={fillByHand}>
                Fill it in by hand instead
              </button>
              <p className="muted small">
                Notes and documents are sent to Claude (Anthropic&apos;s API) to fill this form. This site doesn&apos;t
                keep them: large files are held in the firm&apos;s private storage only while Claude reads them, then
                deleted.
              </p>
            </div>
          </div>
        </div>
      )}

      {phase === "working" && (
        <div className="panel working">
          <h2>{uploading ? "Uploading the client\u2019s documents…" : "Claude is reading the form and the client\u2019s documents…"}</h2>
          <p className="muted">
            Long forms take a few minutes. {elapsed > 0 && `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
          </p>
          <progress />
        </div>
      )}

      {phase === "review" && (
        <>
          <div className="panel review-bar static">
            <div>
              <h2>Check the answers</h2>
              <p className="muted small">
                {filledCount} of {form.fields.length} fields filled
                {result && ` · ${Object.keys(result.values).length} suggested by Claude`}. Change anything below, then download.
              </p>
            </div>
            <div className="review-actions">
              <button className="btn" onClick={() => setPhase("context")}>
                Back to notes
              </button>
              <button className="btn ghost" onClick={startOver}>
                Start over
              </button>
            </div>
          </div>

          {result && (result.missing.length > 0 || result.notes) && (
            <div className="notice warn">
              {result.missing.length > 0 && (
                <>
                  <strong>Not found in the notes or documents:</strong>
                  <ul className="tight">
                    {result.missing.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
              {result.notes && (
                <p>
                  <strong>Check:</strong> {result.notes}
                </p>
              )}
            </div>
          )}

          <div className="fill-grid">
            <div>
              <div className="row field-filters">
                <select value={show} onChange={(e) => setShow(e.target.value as Show)} aria-label="Which fields to show">
                  <option value="all">All fields</option>
                  <option value="filled">Filled in</option>
                  {result && <option value="claude">Filled by Claude</option>}
                </select>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search fields" />
              </div>
              {groups.length === 0 && <p className="muted">No fields match.</p>}
              {groups.map((g, i) => (
                <section key={g.key} className="panel field-group">
                  {(i === 0 || groups[i - 1].page !== g.page) && <p className="page-tag">Page {g.page || "?"}</p>}
                  {g.section && <h3>{g.section}</h3>}
                  {g.fields.map(({ field, item }) => {
                    const s = result?.values[field.key];
                    const v = values[field.key] ?? "";
                    return (
                      <div key={field.key} className={`field-row kind-${field.kind}${v ? " filled" : ""}`}>
                        <label>
                          <span className="field-label">{item}</span>
                          <FieldInput field={field} value={v} onChange={(nv) => setValues((prev) => ({ ...prev, [field.key]: nv }))} />
                        </label>
                        {s && (
                          <span className="basis">
                            {s.value === v ? `Claude · ${s.basis || "from the materials"}` : `Edited (Claude suggested "${s.value}")`}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
            <aside className="panel download-box">
              <h2>Download</h2>
              <label>
                <span>File name</span>
                <input value={fileName} onChange={(e) => setFileName(e.target.value)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
                <span>Lock the answers (flatten) so the PDF can&apos;t be edited</span>
              </label>
              <button className="btn primary wide" onClick={download} disabled={downloading}>
                {downloading ? "Building the PDF…" : "Download filled PDF"}
              </button>
              {skipped.length > 0 && (
                <p className="notice warn small">
                  These couldn&apos;t be filled and were left blank: {skipped.join("; ")}
                </p>
              )}
              <p className="muted small">The PDF is put together on this computer; nothing is saved on the site.</p>
            </aside>
          </div>
        </>
      )}
    </>
  );
}
