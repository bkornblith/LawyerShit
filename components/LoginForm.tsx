"use client";

import { useState } from "react";

export default function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = "/tools";
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Sign-in failed.");
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="stack">
      <label>
        <span>Who&apos;s signing in?</span>
        <select value={username} onChange={(e) => setUsername(e.target.value)} required>
          <option value="" disabled>
            Choose…
          </option>
          <option value="julia">Julia Kwong</option>
          <option value="brendan">Brendan Davis</option>
        </select>
      </label>
      <label>
        <span>Password</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <p className="notice error">{error}</p>}
      <button className="btn primary" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
