import { NextResponse } from "next/server";
import { MAX_UPLOAD_BYTES, badRequest, str, withPartner } from "@/lib/forms/api";
import { suggestValues, type ContextFile } from "@/lib/forms/fill";
import { getForm, getFormPdf } from "@/lib/forms/store";
import { StagedFileError, isStagedPath, readStaged, removeStaged, stagingAvailable, sweepStaged } from "@/lib/forms/staging";

// Reading a long form and a stack of documents can take Claude a few minutes.
export const maxDuration = 300;

type StagedRef = { pathname: string; name: string; type: string };

/**
 * Suggests values for a form from the attorney's notes and the client's files.
 * Either multipart (notes, files) for small uploads, or JSON
 * { notes, staged: [{ pathname, name, type }] } for files the browser put in
 * staging/. Staged files are deleted when the fill ends; nothing is kept.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let staged: string[] = [];
  try {
    return await withPartner(async (partner) => {
      const [form, template] = await Promise.all([getForm(id), getFormPdf(id)]);
      if (!form || !template) return NextResponse.json({ error: "That form isn't in the library anymore." }, { status: 404 });

      let notes = "";
      const files: ContextFile[] = [];
      if (request.headers.get("content-type")?.startsWith("application/json")) {
        const body = (await request.json().catch(() => null)) as { notes?: unknown; staged?: unknown } | null;
        const refs = Array.isArray(body?.staged) ? (body.staged as StagedRef[]) : [];
        if (refs.length > 50 || !refs.every((r) => isStagedPath(r?.pathname))) return badRequest("Those files couldn't be read. Try again.");
        staged = refs.map((r) => r.pathname);
        notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 50_000) : "";
        if (!stagingAvailable()) return badRequest("Large uploads aren't set up.");
        try {
          const data = await readStaged(staged);
          refs.forEach((r, i) => files.push({ name: String(r.name ?? "file").slice(0, 200), type: String(r.type ?? ""), data: data[i] }));
        } catch (e) {
          if (e instanceof StagedFileError) return badRequest(e.message);
          throw e;
        }
      } else {
        const body = await request.formData();
        notes = str(body, "notes", 50_000) ?? "";
        let total = 0;
        for (const f of body.getAll("files")) {
          if (!(f instanceof File) || f.size === 0) continue;
          total += f.size;
          if (total > MAX_UPLOAD_BYTES) return badRequest("The client files add up to more than 4 MB. Remove some or upload smaller copies.");
          files.push({ name: f.name, type: f.type, data: Buffer.from(await f.arrayBuffer()) });
        }
      }

      if (!notes && files.length === 0) return badRequest("Add some notes about the client or attach their documents first.");
      const result = await suggestValues({ form, template, notes, files, preparedBy: partner.displayName });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    });
  } finally {
    if (stagingAvailable()) {
      await removeStaged(staged);
      await sweepStaged();
    }
  }
}
