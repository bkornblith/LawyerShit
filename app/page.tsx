import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { authConfigured } from "@/lib/auth";
import { currentPartner } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function FrontDoor() {
  if (await currentPartner()) redirect("/tools");
  return (
    <main className="door">
      <div className="door-card">
        <div className="brand">
          <span className="brand-mark">D&amp;K</span>
          <div>
            <h1>Davis &amp; Kwong LLP</h1>
            <p className="muted">Firm toolkit</p>
          </div>
        </div>
        {authConfigured() ? (
          <LoginForm />
        ) : (
          <p className="notice warn">
            Sign-in isn&apos;t set up yet. Add AUTH_SECRET, JULIA_PASSWORD and BRENDAN_PASSWORD to the site&apos;s
            environment variables.
          </p>
        )}
      </div>
      <p className="door-foot muted">Private system for Davis &amp; Kwong LLP. Authorized users only.</p>
    </main>
  );
}
