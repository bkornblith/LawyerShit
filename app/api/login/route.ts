import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  authConfigured,
  checkCredentials,
  createSessionToken,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: "Login is not set up yet. AUTH_SECRET, JULIA_PASSWORD and BRENDAN_PASSWORD must be set." },
      { status: 503 },
    );
  }
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const partner = checkCredentials(username, password);
  if (!partner) {
    // Small fixed delay to slow down guessing.
    await new Promise((r) => setTimeout(r, 750));
    return NextResponse.json({ error: "That username and password don't match." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, name: partner.displayName });
  res.cookies.set(SESSION_COOKIE, createSessionToken(partner.username), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
