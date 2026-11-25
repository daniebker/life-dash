import { useEffect, useRef, useState, type FormEvent } from "react";
import * as api from "../lib/api.ts";

/* Sign-in form; when no accounts exist yet it becomes "Create your account" (first-run setup). */
export function LoginForm({ setupMode, needCode, message, onSignedIn, onSetupDone }: {
  setupMode: boolean;
  needCode: boolean;
  message: string;
  onSignedIn: () => void;
  onSetupDone: (message: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState(message);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => { setError(message); }, [message]);
  useEffect(() => { first.current?.focus(); }, [setupMode, needCode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (setupMode && password !== password2) { setError("The passwords don't match."); return; }
    setBusy(true);
    try {
      const r = setupMode ? await api.setup(username, password, needCode ? code : undefined) : await api.login(username, password);
      if (setupMode && r.status === 409) { onSetupDone(r.error ?? "Setup is already done. Sign in instead."); return; } // someone finished setup first
      if (!r.ok) { setError(r.error ?? (setupMode ? "Couldn't create the account." : "Sign-in failed.")); return; }
      setPassword(""); setPassword2(""); setCode("");
      onSignedIn();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" id="login" onSubmit={submit}>
      <div><div className="eyebrow">Life Dash</div><h1 id="lTitle">{setupMode ? "Create your account" : "Sign in"}</h1></div>
      {setupMode && <p className="sub">There are no accounts yet. Create the first one to start using Life Dash.</p>}
      {setupMode && needCode && (
        <label htmlFor="lCode" id="lCodeRow">Setup code
          <input id="lCode" ref={first} value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} required />
        </label>
      )}
      <label htmlFor="lUser">Username
        <input id="lUser" ref={setupMode && needCode ? undefined : first} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
      </label>
      <label htmlFor="lPass">Password
        <input id="lPass" type="password" value={password} onChange={e => setPassword(e.target.value)}
          autoComplete={setupMode ? "new-password" : "current-password"} minLength={setupMode ? 10 : undefined} required />
      </label>
      {setupMode && (
        <label htmlFor="lPass2">Repeat password
          <input id="lPass2" type="password" value={password2} onChange={e => setPassword2(e.target.value)} autoComplete="new-password" required />
        </label>
      )}
      <button className="ghost primary" type="submit" id="lBtn" disabled={busy}>{setupMode ? "Create account" : "Sign in"}</button>
      <div className="msg err" id="lMsg" role="alert">{error}</div>
    </form>
  );
}
