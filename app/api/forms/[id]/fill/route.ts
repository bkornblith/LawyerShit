import { NextResponse } from "next/server";
import { MAX_UPLOAD_BYTES, badRequest, str, withPartner } from "@/lib/forms/api";
import { suggestValues, type ContextFile } from "@/lib/forms/fill";
import { getForm, getFormPdf } from "@/lib/forms/store";

// Reading a long form and a stack of documents can take Claude a few minutes.
export const maxDuration = 300;

/**
 * Suggests values for a form from the attorney's notes and the client's files
 * (multipart: notes, files). Nothing in the request is stored.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withPartner(async (partner) => {
    const [form, template] = await Promise.all([getForm(id), getFormPdf(id)]);
    if (!form || !template) return NextResponse.json({ error: "That form isn't in the library anymore." }, { status: 404 });
    const body = await request.formData();
    const notes = str(body, "notes", 50_000) ?? "";
    const files: ContextFile[] = [];
    let total = 0;
    for (const f of body.getAll("files")) {
      if (!(f instanceof File) || f.size === 0) continue;
      total += f.size;
      if (total > MAX_UPLOAD_BYTES) return badRequest("The client files add up to more than 4 MB. Remove some or upload smaller copies.");
      files.push({ name: f.name, type: f.type, data: Buffer.from(await f.arrayBuffer()) });
    }
    if (!notes && files.length === 0) return badRequest("Add some notes about the client or attach their documents first.");
    const result = await suggestValues({ form, template, notes, files, preparedBy: partner.displayName });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  });
}
