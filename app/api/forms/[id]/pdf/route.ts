import { NextResponse } from "next/server";
import { withPartner } from "@/lib/forms/api";
import { getFormPdf } from "@/lib/forms/store";

/** The blank form, for filling in the browser. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withPartner(async () => {
    const pdf = await getFormPdf(id);
    if (!pdf) return NextResponse.json({ error: "That form isn't in the library anymore." }, { status: 404 });
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store" },
    });
  });
}
