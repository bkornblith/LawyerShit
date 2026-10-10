"use client";

import { MARK_CLOSE, MARK_OPEN } from "@/lib/redaction/rules";
import { CATEGORY_LABELS, type Category, type Finding } from "@/lib/redaction/types";

type Props = {
  findings: Finding[];
  onToggle: (id: string, value?: boolean) => void;
  onSetAll: (category: Category, value: boolean) => void;
  onRemove: (id: string) => void;
  showPages: boolean;
};

const ORDER: Category[] = ["name", "dob", "a-number", "address", "signature", "other", "manual"];

export default function FindingsList({ findings, onToggle, onSetAll, onRemove, showPages }: Props) {
  if (findings.length === 0) {
    return (
      <aside className="panel findings">
        <p className="muted">Nothing matching the client&apos;s details was found.{showPages && " You can still drag on the pages to black out areas by hand."}</p>
      </aside>
    );
  }
  return (
    <aside className="panel findings">
      {ORDER.map((cat) => {
        const items = findings.filter((f) => f.category === cat);
        if (items.length === 0) return null;
        const on = items.filter((f) => f.selected).length;
        return (
          <section key={cat} className="finding-group">
            <header>
              <h3>
                {CATEGORY_LABELS[cat]} <span className="muted">({on}/{items.length})</span>
              </h3>
              <button className="link" onClick={() => onSetAll(cat, on < items.length)}>
                {on < items.length ? "Select all" : "Clear all"}
              </button>
            </header>
            <ul>
              {items.map((f) => (
                <li key={f.id} className={f.selected ? "on" : "off"}>
                  <label>
                    <input type="checkbox" checked={f.selected} onChange={(e) => onToggle(f.id, e.target.checked)} />
                    <span>
                      <span className="ctx">{renderContext(f.context)}</span>
                      <span className="meta">
                        {f.label}
                        {showPages && f.page !== undefined && (
                          <>
                            {" · "}
                            <a href={`#page-${f.page + 1}`}>page {f.page + 1}</a>
                          </>
                        )}
                        {f.note && <em> · {f.note}</em>}
                      </span>
                    </span>
                  </label>
                  {f.category === "manual" && (
                    <button className="link" onClick={() => onRemove(f.id)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}

/** Show the matched text highlighted inside its context snippet. */
function renderContext(s: string) {
  const a = s.indexOf(MARK_OPEN);
  const b = s.indexOf(MARK_CLOSE);
  if (a < 0 || b < a) return s;
  return (
    <>
      {s.slice(0, a)}
      <mark>{s.slice(a + 1, b)}</mark>
      {s.slice(b + 1)}
    </>
  );
}
