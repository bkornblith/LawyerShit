import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken, type Partner } from "./auth";

export async function currentPartner(): Promise<Partner | null> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value);
}

/** For server components behind the front door. Redirects to login if signed out. */
export async function requirePartner(): Promise<Partner> {
  const partner = await currentPartner();
  if (!partner) redirect("/");
  return partner;
}
