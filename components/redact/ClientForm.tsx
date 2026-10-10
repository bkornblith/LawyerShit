"use client";

import type { ClientContext } from "@/lib/redaction/types";

type Props = { value: ClientContext; onChange: (v: ClientContext) => void };

export default function ClientForm({ value, onChange }: Props) {
  const set = <K extends keyof ClientContext>(k: K, v: ClientContext[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid">
      <label className="span2">
        <span>Full legal name *</span>
        <input value={value.fullName} onChange={(e) => set("fullName", e.target.value)} placeholder="Juan Carlos García López" autoComplete="off" />
      </label>
      <label className="span2">
        <span>Other names used (one per line)</span>
        <textarea
          rows={2}
          value={value.otherNames.join("\n")}
          onChange={(e) => set("otherNames", e.target.value.split("\n"))}
          placeholder="Maiden names, aliases, other spellings"
        />
      </label>
      <label>
        <span>Date of birth</span>
        <input type="date" value={value.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} />
      </label>
      <label>
        <span>A-number</span>
        <input value={value.aNumber} onChange={(e) => set("aNumber", e.target.value)} placeholder="A-123-456-789" autoComplete="off" />
      </label>
      <label className="span2">
        <span>Street address (with apt or unit)</span>
        <input value={value.street} onChange={(e) => set("street", e.target.value)} placeholder="123 Main St, Apt 4B" autoComplete="off" />
      </label>
      <label>
        <span>City</span>
        <input value={value.city} onChange={(e) => set("city", e.target.value)} autoComplete="off" />
      </label>
      <div className="form-pair">
        <label>
          <span>State</span>
          <input value={value.state} onChange={(e) => set("state", e.target.value)} placeholder="NY" autoComplete="off" />
        </label>
        <label>
          <span>ZIP</span>
          <input value={value.zip} onChange={(e) => set("zip", e.target.value)} inputMode="numeric" autoComplete="off" />
        </label>
      </div>
      <label className="span2">
        <span>Anything else to black out (one per line)</span>
        <textarea
          rows={2}
          value={value.extraTerms.join("\n")}
          onChange={(e) => set("extraTerms", e.target.value.split("\n"))}
          placeholder="Phone number, passport number, email, SSN"
        />
      </label>
    </div>
  );
}
