import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { ArrowLeft, ArrowRight, Check, ChevronRight, Coffee, LockKeyhole, LogOut, Store } from 'lucide-react'
import { accountRequest, AccountClientError } from './lib/account'
import type { AccountErrorCode, BusinessContext, BusinessProfile, BusinessSummary, BusinessType, InvitationDetails, OperatorSession } from './lib/contracts'
import { allowIdentitySignIn, closeIdentity, hasCurrentStoredIdentity, initializeIdentity, supabase } from './lib/supabase'
import HomeScreen, { type Destination } from './components/HomeScreen'
import EmployeePinSetup from './components/EmployeePinSetup'
const TeamPanel = lazy(() => import('./components/TeamPanel'))
const BusinessSettings = lazy(() => import('./components/BusinessSettings'))
const DeviceLogin = lazy(() => import('./components/DeviceLogin'))
const loadingView = <section className="screen loading-screen" aria-live="polite" aria-busy="true"><span className="loader" aria-hidden="true" /><p>Preparando tu acceso…</p></section>

type Screen = 'loading' | 'login' | 'choice' | 'join' | 'business' | 'create-pin' | 'choose' | 'unlock' | 'ready' | 'home' | 'retry' | 'team' | 'devices' | 'settings' | 'reauth' | 'recover' | 'employee' | 'employee-pin' | 'change-pin' | 'recovery-code' | 'recovery-save'
interface BusinessDraft { name: string; businessType: BusinessType; timezone: string; profile: BusinessProfile }
const initialDraft: BusinessDraft = { name: '', businessType: 'cafe', timezone: 'America/Mexico_City', profile: { branchName: 'Sucursal principal', registerName: 'Caja 1', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash', 'card_external'] } }
const invitationKey = 'pos-mexico-pending-invitation'
const recoveryKey = 'pos-mexico-pin-recovery'
interface RecoveryIntent { businessId: string; expectedUserId: string; startedAt: number; generation: string }
function identitySessionKey(identity: Session | null | undefined) {
  if (!identity) return ''
  try {
    const payload = JSON.parse(atob(identity.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: unknown }
    if (typeof payload.session_id === 'string') return `${identity.user.id}:${payload.session_id}`
  } catch { /* An unfamiliar SDK token is treated as a distinct identity generation. */ }
  return `${identity.user.id}:${identity.access_token}`
}
function readRecoveryIntent(): RecoveryIntent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(recoveryKey) ?? 'null') as RecoveryIntent | null
    if (value && typeof value.businessId === 'string' && typeof value.expectedUserId === 'string' && typeof value.generation === 'string' && Number.isFinite(value.startedAt) && Date.now() - value.startedAt < 10 * 60_000 && value.startedAt <= Date.now() + 30_000) return value
  } catch { /* Malformed or legacy intentions do not authorize PIN recovery. */ }
  sessionStorage.removeItem(recoveryKey)
  return null
}

