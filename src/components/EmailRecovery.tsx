import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, LockKeyhole } from 'lucide-react'
import { recoveryRequest, AccountClientError } from '../lib/account'
import PinField from './PinField'

export default function EmailRecovery() {
  const [token, setToken] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('recovery') ?? ''
    window.history.replaceState({}, '', '/recover-pin')
    return /^[a-f0-9]{64}$/.test(value) ? value : ''
  })
  const [details, setDetails] = useState<{ businessName: string; expiresAt: string } | null>(null)
  const [loading, setLoading] = useState(Boolean(token))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState(!token)
  const operation = useRef(crypto.randomUUID())
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    if (token) void recoveryRequest({ action: 'pin_email_details', recoveryToken: token })
      .then(result => { if (alive.current) setDetails(result) })
      .catch(problem => { if (alive.current) { setError(problem instanceof Error ? problem.message : 'No pudimos revisar el enlace.'); if (problem instanceof AccountClientError && problem.code === 'RECOVERY_INVALID') setInvalid(true) } })
      .finally(() => { if (alive.current) setLoading(false) })
    return () => { alive.current = false }
  }, [])
  async function save(event: FormEvent) {
    event.preventDefault()
    if (pending.current || !details || invalid) return
    if (!/^[0-9]{6}$/.test(pin) || pin !== confirmation) { setError('Escribe y confirma el mismo PIN de 6 dígitos.'); return }
    pending.current = true; setBusy(true); setError('')
    try {
      await recoveryRequest({ action: 'confirm_pin_email', recoveryToken: token, pin, operationId: operation.current })
      if (!alive.current) return
      setToken(''); setPin(''); setConfirmation(''); setDone(true)
      if ('BroadcastChannel' in window) {
        for (const name of ['pos-mexico-session', 'pos-mexico-device-session']) { const channel = new BroadcastChannel(name); channel.postMessage('lock'); channel.close() }
      }
    } catch (problem) {
      if (alive.current) { setError(problem instanceof Error ? problem.message : 'No pudimos guardar el PIN.'); if (problem instanceof AccountClientError && problem.code === 'RECOVERY_INVALID') { setInvalid(true); setPin(''); setConfirmation('') } }
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="app-shell"><header className="app-header"><span className="wordmark">POS México<span className="wordmark-square" aria-hidden="true" /></span></header><main className="auth-panel"><section className="screen">
    {loading ? <p role="status">Revisando enlace…</p> : done ? <>
      <div className="screen-icon small"><Check aria-hidden="true" /></div><h1>PIN actualizado</h1><p>Ya puedes volver a {details?.businessName} y entrar con tu nuevo PIN.</p><p className="field-help">Los accesos que estaban abiertos quedaron bloqueados.</p><a className="button primary" href="/unlock">Volver al negocio</a>
    </> : invalid ? <>
      <h1>Necesitas un nuevo enlace</h1><p>Este enlace venció, ya se utilizó o está incompleto.</p><p>Vuelve a «Olvidé mi PIN» para pedir otro correo. Si recargaste esta página, abre de nuevo el enlace del correo.</p><a className="button primary" href="/unlock">Volver al PIN</a>
    </> : details ? <>
      <div className="screen-icon small"><LockKeyhole aria-hidden="true" /></div><h1>Crea un nuevo PIN</h1><p>Para entrar a {details.businessName}.</p>
      <form onSubmit={event => void save(event)}><p id="pin-help" className="field-help">Elige seis dígitos que puedas recordar.</p><PinField label="Nuevo PIN" value={pin} onChange={value => { setPin(value); setError(''); operation.current = crypto.randomUUID() }} disabled={busy} /><PinField label="Confirma tu PIN" value={confirmation} onChange={value => { setConfirmation(value); setError('') }} confirm disabled={busy} />
      {error && <p className="error-message" role="alert">{error}</p>}<div className="screen-actions"><button className="button primary" disabled={busy} aria-busy={busy}>{busy ? 'Guardando…' : 'Guardar nuevo PIN'}</button><a className="button secondary" href="/unlock">Cancelar</a></div></form>
    </> : <><h1>No pudimos revisar el enlace</h1><p role="alert">{error}</p><button className="button primary" onClick={() => window.location.assign(`/recover-pin#recovery=${token}`)}>Intentar de nuevo</button></>}
  </section></main><footer className="app-footer">POS México</footer></div>
}
