import { NextResponse } from "next/server";
import { stagingAvailable } from "@/lib/forms/staging";
import { readTemplateUpload, str, withPartner } from "@/lib/forms/api";
import { deleteForm, getForm, updateForm } from "@/lib/forms/store";

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "That form isn't in the library anymore." }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withPartner(async () => {
    const form = await getForm(id);
    return form ? NextResponse.json({ form, stagedUploads: stagingAvailable() }) : notFound();
  });
}

/** Renames or edits a form, and optionally replaces its PDF (multipart). */
export async function PATCH(request: Request, { params }: Ctx) {
  const { id } = await params;
  return withPartner(async (partner) => {
    const form = await request.formData();
    const changes: { name?: string; description?: string; instructions?: string } = {};
    const name = str(form, "name", 200);
    if (name !== undefined) {
      if (!name) return NextResponse.json({ error: "The form needs a name." }, { status: 400 });
      changes.name = name;
    }
    const description = str(form, "description", 1000);
    if (description !== undefined) changes.description = description;
    const instructions = str(form, "instructions");
    if (instructions !== undefined) changes.instructions = instructions;
    const upload = await readTemplateUpload(form);
    const meta = await updateForm(
      id,
      changes,
      upload && { pdf: upload.bytes, fileName: upload.fileName, pageCount: upload.pageCount, fields: upload.fields },
      partner.displayName,
    );
    return meta ? NextResponse.json({ form: meta }) : notFound();
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return withPartner(async () => {
    return (await deleteForm(id)) ? NextResponse.json({ ok: true }) : notFound();
  });
}
