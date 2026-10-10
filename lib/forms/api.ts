import "server-only";
import { NextResponse } from "next/server";
import { currentPartner } from "@/lib/session";
import type { Partner } from "@/lib/auth";
import { FormPdfError, prepareTemplate } from "./pdf";
import { StoreNotConfiguredError } from "./store";
import { FillError } from "./fill";

// Helpers shared by the /api/forms routes.

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB.

type Handler = (partner: Partner) => Promise<Response>;

/** Requires a signed-in partner and turns known errors into friendly JSON responses. */
export async function withPartner(handler: Handler): Promise<Response> {
  const partner = await currentPartner();
  if (!partner) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  try {
    return await handler(partner);
  } catch (e) {
    if (e instanceof StoreNotConfiguredError) return NextResponse.json({ error: e.message }, { status: 503 });
    if (e instanceof FormPdfError || e instanceof FillError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}

export function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

export function str(form: FormData, key: string, max = 4000): string | undefined {
  const v = form.get(key);
  return typeof v === "string" ? v.trim().slice(0, max) : undefined;
}

/** Reads an uploaded blank form PDF from a multipart request. */
export async function readTemplateUpload(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_UPLOAD_BYTES) throw new FormPdfError("That PDF is larger than 4 MB, which is the most the site can accept.");
  const prepared = await prepareTemplate(new Uint8Array(await file.arrayBuffer()));
  return { ...prepared, fileName: file.name.slice(0, 200) || "form.pdf" };
}