function entryIntent() {
  const url = new URL(window.location.href)
  const invitation = new URLSearchParams(url.hash.slice(1)).get('invite')
  if (invitation && /^[a-f0-9]{64}$/i.test(invitation)) {
    sessionStorage.setItem(invitationKey, invitation)
    window.history.replaceState({}, '', '/join')
  }
  return { device: url.pathname === '/employee', create: url.pathname === '/business/new', join: url.pathname === '/join' || Boolean(invitation) }
}
const accountMessages: Record<AccountErrorCode | 'NETWORK_ERROR', string> = {
  AUTH_REQUIRED: 'Tu sesión venció. Vuelve a entrar con Google.',
  GOOGLE_REQUIRED: 'Entra con tu cuenta de Google para continuar.',
  VALIDATION_ERROR: 'Revisa los datos e intenta de nuevo.',
  BUSINESS_ACCESS_DENIED: 'No tienes acceso a este negocio. Elige otro o vuelve a entrar con Google.',
  PERMISSION_DENIED: 'Tu rol no permite esta acción. Solicita ayuda al dueño.',
  INVITATION_INVALID: 'La invitación no es válida, venció o fue revocada. Pide una nueva al dueño.',
  PAIRING_INVALID: 'El código de conexión no es válido o venció. Pide uno nuevo al dueño.',
  DEVICE_REVOKED: 'Este dispositivo fue desvinculado. Vuelve a conectarlo con el dueño.',
  REAUTH_REQUIRED: 'Vuelve a verificar tu cuenta con Google para cambiar el PIN.',
  EMPLOYEE_INACTIVE: 'Tu acceso fue desactivado. Contacta al dueño del negocio.',
  PIN_INVALID: 'PIN incorrecto. Intenta de nuevo.',
  PIN_LOCKED: 'Demasiados intentos. Espera antes de volver a ingresar tu PIN.',
  SESSION_INVALID: 'La app está bloqueada. Ingresa tu PIN para continuar.',
  SESSION_EXPIRED: 'Tu sesión de trabajo venció. Ingresa tu PIN para continuar.',
  OPERATION_CONFLICT: 'Esta solicitud cambió. Vuelve a los datos del negocio e intenta de nuevo.',
  ORIGIN_FORBIDDEN: 'Abre el enlace oficial de POS México para entrar.',
  METHOD_NOT_ALLOWED: 'No pudimos completar la solicitud. Intenta de nuevo.',
  PAYLOAD_TOO_LARGE: 'Revisa los datos e intenta de nuevo.',
  SERVER_ERROR: 'No pudimos completar la solicitud. Intenta de nuevo.',
  PIN_SETUP_INVALID: 'El código de autorización no es válido o venció. Pide otro al dueño.',
  PIN_SETUP_ACCOUNT_MISMATCH: 'Entra con la cuenta de Google vinculada a este empleado.',
  RECOVERY_INVALID: 'Revisa tu código de recuperación.',
  RECOVERY_LOCKED: 'Demasiados intentos. Espera antes de volver a intentar.',
  RECOVERY_UNAVAILABLE: 'Aún no hay un código de recuperación. Créalo cuando tengas acceso con tu PIN.',
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
  const [intent] = useState(entryIntent)
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [screen, setScreen] = useState<Screen>(intent.device ? 'employee' : 'loading')
  const [homeDestination, setHomeDestination] = useState<Destination | undefined>()
  const [moreReturn, setMoreReturn] = useState('')
  const [homeNotice, setHomeNotice] = useState('')
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([])
  const [selected, setSelected] = useState<BusinessSummary | null>(null)
  const [operator, setOperator] = useState<OperatorSession | null>(null)
  const [draft, setDraft] = useState<BusinessDraft>(initialDraft)
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [invitationCode, setInvitationCode] = useState(() => sessionStorage.getItem(invitationKey) ?? '')
  const [joinDetails, setJoinDetails] = useState<InvitationDetails | null>(null)
  const [joinLoading, setJoinLoading] = useState(false)
  const [currentPin, setCurrentPin] = useState('')
  const [recoveryInput, setRecoveryInput] = useState('')
  const [savedRecoveryCode, setSavedRecoveryCode] = useState('')
  const [recoveryNext, setRecoveryNext] = useState<'ready' | 'home'>('home')
  const recoveryIntent = useRef<RecoveryIntent | null>(readRecoveryIntent())
  const verifyingRecovery = useRef(false)
  const recoveryOperation = useRef<{ fingerprint: string; id: string } | null>(null)
  const pendingRecoveryCreation = useRef<OperatorSession | null>(null)
  const mutationPending = useRef(false)
  const copiedRecoveryCode = useRef(false)
  const recoveryClipboardGeneration = useRef(0)
  const joinOperationId = useRef(crypto.randomUUID())
  const joinPayload = useRef('')
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
    window.scrollTo(0, 0)
    const path = next === 'login' ? '/login' : next === 'business' || next === 'create-pin' ? '/business/new' : next === 'join' ? '/join' : next === 'employee' ? '/employee' : next === 'unlock' ? '/unlock' : next === 'ready' ? '/business/ready' : '/'
    window.history.replaceState({}, '', path)
  }

  function clearRecoveryIntent() {
    recoveryIntent.current = null
    verifyingRecovery.current = false
    sessionStorage.removeItem(recoveryKey)
  }

  function recoveryOperationId(payload: unknown) {
    const fingerprint = JSON.stringify(payload)
    if (recoveryOperation.current?.fingerprint !== fingerprint) recoveryOperation.current = { fingerprint, id: crypto.randomUUID() }
    return recoveryOperation.current.id
  }

  function clearSensitive(preserveRecoveryIntent = false) {
    clearRecoveryClipboard()
    operatorRef.current = null
    setOperator(null)
    setHomeDestination(undefined)
    setMoreReturn('')
    setHomeNotice('')
    setPin('')
    setConfirmation('')
    setCurrentPin(''); setRecoveryInput(''); setSavedRecoveryCode(''); setJoinDetails(null)
    pendingRecoveryCreation.current = null
    recoveryOperation.current = null
    mutationPending.current = false
    if (!preserveRecoveryIntent) clearRecoveryIntent()
    joinPayload.current = ''
    joinOperationId.current = crypto.randomUUID()
    setRetryAt(0)
    setBusy(false)
  }

  function clearRecoveryClipboard() {
    recoveryClipboardGeneration.current += 1
    if (!copiedRecoveryCode.current) return
    copiedRecoveryCode.current = false
    void navigator.clipboard?.writeText('').catch(() => undefined)
  }

  async function copyRecoveryCode() {
    const requestEpoch = epoch.current
    const clipboardGeneration = recoveryClipboardGeneration.current
    try {
      await navigator.clipboard.writeText(savedRecoveryCode)
      if (requestEpoch !== epoch.current || clipboardGeneration !== recoveryClipboardGeneration.current) { await navigator.clipboard.writeText('').catch(() => undefined); return }
      copiedRecoveryCode.current = true
    } catch { if (requestEpoch === epoch.current) setError('No pudimos copiar. Selecciona el código para guardarlo.') }
  }

  function lockedScreen() {
    const business = operatorRef.current?.business ?? selectedRef.current
    clearSensitive()
    if (!sessionRef.current) navigate('login')
    else if (business) {
      const summary = businessesRef.current.find((entry) => entry.id === business.id)
      setSelected({ ...business, canRecoverPin: 'role' in business ? business.role === 'owner' : summary?.canRecoverPin, recoveryReady: summary?.recoveryReady ?? business.recoveryReady })
      navigate('unlock')
    } else if (businessesRef.current.length) navigate('choose')
    else navigate('choice')
  }

  function summaryForContext(business: BusinessContext): BusinessSummary {
    const previous = businessesRef.current.find((entry) => entry.id === business.id)
      ?? (selectedRef.current?.id === business.id ? selectedRef.current : null)
    return { ...business, canRecoverPin: business.role === 'owner', recoveryReady: business.recoveryReady ?? previous?.recoveryReady }
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
    const confirmed = await identityClose
    if (requestEpoch === epoch.current) {
      if (!confirmed) setError('Saliste de este dispositivo. No pudimos confirmar el cierre en el servidor; vuelve a conectar para revocar las sesiones.')
      closingPending.current = false
      setBusy(false)
    }
  }

  function showFailure(problem: unknown) {
    if (problem instanceof AccountClientError) {
      if (problem.code === 'AUTH_REQUIRED' || problem.code === 'GOOGLE_REQUIRED') {
        void expireIdentity(accountMessages[problem.code])
        return
      }
      if (['SESSION_INVALID', 'SESSION_EXPIRED', 'EMPLOYEE_INACTIVE', 'BUSINESS_ACCESS_DENIED'].includes(problem.code)) lockedScreen()
      if (problem.code === 'PIN_LOCKED' || problem.code === 'RECOVERY_LOCKED') setRetryAt(Date.now() + Math.max(1, problem.retryAfterSeconds ?? 900) * 1_000)
      setError(accountMessages[problem.code] ?? accountMessages.SERVER_ERROR)
      return
    }
    setError('No pudimos completar la solicitud. Intenta de nuevo.')
  }

  async function loadBusinesses() {
    const requestEpoch = epoch.current
    const identity = sessionRef.current
    if (!identity) return
    setError('')
    setScreen('loading')
    try {
      const data = await accountRequest({ action: 'status' }, identity.access_token)
      if (requestEpoch !== epoch.current) return
      setBusinesses(data.businesses)
      const recovering = recoveryIntent.current
      const recoveryBusiness = data.businesses.find((business) => business.id === recovering?.businessId && business.canRecoverPin === true && business.recoveryReady === true)
      if (recovering && recovering.expectedUserId !== identity.user.id) {
        clearRecoveryIntent(); setPin(''); setConfirmation(''); navigate(data.businesses.length ? 'choose' : 'choice')
        setError('Vuelve a verificar con la misma cuenta de Google con la que comenzaste la recuperación.')
      } else if (recovering && recoveryBusiness) { setSelected(recoveryBusiness); navigate('recover') }
      else if (recovering) {
        clearRecoveryIntent(); navigate(data.businesses.length ? 'choose' : 'choice')
        setError('Esta cuenta no puede recuperar el PIN de ese negocio. Necesitas su código de recuperación vigente.')
      } else if (sessionStorage.getItem(invitationKey) || intent.join) navigate('join')
      else if (intent.create) navigate('business')
      else if (!data.businesses.length) navigate('choice')
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
    if (!supabase || intent.device) return
    let alive = true
    const initialEpoch = epoch.current
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, identity) => {
      if (!alive) return
      if (event === 'SIGNED_OUT') {
        if (!endingIdentity.current && hasCurrentStoredIdentity()) return
        if (!endingIdentity.current) epoch.current += 1
        clearSensitive(verifyingRecovery.current)
        if (closingPending.current) setBusy(true)
        setBusinesses([])
        setSelected(null)
        setDraft(initialDraft)
        operationDraft.current = null
        sessionRef.current = null
        setSession(null)
        navigate('login')
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        // SDK broadcasts can belong to a newer login in another document.
        // Cancelled requests are revoked by this document's generation guard.
        if (endingIdentity.current || !identity || !hasCurrentStoredIdentity(identity.access_token)) return
        if (sessionRef.current && identitySessionKey(sessionRef.current) !== identitySessionKey(identity)) { epoch.current += 1; clearSensitive(); setSelected(null); setBusinesses([]) }
        sessionRef.current = identity
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
    if (session === undefined || !supabase || intent.device) return
    if (!session) { navigate('login'); return }
    void loadBusinesses()
    // Refreshing the owner's JWT must not silently unlock or replace the operator session.
  }, [identitySessionKey(session), session === undefined])

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

  useEffect(() => {
    if (!operator) return
    const current = operator
    const requestEpoch = epoch.current
    let alive = true
    let pending = false
    async function checkAccess() {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        const data = await accountRequest({ action: 'context', businessId: current.business.id, operatorToken: current.operatorToken })
        if (alive && requestEpoch === epoch.current) setOperator((latest) => latest?.operatorToken === current.operatorToken ? { ...latest, business: data.business, expiresAt: data.expiresAt } : latest)
      } catch (problem) { if (alive && requestEpoch === epoch.current) showFailure(problem) }
      finally { pending = false }
    }
    const timer = window.setInterval(() => void checkAccess(), 30_000)
    const onVisible = () => { if (document.visibilityState === 'visible') void checkAccess() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [operator?.operatorToken])

  useEffect(() => {
    if (!operator) return
    let timer: number
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { void lock() }, 15 * 60_000)
    }
    reset()
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    for (const event of events) window.addEventListener(event, reset, { passive: true })
    return () => { window.clearTimeout(timer); for (const event of events) window.removeEventListener(event, reset) }
  }, [operator?.operatorToken])

  useEffect(() => {
    setJoinDetails(null)
    if (screen !== 'join' || !/^[a-f0-9]{64}$/i.test(invitationCode.trim()) || !sessionRef.current) { setJoinLoading(false); return }
    const identity = sessionRef.current
    const requestEpoch = epoch.current
    let alive = true
    setJoinLoading(true); setPin(''); setConfirmation(''); setError('')
    void accountRequest({ action: 'invitation_details', invitationCode: invitationCode.trim() }, identity.access_token)
      .then((result) => { if (alive && requestEpoch === epoch.current && identitySessionKey(sessionRef.current) === identitySessionKey(identity)) setJoinDetails(result) })
      .catch((problem) => { if (alive && requestEpoch === epoch.current) showFailure(problem) })
      .finally(() => { if (alive && requestEpoch === epoch.current) setJoinLoading(false) })
    return () => { alive = false }
  }, [screen === 'join', invitationCode, identitySessionKey(session)])

  async function googleLogin(reverify = false) {
    if (!supabase) return
    if (busy) return
    const requestEpoch = reverify ? ++epoch.current : epoch.current
    if (reverify) {
      verifyingRecovery.current = true
      endingIdentity.current = true
      closingPending.current = true
    }
    allowIdentitySignIn()
    setBusy(true)
    setError('')
    try {
      if (reverify) {
        const closed = await closeIdentity(sessionRef.current?.access_token)
        if (requestEpoch !== epoch.current) return
        clearSensitive(true)
        setSession(null)
        setBusy(true)
        closingPending.current = false
        if (!closed) throw new Error('Identity revocation was not confirmed')
        allowIdentitySignIn()
      }
      if (requestEpoch !== epoch.current) return
      const { error: problem } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/auth/callback`, scopes: 'openid email profile', queryParams: { prompt: 'select_account' } },
      })
      if (problem) throw problem
    } catch {
      if (requestEpoch !== epoch.current) return
      closingPending.current = false
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
    const profile = { ...draft.profile, branchName: draft.profile.branchName.trim(), registerName: draft.profile.registerName.trim(),
      address: draft.profile.address.trim(), city: draft.profile.city.trim(), state: draft.profile.state.trim(), contactPhone: draft.profile.contactPhone.trim() }
    if (!profile.branchName || !profile.registerName) { setError('Escribe el nombre de la sucursal y la caja.'); return }
    if (!profile.paymentMethods.length) { setError('Elige al menos un método de pago.'); return }
    if (profile.contactPhone && !/^[+0-9() -]{5,30}$/.test(profile.contactPhone)) { setError('Revisa el teléfono del negocio. Usa números y, si hace falta, el código de país.'); return }
    const nextDraft = { ...draft, name, profile }
    setDraft(nextDraft)
    setError('')
    setPin('')
    setConfirmation('')
    if (!operationDraft.current || JSON.stringify(operationDraft.current) !== JSON.stringify(nextDraft)) {
      operationId.current = crypto.randomUUID()
      operationDraft.current = nextDraft
    }
    navigate('create-pin')
  }

  async function joinBusiness(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!/^[a-f0-9]{64}$/i.test(invitationCode.trim())) { setError('Revisa el código de invitación.'); return }
    if (!joinDetails || !/^[0-9]{6}$/.test(pin) || !joinDetails.employee.pinReady && pin !== confirmation) { setError(joinDetails?.employee.pinReady ? 'Escribe tu PIN actual de seis dígitos.' : 'Escribe y confirma el mismo PIN de 6 dígitos.'); return }
    const requestEpoch = epoch.current
    const identity = sessionRef.current
    if (!identity) return
    const payload = JSON.stringify({ invitationCode: invitationCode.trim(), pin })
    if (joinPayload.current !== payload) { joinOperationId.current = crypto.randomUUID(); joinPayload.current = payload }
    setBusy(true); setError('')
    try {
      const data = await accountRequest({ action: 'accept_invitation', invitationCode: invitationCode.trim(), pin, operationId: joinOperationId.current }, identity.access_token)
      if (requestEpoch !== epoch.current || identitySessionKey(sessionRef.current) !== identitySessionKey(identity)) {
        await accountRequest({ action: 'lock', businessId: data.business.id, operatorToken: data.operatorToken }, identity.access_token).catch(() => undefined)
        return
      }
      sessionStorage.removeItem(invitationKey)
      setOperator(data); setSelected(summaryForContext(data.business))
      setBusinesses((current) => current.some((business) => business.id === data.business.id) ? current : [...current, data.business])
      setPin(''); setConfirmation(''); setInvitationCode(''); navigate('home')
      joinPayload.current = ''
    } catch (problem) { if (requestEpoch === epoch.current) showFailure(problem) }
    finally { if (requestEpoch === epoch.current) setBusy(false) }
  }

  async function recoverPin(event: FormEvent) {
    event.preventDefault()
    const intent = recoveryIntent.current
    const identity = sessionRef.current
    if (busy || mutationPending.current || retryAt > Date.now() || !selected || !intent || !identity) return
    if (intent.expectedUserId !== identity.user.id || intent.businessId !== selected.id) { clearSensitive(); navigate('choose'); setError('Vuelve a verificar con la misma cuenta de Google.'); return }
    if (!/^[a-f0-9]{64}$/i.test(recoveryInput.trim())) { setError('Necesitas tu código de recuperación vigente. Google por sí solo no cambia el PIN.'); return }
    if (!/^[0-9]{6}$/.test(pin) || pin !== confirmation) { setError('Escribe y confirma el mismo PIN de 6 dígitos.'); return }
    const requestEpoch = epoch.current
    const intentGeneration = intent.generation
    mutationPending.current = true
    setBusy(true); setError('')
    try {
      const payload = { action: 'reset_pin' as const, businessId: selected.id, recoveryCode: recoveryInput.trim(), pin }
      const data = await accountRequest({ ...payload, operationId: recoveryOperationId(payload) }, identity.access_token)
      if (requestEpoch !== epoch.current || identitySessionKey(sessionRef.current) !== identitySessionKey(identity) || recoveryIntent.current?.generation !== intentGeneration) {
        await accountRequest({ action: 'lock', businessId: data.business.id, operatorToken: data.operatorToken }, identity.access_token).catch(() => undefined)
        return
      }
      clearRecoveryIntent()
      setOperator(data); setSelected(summaryForContext(data.business)); setPin(''); setConfirmation(''); setRecoveryInput('')
      setSavedRecoveryCode(data.recoveryCode); setRecoveryNext('home'); navigate('recovery-save')
    } catch (problem) { if (requestEpoch === epoch.current) showFailure(problem) }
    finally { if (requestEpoch === epoch.current) { mutationPending.current = false; setBusy(false) } }
  }

  function beginRecoveryVerification() {
    const identity = sessionRef.current
    if (!selected || !identity || selected.canRecoverPin !== true || selected.recoveryReady !== true) return
    const intent = { businessId: selected.id, expectedUserId: identity.user.id, startedAt: Date.now(), generation: crypto.randomUUID() }
    recoveryIntent.current = intent
    sessionStorage.setItem(recoveryKey, JSON.stringify(intent))
    void googleLogin(true)
  }

  async function generateRecoveryCode(event?: FormEvent, creation = false) {
    event?.preventDefault()
    const current = pendingRecoveryCreation.current ?? operatorRef.current
    const identity = sessionRef.current
    if (retryAt > Date.now()) return
    if (!current || !identity || mutationPending.current || busy || !/^[0-9]{6}$/.test(currentPin)) { if (!busy) setError('Escribe tu PIN actual de seis dígitos.'); return }
    const requestEpoch = epoch.current
    mutationPending.current = true
    setBusy(true); setError('')
    try {
      const payload = { action: 'create_recovery_code' as const, businessId: current.business.id, operatorToken: current.operatorToken, currentPin }
      const result = await accountRequest({ ...payload, operationId: recoveryOperationId(payload) }, identity.access_token)
      if (requestEpoch !== epoch.current || identitySessionKey(sessionRef.current) !== identitySessionKey(identity)) return
      setSavedRecoveryCode(result.recoveryCode); setCurrentPin(''); pendingRecoveryCreation.current = null
      setBusinesses((entries) => entries.map((entry) => entry.id === current.business.id ? { ...entry, canRecoverPin: true, recoveryReady: true } : entry))
      setRecoveryNext(creation ? 'ready' : 'home'); navigate('recovery-save')
    } catch (problem) { if (requestEpoch === epoch.current) showFailure(problem) }
    finally { if (requestEpoch === epoch.current) { mutationPending.current = false; setBusy(false) } }
  }

  async function saveChangedPin(event: FormEvent) {
    event.preventDefault()
    const current = operatorRef.current
    const identity = sessionRef.current
    if (!current || !identity || busy || mutationPending.current || retryAt > Date.now()) return
    if (!/^[0-9]{6}$/.test(currentPin) || !/^[0-9]{6}$/.test(pin) || pin !== confirmation) { setError('Escribe el PIN actual y confirma el nuevo PIN de seis dígitos.'); return }
    const requestEpoch = epoch.current
    mutationPending.current = true
    setBusy(true); setError('')
    try {
      const payload = { action: 'change_pin' as const, businessId: current.business.id, operatorToken: current.operatorToken, currentPin, pin }
      const data = await accountRequest({ ...payload, operationId: recoveryOperationId(payload) }, identity.access_token)
      if (requestEpoch !== epoch.current || identitySessionKey(sessionRef.current) !== identitySessionKey(identity)) {
        await accountRequest({ action: 'lock', businessId: data.business.id, operatorToken: data.operatorToken }, identity.access_token).catch(() => undefined)
        return
      }
      setOperator(data); setSelected(summaryForContext(data.business)); setPin(''); setConfirmation(''); setCurrentPin(''); recoveryOperation.current = null; setHomeNotice('PIN actualizado.'); navigate('home')
    } catch (problem) { if (requestEpoch === epoch.current) showFailure(problem) }
    finally { if (requestEpoch === epoch.current) { mutationPending.current = false; setBusy(false) } }
  }

  function changeBusiness() {
    if (operatorRef.current) { void switchBusiness(); return }
    clearSensitive(); setError(''); navigate('choose')
  }

  async function switchBusiness() {
    const current = operatorRef.current
    if (!current || busy) return
    const requestEpoch = ++epoch.current
    clearSensitive(); setBusy(true); setError(''); navigate('choose')
    channel.current?.postMessage('lock')
    try { await accountRequest({ action: 'lock', businessId: current.business.id, operatorToken: current.operatorToken }) }
    catch (problem) { if (requestEpoch === epoch.current) showFailure(problem) }
    finally { if (requestEpoch === epoch.current) setBusy(false) }
  }

  function savedBusiness(business: BusinessContext) {
    if (!operatorRef.current || operatorRef.current.business.id !== business.id || endingIdentity.current) return
    setOperator((current) => current ? { ...current, business } : current)
    const summary = summaryForContext(business)
    setSelected(summary)
    setBusinesses((current) => current.map((entry) => entry.id === business.id ? summary : entry))
  }

  async function submitPin(event: FormEvent) {
    event.preventDefault()
    if (busy || retryAt > Date.now()) return
    setError('')
    if (!/^\d{6}$/.test(pin)) { setError('Ingresa un PIN de 6 dígitos.'); return }
    if (screen === 'create-pin' && confirmation !== pin) { setError('Los PIN no coinciden. Revísalos e intenta de nuevo.'); return }
    const requestEpoch = epoch.current
    const creatingBusiness = screen === 'create-pin'
    const identity = sessionRef.current
    if (!identity) return
    setBusy(true)
    try {
      const data = creatingBusiness
        ? await accountRequest({ action: 'create_business', ...draft, operationId: operationId.current, pin }, identity.access_token)
        : await accountRequest({ action: 'unlock', businessId: selected!.id, pin }, identity.access_token)
      if (requestEpoch !== epoch.current || identitySessionKey(sessionRef.current) !== identitySessionKey(identity)) {
        await accountRequest({ action: 'lock', businessId: data.business.id, operatorToken: data.operatorToken }, identity.access_token).catch(() => undefined)
        return
      }
      setOperator(data)
      setSelected(summaryForContext(data.business))
      setBusinesses((current) => current.some((business) => business.id === data.business.id) ? current : [...current, data.business])
      setPin('')
      setConfirmation('')
      setDraft(initialDraft)
      operationDraft.current = null
      if (creatingBusiness) {
        pendingRecoveryCreation.current = data
        setCurrentPin(pin)
        try {
          const payload = { action: 'create_recovery_code' as const, businessId: data.business.id, operatorToken: data.operatorToken, currentPin: pin }
          const result = await accountRequest({ ...payload, operationId: recoveryOperationId(payload) }, identity.access_token)
          if (requestEpoch !== epoch.current || identitySessionKey(sessionRef.current) !== identitySessionKey(identity)) return
          pendingRecoveryCreation.current = null; setCurrentPin(''); setSavedRecoveryCode(result.recoveryCode)
          setSelected({ ...data.business, canRecoverPin: true, recoveryReady: true }); setBusinesses((entries) => entries.map((entry) => entry.id === data.business.id ? { ...entry, canRecoverPin: true, recoveryReady: true } : entry))
          setRecoveryNext('ready'); navigate('recovery-save')
        } catch (problem) { if (requestEpoch === epoch.current) { navigate('recovery-code'); showFailure(problem) } }
      } else navigate('home')
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

  function openMoreScreen(next: Screen, focus: string) {
    setHomeNotice('')
    setMoreReturn(focus)
    navigate(next)
  }

  function changePin() {
    if (!operatorRef.current || busy) return
    setCurrentPin(''); setPin(''); setConfirmation(''); setError(''); recoveryOperation.current = null
    openMoreScreen('change-pin', 'pin')
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
  const isManagement = ['settings', 'team', 'devices'].includes(screen)
  const isHome = screen === 'home' && Boolean(operator)
  const isReady = screen === 'ready' && Boolean(operator)
  const back = () => {
    setError(''); setPin(''); setConfirmation('')
    navigate(createPin ? 'business' : 'choose')
  }

  if (intent.device || screen === 'employee') return <Suspense fallback={loadingView}><DeviceLogin onExit={() => window.location.assign('/login')} /></Suspense>

  const profileField = (key: keyof Omit<BusinessProfile, 'paymentMethods'>, label: string, required = false) => <div className="field"><label htmlFor={`profile-${key}`}>{label}</label><input id={`profile-${key}`} value={draft.profile[key]} required={required} maxLength={key === 'address' ? 300 : key === 'contactPhone' ? 30 : 100} onChange={(event) => setDraft({ ...draft, profile: { ...draft.profile, [key]: event.target.value } })} /></div>

  return <div className={`app-shell ${isHome ? 'pos-shell' : isReady ? 'home-shell' : ''}`}>
    {!isHome && <header className="app-header"><span className="wordmark">POS México<span className="wordmark-square" aria-hidden="true" /></span>
      {hasIdentity && <button className="header-logout" onClick={() => void logout()} disabled={busy}><LogOut size={18} aria-hidden="true" /><span>Cerrar sesión</span></button>}
    </header>}
    <main className={isHome ? 'pos-home' : isReady ? 'business-home' : isManagement ? 'management-main' : 'auth-panel'}>
      <Suspense fallback={loadingView}>
      {!supabase ? <section className="screen"><div className="screen-icon"><Store aria-hidden="true" /></div><h1>La app está en preparación</h1><p>Falta conectar el servicio de acceso. Contacta al equipo de POS México para terminar la configuración.</p></section>
      : screen === 'loading' ? <section className="screen loading-screen" aria-live="polite" aria-busy="true"><span className="loader" aria-hidden="true" /><p>Preparando tu acceso…</p></section>
      : screen === 'login' ? <section className="screen login-screen">
        <div className="screen-icon"><Store size={28} strokeWidth={1.5} aria-hidden="true" /></div>
        <h1>{invitationCode ? 'Acepta tu invitación' : <>Tu negocio,<br />en orden.</>}</h1><p>{invitationCode ? 'Entra con tu cuenta de Google. Usarás un PIN personal para acceder al negocio.' : 'Entra con Google para crear tu negocio o continuar donde lo dejaste.'}</p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="screen-actions"><button className="button primary google-button" onClick={() => void googleLogin()} disabled={busy} aria-busy={busy}><GoogleMark /><span>Continuar con Google</span></button>{!invitationCode && <><button className="button secondary" disabled={busy} onClick={() => window.location.assign('/employee')}>Entrar como empleado</button><p className="action-note">Google para tu cuenta. PIN para una caja conectada.</p></>}</div>
      </section>
      : screen === 'choice' ? <section className="screen"><h1>¿Qué quieres hacer?</h1><p>Crea tu negocio o entra con una invitación.</p>{error && <p className="error-message" role="alert">{error}</p>}<div className="screen-actions"><button className="button primary" onClick={() => { setError(''); setDraft(initialDraft); navigate('business') }}>Crear mi negocio<ArrowRight size={20} /></button><button className="button secondary" onClick={() => { setError(''); navigate('join') }}>Unirme a un negocio</button></div></section>
      : screen === 'join' ? <section className="screen"><button className="back-button" disabled={busy} onClick={() => { clearSensitive(); setError(''); navigate(businesses.length ? 'choose' : 'choice') }}><ArrowLeft size={20} />Volver</button><h1>Unirme a un negocio</h1><p>{joinDetails ? `Invitación para ${joinDetails.employee.name} en ${joinDetails.business.name}.` : 'Abre el enlace que te compartió el dueño o ingresa tu código.'}</p><form onSubmit={(event) => void joinBusiness(event)}>{!joinDetails && <div className="field"><label htmlFor="invitation-code">Código de invitación</label><input id="invitation-code" required disabled={busy} autoComplete="off" maxLength={64} value={invitationCode} onChange={(event) => { setInvitationCode(event.target.value); joinOperationId.current = crypto.randomUUID() }} /></div>}{joinLoading && <p role="status">Revisando invitación…</p>}{joinDetails && <><p id="pin-help" className="field-help">{joinDetails.employee.pinReady ? 'Verifica el PIN que ya usas en la caja. Conservarás el mismo.' : 'Elige tu PIN personal de seis dígitos.'}</p><PinField label={joinDetails.employee.pinReady ? 'PIN actual' : 'PIN'} value={pin} onChange={setPin} disabled={busy} />{!joinDetails.employee.pinReady && <PinField label="Confirma tu PIN" value={confirmation} onChange={setConfirmation} confirm disabled={busy} />}</>}{error && <p className="error-message" role="alert">{error}</p>}<div className="screen-actions"><button className="button primary" disabled={busy || !joinDetails}>Unirme</button></div></form></section>
      : screen === 'employee-pin' ? <EmployeePinSetup accessToken={session?.access_token} onBack={() => { epoch.current += 1; navigate('unlock') }} onDone={(data) => { setOperator(data); setSelected(summaryForContext(data.business)); navigate('home') }} />
      : screen === 'reauth' ? <section className="screen"><h1>Recupera tu PIN</h1><p>{selected?.recoveryReady ? `Necesitarás el código de recuperación que guardaste fuera de este navegador y verificar la misma cuenta de Google de ${selected.name}.` : 'Aún no hay un código de recuperación. Cuando entres con tu PIN, podrás generarlo desde Más. Google por sí solo no restablece el PIN.'}</p>{error && <p className="error-message" role="alert">{error}</p>}<div className="screen-actions">{selected?.recoveryReady && <button className="button primary" disabled={busy} onClick={beginRecoveryVerification}>Volver a verificar con Google</button>}<button className="button secondary" disabled={busy} onClick={() => { clearRecoveryIntent(); navigate('unlock') }}>Volver</button></div></section>
      : screen === 'recover' ? <section className="screen"><h1>Crea un nuevo PIN</h1><p>Para {selected?.name}. Necesitas tu código de recuperación; Google por sí solo no cambia el PIN.</p><form onSubmit={(event) => void recoverPin(event)}><div className="field"><label htmlFor="owner-recovery-input">Código de recuperación</label><input id="owner-recovery-input" type="password" value={recoveryInput} onChange={(event) => setRecoveryInput(event.target.value.trim())} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} disabled={busy} required /></div><p id="pin-help" className="field-help">Usa seis dígitos.</p><PinField label="PIN" value={pin} onChange={setPin} disabled={busy} /><PinField label="Confirma tu PIN" value={confirmation} onChange={setConfirmation} confirm disabled={busy} />{error && <p className="error-message" role="alert">{error}</p>}{secondsLeft > 0 && <p role="status">Vuelve a intentar en {Math.ceil(secondsLeft / 60)} min.</p>}<div className="screen-actions"><button className="button primary" disabled={busy || secondsLeft > 0}>Guardar nuevo PIN</button>{error === accountMessages.REAUTH_REQUIRED && <button type="button" className="button secondary" disabled={busy} onClick={() => navigate('reauth')}>Volver a verificar con Google</button>}<button type="button" className="button secondary" disabled={busy} onClick={() => { clearSensitive(); navigate('unlock') }}>Cancelar</button></div></form></section>
      : screen === 'change-pin' && operator ? <section className="screen"><button type="button" className="back-button" disabled={busy} onClick={() => { setCurrentPin(''); setPin(''); setConfirmation(''); setError(''); navigate('home') }}><ArrowLeft size={18} aria-hidden="true" />Volver a Más</button><h1>Cambiar mi PIN</h1><p>Verifica tu PIN actual y elige el nuevo.</p><form onSubmit={(event) => void saveChangedPin(event)}><div className="field"><label htmlFor="current-pin">PIN actual</label><input id="current-pin" type="password" inputMode="numeric" autoComplete="off" value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} maxLength={6} disabled={busy} required /></div><p id="pin-help" className="field-help">Usa seis dígitos.</p><PinField label="Nuevo PIN" value={pin} onChange={setPin} disabled={busy} /><PinField label="Confirma tu PIN" value={confirmation} onChange={setConfirmation} confirm disabled={busy} />{error && <p className="error-message" role="alert">{error}</p>}{secondsLeft > 0 && <p role="status">Vuelve a intentar en {Math.ceil(secondsLeft / 60)} min.</p>}<div className="screen-actions"><button className="button primary" disabled={busy || secondsLeft > 0}>Guardar nuevo PIN</button></div></form></section>
      : screen === 'recovery-code' && operator ? <section className="screen">{!pendingRecoveryCreation.current && <button type="button" className="back-button" disabled={busy} onClick={() => { setCurrentPin(''); setError(''); navigate('home') }}><ArrowLeft size={18} aria-hidden="true" />Volver a Más</button>}<h1>Código de recuperación</h1><p>{pendingRecoveryCreation.current ? 'Tu negocio ya está creado. Falta generar el código para recuperar tu PIN.' : 'Te permite crear un PIN nuevo si olvidas el actual. También necesitarás tu cuenta de Google.'}</p><p className="recovery-explanation">Guárdalo fuera de esta caja, en papel o en otro dispositivo. Si generas otro código, el anterior dejará de funcionar.</p><form onSubmit={(event) => void generateRecoveryCode(event, Boolean(pendingRecoveryCreation.current))}><div className="field"><label htmlFor="recovery-current-pin">PIN actual</label><input id="recovery-current-pin" type="password" inputMode="numeric" autoComplete="off" value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} maxLength={6} disabled={busy} required /></div>{error && <p className="error-message" role="alert">{error}</p>}{secondsLeft > 0 && <p role="status">Vuelve a intentar en {Math.ceil(secondsLeft / 60)} min.</p>}<div className="screen-actions"><button className="button primary" disabled={busy || secondsLeft > 0}>Generar código de recuperación</button>{pendingRecoveryCreation.current && <button type="button" className="button secondary" disabled={busy} onClick={() => void lock()}>Cancelar</button>}</div></form></section>
      : screen === 'recovery-save' && operator ? <section className="screen"><h1>Guarda tu código de recuperación</h1><p>Con este código y tu Google podrás recuperar el PIN. Guárdalo en otro dispositivo o en papel, no en esta caja. No se podrá consultar después.</p><div className="field"><label htmlFor="recovery-code-saved">Código de recuperación</label><input id="recovery-code-saved" readOnly value={savedRecoveryCode} autoComplete="off" onFocus={(event) => event.target.select()} /></div>{error && <p className="error-message" role="alert">{error}</p>}<div className="screen-actions"><button className="button secondary" onClick={() => void copyRecoveryCode()}>Copiar código</button><button className="button primary" onClick={() => { clearRecoveryClipboard(); setSavedRecoveryCode(''); recoveryOperation.current = null; navigate(recoveryNext) }}>Ya guardé mi código</button></div></section>
      : screen === 'business' ? <section className="screen">
        <p className="step-label">Tu negocio</p><h1>Vamos a empezar</h1><p>Cuéntanos lo esencial.</p>
        <form onSubmit={nextBusiness}>
          <div className="field"><label htmlFor="business-name">Nombre del negocio</label><input id="business-name" name="businessName" autoComplete="organization" placeholder="Nombre de tu negocio" maxLength={100} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
          <div className="field"><label htmlFor="business-type">Tipo de negocio</label><select id="business-type" value={draft.businessType} onChange={(event) => setDraft({ ...draft, businessType: event.target.value as BusinessType })}><option value="cafe">Cafetería</option><option value="restaurant">Restaurante</option><option value="other">Otro</option></select></div>
          <div className="field"><label htmlFor="business-timezone">Zona horaria</label><select id="business-timezone" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>{timezones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          {profileField('branchName', 'Sucursal', true)}
          {profileField('registerName', 'Caja', true)}
          <details><summary>Dirección y contacto (opcional)</summary><div className="profile-extra">{profileField('address', 'Dirección')}{profileField('city', 'Ciudad')}{profileField('state', 'Estado')}{profileField('contactPhone', 'Teléfono público')}</div></details>
          <fieldset className="payment-options"><legend>Métodos de pago</legend>{([['cash', 'Efectivo'], ['card_external', 'Tarjeta en terminal externa'], ['transfer', 'Transferencia']] as const).map(([method, label]) => <label key={method}><input type="checkbox" checked={draft.profile.paymentMethods.includes(method)} onChange={(event) => setDraft({ ...draft, profile: { ...draft.profile, paymentMethods: event.target.checked ? [...draft.profile.paymentMethods, method] : draft.profile.paymentMethods.filter((entry) => entry !== method) } })} />{label}</label>)}</fieldset>
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
          {!createPin && <><button className="button secondary" type="button" disabled={busy} onClick={changeBusiness}>Cambiar negocio</button><button className="button secondary" type="button" disabled={busy} onClick={() => { setPin(''); setError(''); navigate(selected?.canRecoverPin === true ? 'reauth' : 'employee-pin') }}>Olvidé mi PIN</button></>}
        </form>
      </section>
      : screen === 'choose' ? <section className="screen"><h1>Tus negocios</h1><p>Elige dónde quieres entrar.</p>{error && <p className="error-message" role="alert">{error}</p>}<div className="business-list">{businesses.map((business) => <button className="business-choice" disabled={busy} key={business.id} onClick={() => { setSelected(business); setError(''); setPin(''); navigate('unlock') }}><span className="business-icon"><Coffee size={22} strokeWidth={1.5} aria-hidden="true" /></span><span>{business.name}</span><ChevronRight size={20} aria-hidden="true" /></button>)}</div><button className="button secondary" disabled={busy} onClick={() => { operationId.current = crypto.randomUUID(); setDraft(initialDraft); setError(''); navigate('business') }}>Crear otro negocio</button><button className="button secondary" disabled={busy} onClick={() => { setError(''); navigate('join') }}>Unirme a un negocio</button></section>
      : isReady && operator ? <section className="ready-screen"><div className="ready-mark"><Check size={28} strokeWidth={2} aria-hidden="true" /></div><p className="business-name">{operator.business.name}</p><h1>Cuenta creada</h1><p>Tu acceso está listo. Puedes configurar el negocio y añadir a tu equipo desde el inicio.</p><dl className="business-details"><div><dt>Tipo de negocio</dt><dd>{{ cafe: 'Cafetería', restaurant: 'Restaurante', other: 'Otro' }[operator.business.businessType]}</dd></div><div><dt>Zona horaria</dt><dd>{timezones.find(([value]) => value === operator.business.timezone)?.[1] ?? operator.business.timezone}</dd></div><div><dt>Sucursal / caja</dt><dd>{operator.business.profile?.branchName} / {operator.business.profile?.registerName}</dd></div></dl>{error && <p className="error-message" role="alert">{error}</p>}<div className="home-actions"><button className="button primary" onClick={() => navigate('home')} disabled={busy}>Ir al inicio<ArrowRight size={20} aria-hidden="true" /></button><button className="button secondary" onClick={() => void lock()} disabled={busy}><LockKeyhole size={20} aria-hidden="true" />{busy ? 'Un momento…' : 'Bloquear'}</button></div></section>
      : screen === 'settings' && operator?.business.role === 'owner' ? <BusinessSettings business={operator.business} operatorToken={operator.operatorToken} onSaved={savedBusiness} onBack={() => navigate('home')} onSessionError={showFailure} />
      : (screen === 'team' || screen === 'devices') && operator?.business.role === 'owner' ? <TeamPanel key={screen} section={screen === 'devices' ? 'devices' : 'employees'} business={operator.business} operatorToken={operator.operatorToken} onBack={() => navigate('home')} onSessionError={showFailure} />
      : isHome && operator ? <HomeScreen business={operator.business} onLock={() => void lock()} onLogout={() => void logout()} busy={busy} error={error} destination={homeDestination} onDestinationChange={(value) => { setHomeDestination(value); setMoreReturn(''); setHomeNotice('') }} focusOnReturn={moreReturn} notice={homeNotice} onSettings={() => openMoreScreen('settings', 'settings')} onTeam={() => openMoreScreen('team', 'employees')} onDevices={() => openMoreScreen('devices', 'devices')} onSwitchBusiness={changeBusiness} onChangePin={changePin} onRecoveryCode={() => { setCurrentPin(''); setError(''); recoveryOperation.current = null; openMoreScreen('recovery-code', 'recovery') }} />
      : <section className="screen"><h1>No pudimos cargar tu negocio</h1>{error && <p className="error-message" role="alert">{error}</p>}<div className="screen-actions"><button className="button primary" onClick={() => void loadBusinesses()}>Intentar de nuevo</button></div></section>}
      </Suspense>
    </main>
    {!isHome && <footer className="app-footer">POS México</footer>}
  </div>
}
