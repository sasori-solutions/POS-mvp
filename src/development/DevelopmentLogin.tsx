import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { AccessButtonContent } from "../components/AccessBusy";

// Synthetic credentials for the isolated local stack, never imported by a production build.
export default function DevelopmentLogin() {
  const [email, setEmail] = useState("owner@pos.local.test");
  const [password, setPassword] = useState("Local-POS-only-2026!");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!supabase || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (result.error || !result.data.session) throw new Error();
      // A fresh document also resets the normal identity cancellation/logout guards.
      window.location.replace(
        sessionStorage.getItem("pos-mexico-pending-invitation") ? "/join" : "/",
      );
    } catch {
      setError(
        "No pudimos entrar. Revisa la cuenta de prueba y que npm run dev siga activo.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="app-shell flex min-h-dvh flex-col">
      <main
        className="auth-panel mx-auto mt-8 w-full max-w-117 flex-1 px-6 pt-8 pb-12 max-compact:mt-4 max-compact:flex max-compact:flex-col max-compact:pt-6 max-compact:pb-10"
        data-pos-development-login
      >
        <section className="access-flow screen development-access">
          <h1>Entorno de desarrollo</h1>
          <p>
            Cuentas de prueba · datos locales.
          </p>
          <p>
            PIN inicial del dueño: <strong>123456</strong>
          </p>
          <form onSubmit={(event) => void login(event)}>
            <div className="field">
              <label htmlFor="dev-account">Cuenta de prueba</label>
              <select
                id="dev-account"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
              >
                <option value="owner@pos.local.test">
                  Dueño · cafetería de prueba
                </option>
                <option value="new@pos.local.test">
                  Cuenta nueva · crear negocio
                </option>
                <option value="employee@pos.local.test">
                  Empleado · aceptar invitación
                </option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="dev-password">Contraseña local</label>
              <input
                id="dev-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={busy}
              />
            </div>
            {error && (
              <p
                className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
                role="alert"
              >
                {error}
              </p>
            )}
            <button className="button primary" disabled={busy} aria-busy={busy}>
              <AccessButtonContent busy={busy}>Entrar en desarrollo</AccessButtonContent>
            </button>
          </form>
          <a
            className="text-button min-h-12 cursor-pointer border-0 bg-transparent text-ink underline underline-offset-4 hover:text-brand"
            href="/login"
          >
            Volver al acceso
          </a>
        </section>
      </main>
    </div>
  );
}
