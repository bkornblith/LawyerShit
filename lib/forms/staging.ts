import "server-only";
import { del, get, list } from "@vercel/blob";

// Client documents too large to send through a Vercel function (4.5 MB) are
// uploaded straight from the browser into the private Blob store under
// staging/, read once by the fill route, and deleted as soon as the fill ends.
// A sweep on every fill removes anything a crashed or timed-out run left behind.

export const STAGING_PREFIX = "staging/";

// Claude accepts requests up to 32 MB, and files are sent base64-encoded (a
// third larger), alongside the blank form itself.
export const MAX_STAGED_BYTES = 20 * 1024 * 1024;

export const STAGED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/*",
  "application/json",
  "message/rfc822",
  "application/octet-stream",
];

const STALE_MS = 60 * 60 * 1000;

export function stagingAvailable(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

export function isStagedPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(STAGING_PREFIX) && !path.includes("..") && path.length < 600;
}

/** Reads staged files, refusing to go past the size limit. */
export async function readStaged(paths: string[]): Promise<Buffer[]> {
  let total = 0;
  const out: Buffer[] = [];
  for (const path of paths) {
    const res = await get(path, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200) throw new StagedFileError("A client file didn't finish uploading. Try again.");
    total += res.blob.size;
    if (total > MAX_STAGED_BYTES) {
      await res.stream.cancel();
      throw new StagedFileError("The client files add up to more than 20 MB. Remove some or upload smaller copies.");
    }
    out.push(Buffer.from(await new Response(res.stream).arrayBuffer()));
  }
  return out;
}

export class StagedFileError extends Error {}

export async function removeStaged(paths: string[]) {
  if (!paths.length) return;
  try {
    await del(paths);
  } catch (e) {
    console.error("Couldn't delete staged client files; the next fill's sweep will retry.", e);
  }
}

/** Deletes staged files older than an hour. */
export async function sweepStaged() {
  try {
    const cutoff = Date.now() - STALE_MS;
    const stale: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: STAGING_PREFIX, cursor });
      for (const b of page.blobs) if (new Date(b.uploadedAt).getTime() < cutoff) stale.push(b.url);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    if (stale.length) await del(stale);
  } catch (e) {
    console.error("Couldn't sweep old staged client files.", e);
  }
}
