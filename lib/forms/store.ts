import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { del, get, list, put } from "@vercel/blob";
import type { FormMeta, FormSummary } from "./types";

// The form library: blank form PDFs and their field lists. Only blank templates
// are stored here, never client information.
//
// In production this is a private Vercel Blob store (BLOB_READ_WRITE_TOKEN is
// added when the store is connected to the project). Each form is two blobs:
//   forms/<id>/meta.json   name, description, instructions, field list
//   forms/<id>/form.pdf    the blank, unencrypted form
// For local development without a token, files go under .data/forms/ instead.

export class StoreNotConfiguredError extends Error {
  constructor() {
    super(
      "The form library isn't set up yet: connect a private Vercel Blob store to this project (Storage tab in Vercel), then redeploy.",
    );
  }
}

interface Backend {
  read(path: string): Promise<Buffer | null>;
  write(path: string, body: Buffer | string, contentType: string): Promise<void>;
  /** Paths of every meta.json in the library. */
  metaPaths(): Promise<string[]>;
  removeForm(id: string): Promise<void>;
}

const blobBackend: Backend = {
  async read(path) {
    const res = await get(path, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  },
  async write(path, body, contentType) {
    await put(path, body, {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  },
  async metaPaths() {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: "forms/", cursor });
      for (const b of page.blobs) if (b.pathname.endsWith("/meta.json")) paths.push(b.pathname);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return paths;
  },
  async removeForm(id) {
    const page = await list({ prefix: `forms/${id}/` });
    if (page.blobs.length) await del(page.blobs.map((b) => b.url));
  },
};

const localRoot = join(process.cwd(), ".data");
const localBackend: Backend = {
  async read(path) {
    try {
      return await readFile(join(localRoot, path));
    } catch {
      return null;
    }
  },
  async write(path, body) {
    const full = join(localRoot, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  },
  async metaPaths() {
    try {
      const ids = await readdir(join(localRoot, "forms"));
      return ids.map((id) => `forms/${id}/meta.json`);
    } catch {
      return [];
    }
  },
  async removeForm(id) {
    await rm(join(localRoot, "forms", id), { recursive: true, force: true });
  },
};

function backend(): Backend {
  if (process.env.BLOB_READ_WRITE_TOKEN) return blobBackend;
  if (process.env.VERCEL) throw new StoreNotConfiguredError();
  return localBackend;
}

const ID = /^[a-z0-9-]{8,64}$/;

function summarize(meta: FormMeta): FormSummary {
  const { fields, ...rest } = meta;
  return { ...rest, fieldCount: fields.length };
}

export async function listForms(): Promise<FormSummary[]> {
  const b = backend();
  const metas = await Promise.all(
    (await b.metaPaths()).map(async (p) => {
      const raw = await b.read(p);
      try {
        return raw ? (JSON.parse(raw.toString("utf8")) as FormMeta) : null;
      } catch {
        return null;
      }
    }),
  );
  return metas
    .filter((m): m is FormMeta => !!m)
    .map(summarize)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export async function getForm(id: string): Promise<FormMeta | null> {
  if (!ID.test(id)) return null;
  const raw = await backend().read(`forms/${id}/meta.json`);
  return raw ? (JSON.parse(raw.toString("utf8")) as FormMeta) : null;
}

export async function getFormPdf(id: string): Promise<Buffer | null> {
  if (!ID.test(id)) return null;
  return backend().read(`forms/${id}/form.pdf`);
}

async function saveMeta(meta: FormMeta) {
  await backend().write(`forms/${meta.id}/meta.json`, JSON.stringify(meta), "application/json");
}

export async function createForm(
  input: Pick<FormMeta, "name" | "description" | "instructions" | "fileName" | "pageCount" | "fields">,
  pdf: Uint8Array,
  by: string,
): Promise<FormMeta> {
  const now = new Date().toISOString();
  const meta: FormMeta = { id: randomUUID(), ...input, createdAt: now, createdBy: by, updatedAt: now, updatedBy: by };
  // PDF first, so a meta.json never points at a missing file.
  await backend().write(`forms/${meta.id}/form.pdf`, Buffer.from(pdf), "application/pdf");
  await saveMeta(meta);
  return meta;
}

export async function updateForm(
  id: string,
  changes: Partial<Pick<FormMeta, "name" | "description" | "instructions">>,
  replacement: { pdf: Uint8Array; fileName: string; pageCount: number; fields: FormMeta["fields"] } | null,
  by: string,
): Promise<FormMeta | null> {
  const current = await getForm(id);
  if (!current) return null;
  const meta: FormMeta = { ...current, ...changes, updatedAt: new Date().toISOString(), updatedBy: by };
  if (replacement) {
    await backend().write(`forms/${id}/form.pdf`, Buffer.from(replacement.pdf), "application/pdf");
    meta.fileName = replacement.fileName;
    meta.pageCount = replacement.pageCount;
    meta.fields = replacement.fields;
  }
  await saveMeta(meta);
  return meta;
}

export async function deleteForm(id: string): Promise<boolean> {
  if (!ID.test(id)) return false;
  await backend().removeForm(id);
  return true;
}
