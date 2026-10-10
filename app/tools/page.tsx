import Link from "next/link";
import { TOOLS } from "@/lib/tools";
import { requirePartner } from "@/lib/session";

export default async function Dashboard() {
  const partner = await requirePartner();
  return (
    <>
      <h1>Good to see you, {partner.displayName.split(" ")[0]}.</h1>
      <p className="muted">Pick a tool.</p>
      <div className="tool-grid">
        {TOOLS.map((t) => (
          <Link key={t.slug} href={`/tools/${t.slug}`} className="tool-card">
            <h2>{t.name}</h2>
            <p>{t.description}</p>
            <span className="tool-go">Open →</span>
          </Link>
        ))}
        <div className="tool-card placeholder">
          <h2>More tools</h2>
          <p>New tools for the firm will show up here.</p>
        </div>
      </div>
    </>
  );
}
