import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Everything under /tools requires a signed-in partner. Pages also check the
// session themselves (lib/session.ts), so this is the first of two locks.
export function proxy(request: NextRequest) {
  const partner = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!partner) {
    const url = new URL("/", request.url);
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = {
  matcher: ["/tools/:path*"],
};
