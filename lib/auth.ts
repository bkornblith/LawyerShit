import { createHmac, timingSafeEqual } from "node:crypto";

// Session cookies are signed with AUTH_SECRET. Nothing about the session is
// stored server-side; the cookie carries the username and an expiry.

export const SESSION_COOKIE = "dk_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours

export type Partner = { username: string; displayName: string; envVar: string };

export const PARTNERS: Partner[] = [
  { username: "julia", displayName: "Julia Kwong", envVar: "JULIA_PASSWORD" },
  { username: "brendan", displayName: "Brendan Davis", envVar: "BRENDAN_PASSWORD" },
];

function secret(): string | null {
  const s = process.env.AUTH_SECRET;
  return s && s.length >= 16 ? s : null;
}

function safeEqual(a: string, b: string): boolean {
  // Hash both sides first so the comparison is constant-time regardless of length.
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function authConfigured(): boolean {
  return secret() !== null && PARTNERS.every((p) => !!process.env[p.envVar]);
}

export function checkCredentials(username: string, password: string): Partner | null {
  const partner = PARTNERS.find((p) => p.username === username.trim().toLowerCase());
  // Always run a comparison so timing doesn't reveal whether the username exists.
  const expected = partner ? process.env[partner.envVar] ?? "" : "";
  const ok = safeEqual(password, expected) && expected.length > 0;
  return ok && partner ? partner : null;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createSessionToken(username: string): string {
  const key = secret();
  if (!key) throw new Error("AUTH_SECRET is not configured");
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export function verifySessionToken(token: string | undefined | null): Partner | null {
  const key = secret();
  if (!key || !token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload, key))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof exp !== "number" || exp < Date.now() / 1000) return null;
    return PARTNERS.find((p) => p.username === u) ?? null;
  } catch {
    return null;
  }
}
