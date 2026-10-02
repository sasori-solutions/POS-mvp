import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Mail, Check } from "lucide-react";
import { AccountClientError } from "../lib/account";

export default function RequestPinRecovery({
  businessName,
  email,
  request,
  onBack,
  onSessionError,
}: {
  businessName: string;
  email?: string;
  request: () => Promise<{ sent: true; retryAfterSeconds: number }>;
  onBack: () => void;
  onSessionError: (error: unknown) => void;
}) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  async function send() {
    if (pending.current || Date.now() < retryAt) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request();
      if (!alive.current) return;
      setSent(true);
      setNow(Date.now());
      setRetryAt(Date.now() + result.retryAfterSeconds * 1000);
    } catch (problem) {
      if (!alive.current) return;
      if (
        problem instanceof AccountClientError &&
        [
          "AUTH_REQUIRED",
          "GOOGLE_REQUIRED",
          "DEVICE_REVOKED",
          "EMPLOYEE_INACTIVE",
          "BUSINESS_ACCESS_DENIED",
        ].includes(problem.code)
      ) {
        onSessionError(problem);
        return;
      }
      if (
        problem instanceof AccountClientError &&
        problem.code === "RECOVERY_LOCKED"
      ) {
        setRetryAt(Date.now() + (problem.retryAfterSeconds ?? 60) * 1000);
        setNow(Date.now());
      }
      setSent(false);
      setError(
        problem instanceof Error
          ? problem.message
          : "No pudimos enviar el correo. Intenta de nuevo.",
      );
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="screen flex flex-col max-compact:flex-1">
      <button
        className="back-button -mt-4 mb-4 flex min-h-12 items-center gap-2 self-start border-0 bg-transparent pt-0 pb-4 text-sm text-muted hover:text-ink"
        onClick={onBack}
      >
        <ArrowLeft size={20} aria-hidden="true" />
        Volver al PIN
      </button>
      <div className="screen-icon mb-8 grid size-16 place-items-center rounded-2xl border border-line max-compact:mb-7 small size-12 rounded-xl mb-6">
        {sent ? <Check aria-hidden="true" /> : <Mail aria-hidden="true" />}
      </div>
      <h1>{sent ? "Revisa tu correo" : "Recupera tu PIN"}</h1>
      <p>
        {sent
          ? "Enviamos un enlace para que elijas un nuevo PIN."
          : `Te enviaremos un enlace para cambiar tu PIN de ${businessName}.`}
      </p>
      {email && (
        <p className="recovery-email font-medium text-ink [overflow-wrap:anywhere]">
          {email}
        </p>
      )}
      <p className="field-help text-sm text-muted">
        {sent
          ? "Abre el correo de POS México y toca «Elegir nuevo PIN». El enlace vence en 15 minutos."
          : "Al abrir el enlace podrás elegir tu nuevo PIN."}
      </p>
      {error && (
        <p
          className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="screen-actions mt-10 flex flex-col gap-3">
        <button
          className={`button ${sent ? "secondary" : "primary"}`}
          disabled={busy || remaining > 0}
          aria-busy={busy}
          onClick={() => void send()}
        >
          {busy
            ? "Enviando…"
            : remaining > 0
              ? `Reenviar en ${remaining} s`
              : sent
                ? "Reenviar correo"
                : "Enviar enlace al correo"}
        </button>
        {sent && (
          <p className="action-note text-center text-sm">
            Si no llega, revisa la carpeta de spam. Al reenviar, el enlace
            anterior deja de funcionar.
          </p>
        )}
      </div>
    </section>
  );
}
