import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { currentPartner } from "@/lib/session";
import { MAX_STAGED_BYTES, STAGED_TYPES, isStagedPath, stagingAvailable } from "@/lib/forms/staging";

/**
 * Hands the browser a short-lived token to upload one client document into
 * the private Blob store's staging/ folder. The fill route reads it and
 * deletes it as soon as the fill ends.
 */
export async function POST(request: Request) {
  if (!(await currentPartner())) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  if (!stagingAvailable()) return NextResponse.json({ error: "Large uploads aren't set up." }, { status: 503 });
  const body = (await request.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!isStagedPath(pathname)) throw new Error("Uploads must go to the staging folder.");
        return {
          allowedContentTypes: STAGED_TYPES,
          maximumSizeInBytes: MAX_STAGED_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60 * 1000,
        };
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "The upload couldn't start. Try again." }, { status: 400 });
  }
}
