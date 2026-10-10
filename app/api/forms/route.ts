import { NextResponse } from "next/server";
import { aiConfigured } from "@/lib/forms/fill";
import { badRequest, readTemplateUpload, str, withPartner } from "@/lib/forms/api";
import { createForm, listForms } from "@/lib/forms/store";

export async function GET() {
  return withPartner(async () => NextResponse.json({ forms: await listForms(), aiConfigured: aiConfigured() }));
}

/** Adds a form to the library: multipart with file, name, description, instructions. */
export async function POST(request: Request) {
  return withPartner(async (partner) => {
    const form = await request.formData();
    const name = str(form, "name", 200);
    if (!name) return badRequest("Give the form a name.");
    const upload = await readTemplateUpload(form);
    if (!upload) return badRequest("Choose the blank PDF form to upload.");
    const meta = await createForm(
      {
        name,
        description: str(form, "description", 1000) ?? "",
        instructions: str(form, "instructions") ?? "",
        fileName: upload.fileName,
        pageCount: upload.pageCount,
        fields: upload.fields,
      },
      upload.bytes,
      partner.displayName,
    );
    return NextResponse.json({ form: meta }, { status: 201 });
  });
}
