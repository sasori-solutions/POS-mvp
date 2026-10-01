import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ArrowLeft, ArrowRight, Check, ChevronRight, Coffee, LockKeyhole, LogOut, Store } from 'lucide-react'
import { accountRequest, AccountClientError } from './lib/account'
import type { AccountErrorCode, BusinessSummary, BusinessType, OperatorSession } from './lib/contracts'
import { allowIdentitySignIn, closeIdentity, clearStoredIdentity, discardLateIdentity, initializeIdentity, supabase } from './lib/supabase'

type Screen = 'loading' | 'login' | 'business' | 'create-pin' | 'choose' | 'unlock' | 'home' | 'retry'
interface BusinessDraft { name: string; businessType: BusinessType; timezone: string }
const initialDraft: BusinessDraft = { name: '', businessType: 'cafe', timezone: 'America/Mexico_City' }
const accountMessages: Record<AccountErrorCode | 'NETWORK_ERROR', string> = {
  AUTH_REQUIRED: 'Tu sesión venció. Vuelve a entrar con Google.',
  GOOGLE_REQUIRED: 'Entra con tu cuenta de Google para continuar.',
  VALIDATION_ERROR: 'Revisa los datos e intenta de nuevo.',
  BUSINESS_ACCESS_DENIED: 'No tienes acceso a este negocio. Elige otro o vuelve a entrar con Google.',
  PIN_INVALID: 'PIN incorrecto. Intenta de nuevo.',
  PIN_LOCKED: 'Demasiados intentos. Espera antes de volver a ingresar tu PIN.',
  SESSION_INVALID: 'La app está bloqueada. Ingresa tu PIN para continuar.',
  SESSION_EXPIRED: 'Tu sesión de trabajo venció. Ingresa tu PIN para continuar.',
  OPERATION_CONFLICT: 'Esta solicitud cambió. Vuelve a los datos del negocio e intenta de nuevo.',
  ORIGIN_FORBIDDEN: 'Abre el enlace oficial de POS México para entrar.',
  METHOD_NOT_ALLOWED: 'No pudimos completar la solicitud. Intenta de nuevo.',
  PAYLOAD_TOO_LARGE: 'Revisa los datos e intenta de nuevo.',
  SERVER_ERROR: 'No pudimos completar la solicitud. Intenta de nuevo.',
  NETWORK_ERROR: 'No pudimos conectar. Revisa tu conexión e intenta de nuevo.',
}
const timezones = [
  ['America/Mexico_City', 'Ciudad de México'],
  ['America/Cancun', 'Cancún'],
  ['America/Monterrey', 'Monterrey'],
  ['America/Mazatlan', 'Mazatlán'],
  ['America/Hermosillo', 'Hermosillo'],
  ['America/Tijuana', 'Tijuana'],
] as const

function PinField({ label, value, onChange, confirm = false, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void; confirm?: boolean; disabled?: boolean
}) {
  const id = confirm ? 'pin-confirm-input' : 'pin-input'
  return <div className="field pin-field">
    <label htmlFor={id}>{label}</label>
    <div className="pin-control">
      <input id={id} data-testid={id} type="password" inputMode="numeric" pattern="[0-9]*"
        maxLength={6} autoComplete="off" value={value} disabled={disabled}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        aria-describedby="pin-help" />
      <div className="pin-slots" aria-hidden="true">{Array.from({ length: 6 }, (_, index) =>
        <span key={index} className={value.length > index ? 'filled' : ''}>{value.length > index ? '●' : ''}</span>,
      )}</div>
    </div>
  </div>
}

