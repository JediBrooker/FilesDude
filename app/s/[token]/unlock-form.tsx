"use client";

import { CircleAlert, LoaderCircle, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";

/** Asks for a link's password; once it's right, the page reloads with the link open. */
export function UnlockForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/s/${encodeURIComponent(token)}/unlock`, { method: "POST", headers: { "Content-Type": "application/json", "x-filedude-request": "1" }, body: JSON.stringify({ password }), credentials: "same-origin" });
      if (response.ok) {
        window.location.reload();
        return;
      }
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "That didn't work. Try again.");
      setBusy(false);
    } catch {
      setError("The connection was interrupted. Try again.");
      setBusy(false);
    }
  };
  return (
    <form className="login-form" onSubmit={submit}>
      <label><span>Password</span><div className="login-input"><LockKeyhole size={17} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" maxLength={256} required autoFocus /></div></label>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <button className="button primary login-button" disabled={busy || !password}>{busy ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={17} />} Open link</button>
    </form>
  );
}
