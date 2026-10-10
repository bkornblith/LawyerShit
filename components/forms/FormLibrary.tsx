"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FormSummary } from "@/lib/forms/types";

const MAX_BYTES = 4 * 1024 * 1024;

function when(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function nameFromFile(fileName: string) {
  return fileName.replace(/\.pdf$/i, "").replace(/_+/g, " ").trim().toUpperCase();
}

async function send(url: string, method: string, body?: FormData) {
  const res = await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Something went wrong. Try again.");
  return json;
}

type Draft = { name: string; description: string; instructions: string; file: File | null };
const EMPTY: Draft = { name: "", description: "", instructions: "", file: null };

function FormFields({ draft, setDraft, replacing }: { draft: Draft; setDraft: (d: Draft) => void; replacing?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="stack">
      <label className={`drop slim${draft.file ? " has-file" : ""}`}>
        <input
          ref={input}
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            setDraft({ ...draft, file, name: draft.name || (file ? nameFromFile(file.name) : "") });
          }}
        />
        {draft.file ? (
          <>
            <strong>{draft.file.name}</strong>
            <span className="muted small">Click to choose a different file</span>
          </>
        ) : (
          <>
            <strong>{replacing ? "Replace the PDF (optional)" : "Choose the blank, fillable PDF"}</strong>
            <span className="muted small">For USCIS forms, use the PDF downloaded from uscis.gov. Up to 4 MB.</span>
          </>
        )}
      </label>
      <label>
        <span>Name</span>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="I-360" />
      </label>
      <label>
        <span>Description</span>
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Petition for Amerasian, Widow(er), or Special Immigrant"
        />
      </label>
      <label>
        <span>Standing instructions for filling it (optional)</span>
        <textarea
          rows={3}
          value={draft.instructions}
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          placeholder="e.g. We file these for SIJ clients, so the client is the self-petitioner and Part 1 is skipped. Our attorney is Julia Kwong, NY bar #..."
        />
      </label>
    </div>
  );
}

export default function FormLibrary() {
  const [forms, setForms] = useState<FormSummary[] | null>(null);
  const [aiReady, setAiReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const json = await send("/api/forms", "GET");
      setForms(json.forms);
      setAiReady(json.aiConfigured);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setForms([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function body(d: Draft) {
    const fd = new FormData();
    fd.set("name", d.name);
    fd.set("description", d.description);
    fd.set("instructions", d.instructions);
    if (d.file) fd.set("file", d.file);
    return fd;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.file) return setError("Choose the blank PDF form to upload.");
    if (draft.file.size > MAX_BYTES) return setError("That PDF is larger than 4 MB, which is the most the site can accept.");
    setBusy("add");
    setError(null);
    try {
      await send("/api/forms", "POST", body(draft));
      setDraft(EMPTY);
      setAdding(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  }

  function startEdit(f: FormSummary) {
    setEditing(f.id);
    setEditDraft({ name: f.name, description: f.description, instructions: f.instructions, file: null });
    setError(null);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (editDraft.file && editDraft.file.size > MAX_BYTES) return setError("That PDF is larger than 4 MB, which is the most the site can accept.");
    setBusy(editing);
    setError(null);
    try {
      await send(`/api/forms/${editing}`, "PATCH", body(editDraft));
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  }

  async function remove(f: FormSummary) {
    if (!confirm(`Delete "${f.name}" from the form library? This can't be undone.`)) return;
    setBusy(f.id);
    setError(null);
    try {
      await send(`/api/forms/${f.id}`, "DELETE");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  }

  return (
    <>
      <div className="page-head row-between">
        <div>
          <h1>Fill a form</h1>
          <p className="muted">
            Keep the firm&apos;s blank forms here. Pick one, give Claude the client&apos;s details and documents, check
            what it filled in, and download the completed PDF.
          </p>
        </div>
        {!adding && (
          <button className="btn primary" onClick={() => { setAdding(true); setError(null); }}>
            Add a form
          </button>
        )}
      </div>

      {!aiReady && (
        <div className="notice warn">
          Automatic filling isn&apos;t switched on yet (the Claude API key hasn&apos;t been added in Vercel). You can still
          keep forms here and fill them in by hand.
        </div>
      )}
      {error && <div className="notice error">{error}</div>}

      {adding && (
        <form className="panel add-form" onSubmit={add}>
          <h2>Add a form to the library</h2>
          <FormFields draft={draft} setDraft={setDraft} />
          <div className="row">
            <button className="btn primary" disabled={busy === "add"}>
              {busy === "add" ? "Reading the form…" : "Add to library"}
            </button>
            <button type="button" className="btn ghost" onClick={() => { setAdding(false); setDraft(EMPTY); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {forms === null ? (
        <p className="muted">Loading the form library…</p>
      ) : forms.length === 0 && !adding ? (
        <div className="panel empty">
          <h2>No forms yet</h2>
          <p className="muted">Add the first blank form, such as the I-360 from uscis.gov.</p>
        </div>
      ) : (
        <ul className="form-list">
          {forms.map((f) =>
            editing === f.id ? (
              <li key={f.id} className="panel">
                <form onSubmit={saveEdit} className="stack">
                  <h2>Edit {f.name}</h2>
                  <FormFields draft={editDraft} setDraft={setEditDraft} replacing />
                  <div className="row">
                    <button className="btn primary" disabled={busy === f.id}>
                      {busy === f.id ? "Saving…" : "Save changes"}
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={f.id} className="panel form-row">
                <div className="form-row-main">
                  <h2>{f.name}</h2>
                  {f.description && <p>{f.description}</p>}
                  <p className="muted small">
                    {f.pageCount} pages · {f.fieldCount} fields · updated {when(f.updatedAt)} by {f.updatedBy}
                  </p>
                </div>
                <div className="form-row-actions">
                  <Link className="btn primary" href={`/tools/forms/${f.id}`}>
                    Fill
                  </Link>
                  <button className="btn" onClick={() => startEdit(f)} disabled={!!busy}>
                    Edit
                  </button>
                  <button className="btn ghost danger" onClick={() => remove(f)} disabled={!!busy}>
                    {busy === f.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </>
  );
}
