import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Mail, Check } from 'lucide-react'
import { AccountClientError } from '../lib/account'

export default function RequestPinRecovery({ businessName, email, request, onBack, onSessionError }: {
  businessName: string; email?: string; request: () => Promise<{ sent: true; retryAfterSeconds: number }>
  onBack: () => void; onSessionError: (error: unknown) => void
}) {
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const alive = useRef(true)
  const pending = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (!retryAt) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [retryAt])
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000))
  async function send() {
    if (pending.current || Date.now() < retryAt) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await request()
      if (!alive.current) return
      setSent(true); setNow(Date.now()); setRetryAt(Date.now() + result.retryAfterSeconds * 1000)
    } catch (problem) {
      if (!alive.current) return
      if (problem instanceof AccountClientError && ['AUTH_REQUIRED', 'GOOGLE_REQUIRED', 'DEVICE_REVOKED', 'EMPLOYEE_INACTIVE', 'BUSINESS_ACCESS_DENIED'].includes(problem.code)) { onSessionError(problem); return }
      if (problem instanceof AccountClientError && problem.code === 'RECOVERY_LOCKED') { setRetryAt(Date.now() + (problem.retryAfterSeconds ?? 60) * 1000); setNow(Date.now()) }
      setSent(false)
      setError(problem instanceof Error ? problem.message : 'No pudimos enviar el correo. Intenta de nuevo.')
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="screen">
    <button className="back-button" onClick={onBack}><ArrowLeft size={20} aria-hidden="true" />Volver al PIN</button>
    <div className="screen-icon small">{sent ? <Check aria-hidden="true" /> : <Mail aria-hidden="true" />}</div>
    <h1>{sent ? 'Revisa tu correo' : 'Recupera tu PIN'}</h1>
    <p>{sent ? 'Enviamos un enlace para que elijas un nuevo PIN.' : `Te enviaremos un enlace para cambiar tu PIN de ${businessName}.`}</p>
    {email && <p className="recovery-email">{email}</p>}
    <p className="field-help">{sent ? 'Abre el correo de POS México y toca «Elegir nuevo PIN». El enlace vence en 15 minutos.' : 'Al abrir el enlace podrás elegir tu nuevo PIN.'}</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="screen-actions">
      <button className={`button ${sent ? 'secondary' : 'primary'}`} disabled={busy || remaining > 0} aria-busy={busy} onClick={() => void send()}>{busy ? 'Enviando…' : remaining > 0 ? `Reenviar en ${remaining} s` : sent ? 'Reenviar correo' : 'Enviar enlace al correo'}</button>
      {sent && <p className="action-note">Si no llega, revisa la carpeta de spam. Al reenviar, el enlace anterior deja de funcionar.</p>}
    </div>
  </section>
}