function GoogleMark() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.3c1.9-1.8 3-4.4 3-7.6ZM12 22c2.7 0 4.9-.9 6.6-2.3l-3.3-2.6c-.9.6-2 .9-3.3.9-2.6 0-4.8-1.7-5.6-4H3v2.7A10 10 0 0 0 12 22ZM6.4 14a6 6 0 0 1 0-4V7.3H3a10 10 0 0 0 0 9.4L6.4 14ZM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.3L6.4 10A6 6 0 0 1 12 6Z" /></svg>
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [screen, setScreen] = useState<Screen>('loading')
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([])
  const [selected, setSelected] = useState<BusinessSummary | null>(null)
  const [operator, setOperator] = useState<OperatorSession | null>(null)
  const [draft, setDraft] = useState<BusinessDraft>(initialDraft)
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryAt, setRetryAt] = useState(0)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const operationId = useRef(crypto.randomUUID())
  const operationDraft = useRef<BusinessDraft | null>(null)
  const epoch = useRef(0)
  const endingIdentity = useRef(false)
  const closingPending = useRef(false)
  const channel = useRef<BroadcastChannel | null>(null)
  const operatorRef = useRef(operator)
  const selectedRef = useRef(selected)
  const businessesRef = useRef(businesses)
  const sessionRef = useRef(session)
  operatorRef.current = operator
  selectedRef.current = selected
  businessesRef.current = businesses
  sessionRef.current = session

  function navigate(next: Screen) {
    setScreen(next)
    const path = next === 'login' ? '/login' : next === 'business' || next === 'create-pin' ? '/business/new' : next === 'unlock' ? '/unlock' : '/'
    window.history.replaceState({}, '', path)
  }

  function clearSensitive() {
    setOperator(null)
    setPin('')
    setConfirmation('')
    setRetryAt(0)
    setBusy(false)
  }

  function lockedScreen() {
    const business = operatorRef.current?.business ?? selectedRef.current
    clearSensitive()
    if (!sessionRef.current) navigate('login')
    else if (business) {
      setSelected(business)
      navigate('unlock')
    } else if (businessesRef.current.length) navigate('choose')
    else navigate('business')
  }

  async function expireIdentity(message = 'Tu sesión venció. Vuelve a entrar con Google.') {
    epoch.current += 1
    const requestEpoch = epoch.current
    endingIdentity.current = true
    closingPending.current = true
    const identityClose = closeIdentity(sessionRef.current?.access_token)
    clearSensitive()
    setBusy(true)
    setBusinesses([])
    setSelected(null)
    setDraft(initialDraft)
    operationDraft.current = null
    setSession(null)
    navigate('login')
    setError(message)
    await identityClose
    if (requestEpoch === epoch.current) { closingPending.current = false; setBusy(false) }
  }

  function showFailure(problem: unknown) {
    if (problem instanceof AccountClientError) {
      if (problem.code === 'AUTH_REQUIRED' || problem.code === 'GOOGLE_REQUIRED') {
        void expireIdentity(accountMessages[problem.code])
        return
      }
      if (problem.code === 'SESSION_INVALID' || problem.code === 'SESSION_EXPIRED') lockedScreen()
      if (problem.code === 'PIN_LOCKED') setRetryAt(Date.now() + Math.max(1, problem.retryAfterSeconds ?? 900) * 1_000)
      setError(accountMessages[problem.code] ?? accountMessages.SERVER_ERROR)
      return
    }
    setError('No pudimos completar la solicitud. Intenta de nuevo.')
  }

  async function loadBusinesses() {
    const requestEpoch = epoch.current
    setError('')
    setScreen('loading')
    try {
      const data = await accountRequest({ action: 'status' })
      if (requestEpoch !== epoch.current) return
      setBusinesses(data.businesses)
      if (!data.businesses.length) navigate('business')
      else if (data.businesses.length === 1) {
        setSelected(data.businesses[0])
        navigate('unlock')
      } else navigate('choose')
    } catch (problem) {
      if (requestEpoch !== epoch.current) return
      navigate('retry')
      showFailure(problem)
    }
  }

  useEffect(() => {
    if (!supabase) return
    let alive = true
    const initialEpoch = epoch.current
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, identity) => {
      if (!alive) return
      if (event === 'SIGNED_OUT') {
        if (!endingIdentity.current) epoch.current += 1
        clearSensitive()
        if (closingPending.current) setBusy(true)
        setBusinesses([])
        setSelected(null)
        setDraft(initialDraft)
        operationDraft.current = null
        setSession(null)
        navigate('login')
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        if (endingIdentity.current) {
          clearStoredIdentity()
          if (identity?.access_token) {
            void discardLateIdentity(identity.access_token).then((confirmed) => {
              if (alive && endingIdentity.current && !confirmed) setError('Saliste de este dispositivo. No pudimos confirmar el cierre en el servidor; vuelve a conectar para revocar las sesiones.')
            })
          }
          return
        }
        setSession(identity)
      }
    })
    initializeIdentity().then((identity) => {
      if (alive && !endingIdentity.current && initialEpoch === epoch.current) setSession(identity)
    }).catch((problem: unknown) => {
      if (!alive || endingIdentity.current || initialEpoch !== epoch.current) return
      setSession(null)
      setError(problem instanceof Error ? problem.message : 'Vuelve a entrar con Google.')
    })
    return () => { alive = false; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (session === undefined || !supabase) return
    if (!session) { navigate('login'); return }
    void loadBusinesses()
    // Refreshing the owner's JWT must not silently unlock or replace the operator session.
  }, [session?.user.id, session === undefined])

  useEffect(() => {
    if (!('BroadcastChannel' in window)) return
    const bus = new BroadcastChannel('pos-mexico-session')
    channel.current = bus
    bus.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== 'lock' && event.data !== 'logout') return
      setError('')
      if (event.data === 'logout') void expireIdentity('')
      else if (!endingIdentity.current) { epoch.current += 1; lockedScreen() }
    }
    return () => { bus.close(); channel.current = null }
  }, [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [screen])

  useEffect(() => {
    if (!retryAt) { setSecondsLeft(0); return }
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
      setSecondsLeft(remaining)
      if (!remaining) { setRetryAt(0); setError(''); }
    }
    update()
    const interval = window.setInterval(update, 1_000)
    return () => window.clearInterval(interval)
  }, [retryAt])

  useEffect(() => {
    if (!operator) return
    const remaining = new Date(operator.expiresAt).getTime() - Date.now()
    const timeout = window.setTimeout(() => {
      epoch.current += 1
      lockedScreen()
      setError('Tu sesión de trabajo venció. Ingresa tu PIN para continuar.')
    }, Math.max(0, remaining))
    return () => window.clearTimeout(timeout)
  }, [operator])

  async function googleLogin() {
    if (!supabase) return
    if (busy) return
    allowIdentitySignIn()
    setBusy(true)
    setError('')
    try {
      const { error: problem } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback`, scopes: 'openid email profile', queryParams: { prompt: 'select_account' } },
      })
      if (problem) throw problem
    } catch {
      setError('No pudimos abrir Google. Revisa tu conexión e intenta de nuevo.')
      setBusy(false)
    }
  }

  function nextBusiness(event: FormEvent) {
    event.preventDefault()
    const name = draft.name.trim().replace(/\s+/g, ' ')
    if (Array.from(name).length < 2 || Array.from(name).length > 100) {
      setError('Escribe un nombre de entre 2 y 100 caracteres.')
      return
    }
    setDraft({ ...draft, name })
    setError('')
    setPin('')
    setConfirmation('')
    if (!operationDraft.current || operationDraft.current.name !== name || operationDraft.current.businessType !== draft.businessType || operationDraft.current.timezone !== draft.timezone) {
      operationId.current = crypto.randomUUID()
      operationDraft.current = { ...draft, name }
    }
    navigate('create-pin')
  }

  async function submitPin(event: FormEvent) {
    event.preventDefault()
    if (busy || retryAt > Date.now()) return
    setError('')
    if (!/^\d{6}$/.test(pin)) { setError('Ingresa un PIN de 6 dígitos.'); return }
    if (screen === 'create-pin' && confirmation !== pin) { setError('Los PIN no coinciden. Revísalos e intenta de nuevo.'); return }
    const requestEpoch = epoch.current
    setBusy(true)
    try {
      const data = screen === 'create-pin'
        ? await accountRequest({ action: 'create_business', ...draft, operationId: operationId.current, pin })
        : await accountRequest({ action: 'unlock', businessId: selected!.id, pin })
      if (requestEpoch !== epoch.current) return
      setOperator(data)
      setSelected(data.business)
      setBusinesses((current) => current.some((business) => business.id === data.business.id) ? current : [...current, data.business])
      setPin('')
      setConfirmation('')
      setDraft(initialDraft)
      operationDraft.current = null
      navigate('home')
    } catch (problem) {
      if (requestEpoch === epoch.current) showFailure(problem)
    } finally {
      if (requestEpoch === epoch.current) setBusy(false)
    }
  }

  async function lock() {
    if (!operator || busy) return
    setBusy(true)
    setError('')
    const revocation = accountRequest({ action: 'lock', businessId: operator.business.id, operatorToken: operator.operatorToken }, sessionRef.current?.access_token)
    epoch.current += 1
    const requestEpoch = epoch.current
    lockedScreen()
    setBusy(true)
    channel.current?.postMessage('lock')
    try { await revocation }
    catch (problem) { if (requestEpoch === epoch.current) showFailure(problem) }
    finally { if (requestEpoch === epoch.current) setBusy(false) }
  }

  async function logout() {
    if (busy) return
    const accessToken = sessionRef.current?.access_token
    const revocation = accountRequest({ action: 'revoke_sessions' }, accessToken)
    epoch.current += 1
    const requestEpoch = epoch.current
    endingIdentity.current = true
    closingPending.current = true
    const identityClose = closeIdentity(accessToken)
    clearSensitive()
    setBusy(true)
    setBusinesses([])
    setSelected(null)
    setDraft(initialDraft)
    operationDraft.current = null
    setSession(null)
    navigate('login')
    setError('')
    channel.current?.postMessage('logout')
    const results = await Promise.allSettled([revocation, identityClose])
    if (requestEpoch !== epoch.current) return
    // Revoking the Google-backed Supabase session invalidates its operator tokens
    // even when revoke_sessions races with that revocation and returns AUTH_REQUIRED.
    const identityResult = results[1]
    const failed = identityResult.status === 'rejected' || identityResult.value !== true
    setError(failed ? 'Saliste de este dispositivo. No pudimos confirmar el cierre en el servidor; vuelve a conectar para revocar las sesiones.' : '')
    setBusy(false)
    closingPending.current = false
  }

  const hasIdentity = Boolean(session)
  const createPin = screen === 'create-pin'
  const isHome = screen === 'home' && operator
  const back = () => {
    setError(''); setPin(''); setConfirmation('')
    navigate(createPin ? 'business' : 'choose')
  }

  return <div className={`app-shell ${isHome ? 'home-shell' : ''}`}>
    <header className="app-header"><span className="wordmark">POS México<span className="wordmark-square" aria-hidden="true" /></span>
      {hasIdentity && <button className="header-logout" onClick={() => void logout()} disabled={busy}><LogOut size={18} aria-hidden="true" /><span>Cerrar sesión</span></button>}
    </header>
    <main className={isHome ? 'business-home' : 'auth-panel'}>
      {!supabase ? <section className="screen"><div className="screen-icon"><Store aria-hidden="true" /></div><h1>La app está en preparación</h1><p>Falta conectar el servicio de acceso. Contacta al equipo de POS México para terminar la configuración.</p></section>
      : screen === 'loading' ? <section className="screen loading-screen" aria-live="polite" aria-busy="true"><span className="loader" aria-hidden="true" /><p>Preparando tu acceso…</p></section>
      : screen === 'login' ? <section className="screen login-screen">
        <div className="screen-icon"><Store size={28} strokeWidth={1.5} aria-hidden="true" /></div>
        <h1>Tu negocio,<br />en orden.</h1><p>Entra con Google para crear tu negocio o continuar donde lo dejaste.</p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="screen-actions"><button className="button primary google-button" onClick={() => void googleLogin()} disabled={busy} aria-busy={busy}><GoogleMark /><span>Continuar con Google</span></button><p className="action-note">Después crearás tu PIN de acceso.</p></div>
      </section>
      : screen === 'business' ? <section className="screen">
        <p className="step-label">Tu negocio</p><h1>Vamos a empezar</h1><p>Cuéntanos lo esencial.</p>
        <form onSubmit={nextBusiness}>
          <div className="field"><label htmlFor="business-name">Nombre del negocio</label><input id="business-name" name="businessName" autoComplete="organization" placeholder="Nombre de tu negocio" maxLength={100} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
          <div className="field"><label htmlFor="business-type">Tipo de negocio</label><select id="business-type" value={draft.businessType} onChange={(event) => setDraft({ ...draft, businessType: event.target.value as BusinessType })}><option value="cafe">Cafetería</option><option value="restaurant">Restaurante</option><option value="other">Otro</option></select></div>
          <div className="field"><label htmlFor="business-timezone">Zona horaria</label><select id="business-timezone" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>{timezones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="screen-actions"><button className="button primary" type="submit">Continuar<ArrowRight size={20} aria-hidden="true" /></button></div>
        </form>
      </section>
      : createPin || screen === 'unlock' ? <section className="screen">
        {(createPin || businesses.length > 1) && <button className="back-button" onClick={back} disabled={busy}><ArrowLeft size={20} aria-hidden="true" />Volver</button>}
        <div className="screen-icon small"><LockKeyhole size={24} strokeWidth={1.5} aria-hidden="true" /></div>
        <h1>{createPin ? 'Crea tu PIN' : 'Ingresa tu PIN'}</h1><p>{createPin ? `Para entrar a ${draft.name}.` : selected?.name}</p>
        <form onSubmit={(event) => void submitPin(event)}>
          <p id="pin-help" className="field-help">Usa 6 dígitos.</p>
          <PinField label={createPin ? 'PIN' : 'Tu PIN'} value={pin} onChange={setPin} disabled={busy || secondsLeft > 0} />
          {createPin && <PinField label="Confirma tu PIN" value={confirmation} onChange={setConfirmation} confirm disabled={busy} />}
          {error && <p className="error-message" role="alert">{error}</p>}
          {secondsLeft > 0 && <p className="countdown" role="timer" aria-live="off">Podrás intentar de nuevo en {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.</p>}
          <div className="screen-actions"><button className="button primary" type="submit" disabled={busy || secondsLeft > 0} aria-busy={busy}>{createPin ? 'Crear PIN' : 'Entrar'}<ArrowRight size={20} aria-hidden="true" /></button></div>
        </form>
      </section>
      : screen === 'choose' ? <section className="screen"><h1>Tus negocios</h1><p>Elige dónde quieres entrar.</p><div className="business-list">{businesses.map((business) => <button className="business-choice" key={business.id} onClick={() => { setSelected(business); setError(''); setPin(''); navigate('unlock') }}><span className="business-icon"><Coffee size={22} strokeWidth={1.5} aria-hidden="true" /></span><span>{business.name}</span><ChevronRight size={20} aria-hidden="true" /></button>)}</div><button className="button secondary" onClick={() => { operationId.current = crypto.randomUUID(); setDraft(initialDraft); setError(''); navigate('business') }}>Crear otro negocio</button></section>
      : isHome ? <section className="ready-screen"><div className="ready-mark"><Check size={28} strokeWidth={2} aria-hidden="true" /></div><p className="business-name">{operator.business.name}</p><h1>Tu negocio está listo</h1><p>Ya puedes entrar con tu PIN y bloquear la app cuando termines.</p><dl className="business-details"><div><dt>Tipo de negocio</dt><dd>{{ cafe: 'Cafetería', restaurant: 'Restaurante', other: 'Otro' }[operator.business.businessType]}</dd></div><div><dt>Zona horaria</dt><dd>{timezones.find(([value]) => value === operator.business.timezone)?.[1] ?? operator.business.timezone}</dd></div></dl>{error && <p className="error-message" role="alert">{error}</p>}<div className="home-actions"><button className="button primary" onClick={() => void lock()} disabled={busy}><LockKeyhole size={20} aria-hidden="true" />{busy ? 'Un momento…' : 'Bloquear'}</button></div></section>
      : <section className="screen"><h1>No pudimos cargar tu negocio</h1>{error && <p className="error-message" role="alert">{error}</p>}<div className="screen-actions"><button className="button primary" onClick={() => void loadBusinesses()}>Intentar de nuevo</button></div></section>}
    </main>
    <footer className="app-footer">POS México</footer>
  </div>
}
