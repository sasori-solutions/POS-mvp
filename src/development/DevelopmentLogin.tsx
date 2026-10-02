import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

// Synthetic credentials for the isolated local stack, never imported by a production build.
export default function DevelopmentLogin() {
  const [email, setEmail] = useState('owner@pos.local.test')
  const [password, setPassword] = useState('Local-POS-only-2026!')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function login(event: FormEvent) {
    event.preventDefault()
    if (!supabase || busy) return
    setBusy(true); setError('')
    try {
      const result = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (result.error || !result.data.session) throw new Error()
      // A fresh document also resets the normal identity cancellation/logout guards.
      window.location.replace(sessionStorage.getItem('pos-mexico-pending-invitation') ? '/join' : '/')
    } catch {
      setError('No pudimos entrar. Revisa la cuenta de prueba y que npm run dev siga activo.')
      setBusy(false)
    }
  }

  return <div className="app-shell"><main className="auth-panel" data-pos-development-login><section className="screen">
    <h1>Acceso de desarrollo</h1>
    <p>Datos ficticios en Supabase local. No necesitas una cuenta de Google.</p>
    <p>El dueño inicial usa el PIN <strong>123456</strong>. Las cuentas nueva y de empleado empiezan sin negocio.</p>
    <form onSubmit={(event) => void login(event)}>
      <div className="field"><label htmlFor="dev-account">Cuenta de prueba</label><select id="dev-account" value={email} onChange={event => setEmail(event.target.value)} disabled={busy}>
        <option value="owner@pos.local.test">Dueño · cafetería de prueba</option>
        <option value="new@pos.local.test">Cuenta nueva · crear negocio</option>
        <option value="employee@pos.local.test">Empleado · aceptar invitación</option>
      </select></div>
      <div className="field"><label htmlFor="dev-password">Contraseña local</label><input id="dev-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy} /></div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <button className="button primary" disabled={busy} aria-busy={busy}>{busy ? 'Entrando…' : 'Entrar en desarrollo'}</button>
    </form>
    <a className="text-button" href="/login">Volver al acceso</a>
  </section></main></div>
}
