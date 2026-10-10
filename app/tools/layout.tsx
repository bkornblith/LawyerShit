import Link from "next/link";
import { requirePartner } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ToolsLayout({ children }: { children: React.ReactNode }) {
  const partner = await requirePartner();
  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/tools" className="brand small">
          <span className="brand-mark">D&amp;K</span>
          <span>Davis &amp; Kwong Toolkit</span>
        </Link>
        <div className="topbar-right">
          <span className="muted">{partner.displayName}</span>
          <form action="/api/logout" method="post">
            <button className="btn ghost">Sign out</button>
          </form>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
