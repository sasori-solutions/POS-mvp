import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Link, Share2, UserRound } from 'lucide-react'
import EmployeeRoleFields from './EmployeeRoleFields'
import InvitationQr from './InvitationQr'
import { accountRequest, AccountClientError } from '../lib/account'
import type { BusinessContext, BusinessRole, EmployeeSummary, EmployeeCreation, InvitationSummary, AccountResponses } from '../lib/contracts'
import './account-management.css'

interface TeamPanelProps {
  business: BusinessContext
  operatorToken: string
  section: 'employees' | 'devices'
  onBack: () => void
  onSessionError?: (error: AccountClientError) => void
}

type EmployeeRole = Exclude<BusinessRole, 'owner'>
const roles: Record<BusinessRole, string> = { owner: 'Dueño', manager: 'Encargado', cashier: 'Cajero', kitchen: 'Cocina' }
const sessionErrors = ['AUTH_REQUIRED', 'GOOGLE_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'BUSINESS_ACCESS_DENIED', 'PERMISSION_DENIED', 'REAUTH_REQUIRED']
type Code = { setupId?: string; value: string; label: string; expiresAt: string; path: string; parameter: string; invitationId?: string; employeeId?: string }

export default function TeamPanel({ business, operatorToken, section, onBack, onSessionError }: TeamPanelProps) {
  const [team, setTeam] = useState<AccountResponses['team'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [denied, setDenied] = useState(business.role !== 'owner')
  const tab = section
  const [form, setForm] = useState(false)
  const [editing, setEditing] = useState<EmployeeSummary | null>(null)
  const [invitationReady, setInvitationReady] = useState(false)
  const [deviceToRemove, setDeviceToRemove] = useState<{ id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState<EmployeeRole>('cashier')
  const [code, setCode] = useState<Code | null>(null)
  const [now, setNow] = useState(Date.now)
  const heading = useRef<HTMLHeadingElement>(null)
  const listButton = useRef<HTMLButtonElement>(null)
  const selectedEmployee = useRef<string | null>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const requestSequence = useRef(0)
  const refreshing = useRef(false)
  const mutationBusy = useRef(false)
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; operation.current = null }
  }, [])

  useEffect(() => { heading.current?.focus() }, [form, editing?.id, confirmDelete, invitationReady])

  function showError(caught: unknown) {
    if (!mounted.current) return
    setError(caught instanceof Error ? caught.message : 'No pudimos completar la solicitud. Intenta de nuevo.')
    if (caught instanceof AccountClientError && sessionErrors.includes(caught.code)) {
      setDenied(true)
      setTeam(null)
      setEditing(null)
      selectedEmployee.current = null
      setCode(null)
      operation.current = null
      onSessionError?.(caught)
    }
  }

  async function load(showLoading = true) {
    const current = generation.current
    const sequence = ++requestSequence.current
    if (business.role !== 'owner') { setLoading(false); return }
    if (showLoading) setLoading(true)
    try {
      const result = await accountRequest({ action: 'team', businessId: business.id, operatorToken })
      if (mounted.current && current === generation.current && sequence === requestSequence.current) {
        setTeam(result)
        if (selectedEmployee.current && !result.employees.some((item) => item.id === selectedEmployee.current)) {
          closeForm()
          setNotice('El empleado ya fue eliminado de este negocio. Su acceso está cerrado.')
        }
        setEditing((employee) => employee ? result.employees.find((item) => item.id === employee.id) ?? employee : null)
      }
    } catch (caught) { if (current === generation.current && sequence === requestSequence.current) showError(caught) }
    finally { if (mounted.current && current === generation.current && sequence === requestSequence.current) setLoading(false) }
  }

  useEffect(() => {
    generation.current += 1
    mutationBusy.current = false
    operation.current = null
    setBusy(false)
    setTeam(null)
    setEditing(null)
    selectedEmployee.current = null
    setCode(null)
    setForm(false)
    setInvitationReady(false)
    setError('')
    setNotice('')
    setDenied(business.role !== 'owner')
    void load()
    return () => { generation.current += 1 }
  }, [business.id, business.role, operatorToken])

  useEffect(() => {
    function refresh() {
      if (document.visibilityState === 'hidden' || denied || business.role !== 'owner' || mutationBusy.current || refreshing.current) return
      refreshing.current = true
      setNow(Date.now())
      void load(false).finally(() => { refreshing.current = false })
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [business.id, business.role, operatorToken, denied])

  useEffect(() => {
    const deadlines = team?.invitations.filter((item) => item.status === 'pending')
      .map((item) => new Date(item.expiresAt).getTime()).filter((value) => value > now) ?? []
    if (code && new Date(code.expiresAt).getTime() > now) deadlines.push(new Date(code.expiresAt).getTime())
    if (!deadlines.length || denied) return
    const timer = window.setTimeout(() => {
      setNow(Date.now())
      if (!mutationBusy.current) void load(false)
    }, Math.min(Math.min(...deadlines) - Date.now() + 1, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [team, code, now, denied])

  function rememberInvitation(employee: EmployeeSummary, invitation: NonNullable<EmployeeCreation['invitation']>) {
    setTeam((previous) => previous ? {
      ...previous,
      employees: [...previous.employees.filter((item) => item.id !== employee.id), employee],
      invitations: [{ id: invitation.invitationId, employeeId: employee.id, name: employee.name,
        role: employee.role as EmployeeRole, active: true, status: 'pending', expiresAt: invitation.expiresAt,
        acceptedAt: null, revokedAt: null, revokeReason: null }, ...previous.invitations.filter((item) => item.id !== invitation.invitationId)],
    } : previous)
  }

  function openForm(employee?: EmployeeSummary) {
    setForm(true)
    setEditing(employee ?? null)
    selectedEmployee.current = employee?.id ?? null
    setInvitationReady(false)
    setConfirmDelete(false)
    setName(employee?.name ?? '')
    setRole(employee && employee.role !== 'owner' ? employee.role : 'cashier')
    setError('')
    setNotice('')
    setCode(null)
    operation.current = null
  }

  function closeForm() {
    setForm(false)
    setInvitationReady(false)
    setEditing(null)
    selectedEmployee.current = null
    setConfirmDelete(false)
    setCode(null)
    setError('')
    operation.current = null
    requestAnimationFrame(() => listButton.current?.focus())
  }

  function operationId(payload: unknown) {
    const fingerprint = JSON.stringify(payload)
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() }
    return operation.current.id
  }

  async function saveEmployee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutationBusy.current || editing && !employeeDirty) return
    const employeeName = name.trim().replace(/\s+/g, ' ')
    if (employeeName.length < 2 || employeeName.length > 100) { setError('Escribe un nombre de 2 a 100 caracteres.'); return }
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const employee: EmployeeCreation = editing
        ? await accountRequest({ action: 'update_employee', businessId: business.id, operatorToken, employeeId: editing.id,
          name: employeeName, role, active: editing.active, pin: null })
        : await accountRequest({ action: 'create_employee', businessId: business.id, operatorToken,
          name: employeeName, role, pin: null, inviteWithGoogle: true,
          operationId: operationId({ action: 'create_employee', name: employeeName, role, pin: null, inviteWithGoogle: true }) })
      if (!mounted.current || current !== generation.current) return
      setEditing(employee)
      selectedEmployee.current = employee.id
      setName(employee.name)
      if (employee.pinSetup) setCode({ value: employee.pinSetup.setupCode, setupId: employee.pinSetup.setupId, label: 'Código para PIN', expiresAt: employee.pinSetup.expiresAt, path: '', parameter: 'setup', employeeId: employee.id })
      if (employee.invitation) {
        const invitation = employee.invitation
        rememberInvitation(employee, invitation)
        setCode({ value: invitation.invitationCode, label: 'Código de invitación', expiresAt: invitation.expiresAt, path: '/', parameter: 'invite', employeeId: employee.id, invitationId: invitation.invitationId })
      }
      operation.current = null
      setInvitationReady(!editing)
      setNotice(editing ? 'Cambios guardados.' : '')
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function linkGoogle(employee: EmployeeSummary) {
    if (mutationBusy.current) return
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await accountRequest({ action: 'create_invitation', businessId: business.id, operatorToken, employeeId: employee.id,
        operationId: operationId({ action: 'create_invitation', employeeId: employee.id }) })
      if (!mounted.current || current !== generation.current) return
      rememberInvitation(employee, result)
      setCode({ value: result.invitationCode, label: 'Código de invitación', expiresAt: result.expiresAt, path: '/', parameter: 'invite', employeeId: employee.id, invitationId: result.invitationId })
      operation.current = null
      setNotice('Invitación creada.')
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function authorizePin(employee: EmployeeSummary) {
    if (mutationBusy.current) return
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await accountRequest({ action: 'create_pin_setup', businessId: business.id, operatorToken, employeeId: employee.id, operationId: operationId({ action: 'create_pin_setup', employeeId: employee.id }) })
      if (!mounted.current || current !== generation.current) return
      setCode({ value: result.setupCode, setupId: result.setupId, label: 'Código para PIN', expiresAt: result.expiresAt, path: '', parameter: 'setup', employeeId: employee.id })
      operation.current = null
      setNotice('Código creado.')
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function deleteEmployee(employee: EmployeeSummary) {
    if (mutationBusy.current) return
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await accountRequest({ action: 'delete_employee', businessId: business.id, operatorToken, employeeId: employee.id, operationId: operationId({ action: 'delete_employee', employeeId: employee.id }) })
      if (!mounted.current || current !== generation.current) return
      operation.current = null
      closeForm()
      setNotice(`${employee.name} fue eliminado de este negocio. Su PIN y su dispositivo quedaron desvinculados. Para volver necesitará una nueva invitación.`)
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function reactivateEmployee(employee: EmployeeSummary) {
    if (mutationBusy.current || employee.role === 'owner') return
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true)
    setError('')
    try {
      const result = await accountRequest({ action: 'update_employee', businessId: business.id, operatorToken, employeeId: employee.id, name: employee.name, role: employee.role, active: true, pin: null })
      if (!mounted.current || current !== generation.current) return
      setEditing(result)
      setNotice('Empleado reactivado.')
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function pairing() {
    if (mutationBusy.current) return
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await accountRequest({ action: 'create_pairing_code', businessId: business.id, operatorToken, operationId: operationId({ action: 'create_pairing_code' }) })
      if (!mounted.current || current !== generation.current) return
      setCode({ value: result.pairingCode, label: 'Código para vincular dispositivo', expiresAt: result.expiresAt, path: '/register', parameter: 'pair' })
      operation.current = null
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function revoke(kind: 'invitation' | 'device', id: string) {
    if (mutationBusy.current) return
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (kind === 'invitation') await accountRequest({ action: 'revoke_invitation', businessId: business.id, operatorToken, invitationId: id })
      else await accountRequest({ action: 'revoke_device', businessId: business.id, operatorToken, deviceId: id })
      if (!mounted.current || current !== generation.current) return
      setNotice(kind === 'invitation' ? 'Ese enlace ya no permite entrar.' : 'Dispositivo desvinculado. Ya no permite entrar al negocio.')
      if (kind === 'invitation') setCode(null)
      else setDeviceToRemove(null)
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  function codeLink(value: Code) {
    return `${window.location.origin}${value.path}#${value.parameter}=${encodeURIComponent(value.value)}`
  }

  async function copyCode() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.parameter === 'setup' ? code.value : codeLink(code))
      setNotice(code.parameter === 'setup' ? 'Código copiado.' : 'Enlace copiado.')
    } catch { setError(code.parameter === 'setup' ? 'No pudimos copiar el código. Selecciónalo y cópialo del campo.' : 'No pudimos copiar el enlace. Selecciónalo y cópialo del campo.') }
  }

  async function shareInvitation() {
    if (!currentCode || currentCode.parameter !== 'invite' || new Date(currentCode.expiresAt).getTime() <= Date.now()) return
    setError('')
    setNotice('')
    const current = generation.current
    try {
      await navigator.share({ title: 'Invitación a POS México', url: codeLink(currentCode) })
      if (mounted.current && current === generation.current) setNotice('Enlace compartido.')
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'AbortError') return
      if (mounted.current && current === generation.current) setError('No pudimos compartir el enlace. Usa Copiar enlace o escanea el QR.')
    }
  }

  function latestInvitation(employee: EmployeeSummary) {
    const invitations = team?.invitations.filter((invitation) => invitation.employeeId === employee.id)
      .map((invitation) => invitation.status === 'pending' && new Date(invitation.expiresAt).getTime() <= now
        ? { ...invitation, status: 'expired' as const, active: false } : invitation) ?? []
    return invitations.find((invitation) => invitation.status === 'pending')
      ?? (employee.googleLinked ? invitations.find((invitation) => invitation.status === 'accepted') : undefined)
      ?? invitations[0]
  }

  function accessLabel(employee: EmployeeSummary) {
    if (!employee.active) return 'Acceso desactivado'
    if (employee.googleLinked) return 'Google y PIN'
    const pending = latestInvitation(employee)?.status === 'pending'
    if (employee.pinReady) return pending ? 'PIN en caja. Google pendiente' : 'PIN en caja'
    return pending ? 'Invitación pendiente' : 'Pendiente de crear PIN'
  }

  function date(value: string) {
    return new Date(value).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short', hour12: false, timeZone: business.timezone })
  }

  function invitationLabel(invitation: InvitationSummary) {
    if (invitation.status === 'pending') return 'Pendiente de aceptar'
    if (invitation.status === 'accepted') return 'Invitación aceptada'
    if (invitation.status === 'expired') return 'Invitación vencida'
    if (invitation.status === 'revoked') return invitation.revokeReason === 'replaced' ? 'Invitación reemplazada' : 'Invitación cancelada'
    return 'Invitación no disponible'
  }

  function invitationDetail(invitation: InvitationSummary) {
    if (invitation.status === 'accepted') return `Aceptada${invitation.acceptedAt ? ` el ${date(invitation.acceptedAt)}` : ''}. El empleado vinculó su cuenta de Google.`
    if (invitation.status === 'pending') return `Vence el ${date(invitation.expiresAt)}. ${editing?.pinReady ? 'Verificará el PIN que ya usa en la caja; conservará el mismo.' : 'El empleado elegirá su PIN al aceptarla.'}`
    if (invitation.status === 'expired') return `Venció el ${date(invitation.expiresAt)}. Ese enlace ya no permite entrar.`
    const reasons: Record<NonNullable<InvitationSummary['revokeReason']>, string> = {
      user_cancelled: 'La cancelaste. Ese enlace ya no permite entrar.',
      replaced: 'Se creó una nueva invitación. El enlace anterior dejó de funcionar.',
      employee_deleted: 'Se eliminó al empleado y se cerró su invitación.',
      employee_deactivated: 'Se desactivó el acceso del empleado y se cerró su invitación.',
      employee_linked: 'El empleado ya vinculó Google mediante otra invitación.',
    }
    return `${invitation.revokeReason ? reasons[invitation.revokeReason] : 'Ese enlace ya no permite entrar.'}${invitation.revokedAt ? ` Se cerró el ${date(invitation.revokedAt)}.` : ''}`
  }

  const invitation = editing ? latestInvitation(editing) : undefined
  const currentCode = code && new Date(code.expiresAt).getTime() > now && (form ? code.employeeId === editing?.id && (code.parameter === 'setup' || invitation?.id === code.invitationId && invitation?.status === 'pending') : tab === 'devices' && code.parameter === 'pair') ? code : null
  const employees = team?.employees.filter((employee) => employee.role !== 'owner') ?? []
  const employeeDirty = Boolean(editing && (name.trim().replace(/\s+/g, ' ') !== editing.name || role !== editing.role))

  function codeCard() {
    if (!currentCode) return null
    if (currentCode.parameter === 'invite') return <div className="employee-invitation-link">
      <InvitationQr link={codeLink(currentCode)} label="QR de la invitación" instruction="El empleado puede escanearlo con la cámara del dispositivo que usará para trabajar." />
      <label htmlFor="invitation-link">Enlace de invitación</label>
      <input id="invitation-link" value={codeLink(currentCode)} readOnly onFocus={(event) => event.target.select()} />
      <div className="invitation-share-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => void copyCode()}><Link size={18} aria-hidden="true" />Copiar enlace</button>
        {typeof navigator.share === 'function' && <button type="button" className="button secondary" disabled={busy} onClick={() => void shareInvitation()}><Share2 size={18} aria-hidden="true" />Compartir enlace</button>}
      </div>
      <p>Vence el {date(currentCode.expiresAt)}. Sólo se puede usar una vez.</p>
    </div>
    return <div className="management-code">
      {currentCode.parameter === 'pair' && <InvitationQr link={codeLink(currentCode)} label="QR para vincular la caja" instruction="Escanea este QR desde el dispositivo de caja, o abre allí el enlace que copies." />}
      <label htmlFor="management-code">{currentCode.label}</label>
      <input id="management-code" value={currentCode.value} readOnly onFocus={(event) => event.target.select()} />
      {currentCode.parameter === 'pair' && <ol className="management-steps"><li>Abre el enlace o escanea el QR en el dispositivo de caja.</li><li>Si prefieres ingresar el código, elige «Vincular caja compartida».</li><li>Asigna un nombre para identificar el dispositivo.</li></ol>}
      {currentCode.parameter === 'setup' && <p>En una caja vinculada, el empleado debe pulsar «Crear o restablecer mi PIN».</p>}
      <p>{currentCode.parameter !== 'invite' && <>Vence el {date(currentCode.expiresAt)}. </>}Sólo se puede usar una vez.</p>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void copyCode()}>{currentCode.parameter === 'setup' ? 'Copiar código' : 'Copiar enlace'}</button>
    </div>
  }

  return <div className="management-shell" onKeyDown={(event) => { if (event.key === 'Escape' && form && !busy) { event.preventDefault(); if (confirmDelete) setConfirmDelete(false); else closeForm() } }}>
    <button type="button" className="back-button" disabled={busy} onClick={form ? closeForm : onBack}><ArrowLeft size={18} aria-hidden="true" />{form ? 'Volver a empleados' : 'Volver a Más'}</button>
    <div className="management-heading"><h1 ref={heading} tabIndex={-1}>{confirmDelete && editing ? `¿Eliminar a ${editing.name}?` : invitationReady ? currentCode ? 'Invitación lista' : 'Invitación del empleado' : form ? editing ? 'Administrar empleado' : 'Agregar empleado' : tab === 'devices' ? 'Dispositivos de caja' : 'Empleados'}</h1>{!form && <p>{business.name}</p>}</div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {notice && <p className="management-success" role="status">{notice}</p>}
    {denied ? <p className="management-warning">Sólo el dueño puede administrar el personal y las cajas.</p> : <>
      {loading && <div className="management-loading" role="status"><span className="loader" aria-hidden="true" />{section === 'devices' ? 'Cargando dispositivos…' : 'Cargando empleados…'}</div>}
      {!loading && !team && <button type="button" className="button secondary" onClick={() => { setError(''); void load() }}>Reintentar</button>}
      {form ? confirmDelete && editing ? <section className="management-confirmation">
        <p>Se eliminarán su acceso a este negocio, su PIN y su dispositivo vinculado. Sus sesiones e invitaciones dejarán de funcionar.</p>
        <p className="field-help">Esta acción no se puede deshacer. Si vuelve al equipo, necesitará una nueva invitación y elegirá un nuevo PIN.</p>
        <div className="management-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void deleteEmployee(editing)}>Confirmar eliminación</button><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancelar eliminación</button></div>
      </section> : invitationReady && editing ? <section className="employee-invitation-ready" aria-label="Compartir invitación">
        <div className="employee-invited-person"><UserRound size={24} aria-hidden="true" /><div><strong>{editing.name}</strong><span>{roles[editing.role]}</span></div></div>
        {currentCode ? <>
          <p className="field-help">Pendiente de aceptar</p>
          <p>Comparte el enlace con {editing.name} o pídele que escanee el QR desde su dispositivo.</p>
          {codeCard()}
          <div className="employee-invitation-next"><h2>¿Qué hará el empleado?</h2><ol><li>Abrir la invitación en el dispositivo que usará y entrar con su cuenta de Google.</li><li>Crear su PIN de 6 dígitos y vincular ese dispositivo.</li><li>Necesitará tu autorización para cambiar de dispositivo.</li></ol></div>
        </> : <>
          {invitation && <div className="management-invitation"><strong>{invitationLabel(invitation)}</strong><p>{invitationDetail(invitation)}</p></div>}
          {editing.active && !editing.googleLinked && <button type="button" className="button primary" disabled={busy} onClick={() => void linkGoogle(editing)}>Renovar invitación</button>}
        </>}
        <div className="employee-invitation-footer"><button type="button" className="button secondary" disabled={busy} onClick={closeForm}>Listo</button><button type="button" className="management-text-button" disabled={busy} onClick={() => { setInvitationReady(false); setNotice('') }}>Administrar empleado</button></div>
      </section> : <>
        <form className="management-form" onSubmit={saveEmployee}>
          <div className="field"><label htmlFor="employee-name">Nombre del empleado</label><input id="employee-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required disabled={busy} /></div>
          <EmployeeRoleFields role={role} onChange={setRole} disabled={busy} />
          {!editing && <div className="employee-invite-explanation"><Link size={20} aria-hidden="true" /><p>Recibirás un enlace y un QR para compartir. El empleado entrará con Google, creará su PIN y vinculará su dispositivo.</p></div>}
          <div className="management-actions"><button className="button primary" disabled={busy || Boolean(editing && !employeeDirty)} aria-busy={busy}>{busy ? editing ? 'Guardando…' : 'Creando invitación…' : editing ? 'Guardar cambios' : 'Crear invitación'}</button>{!editing && <button type="button" className="button secondary" disabled={busy} onClick={closeForm}>Cancelar</button>}</div>
        </form>
        {editing && <>
          <section className="management-detail" aria-labelledby="access-title"><h2 id="access-title">PIN del empleado</h2><p className="field-help">{!editing.pinReady && invitation?.status === 'pending' ? 'Lo creará al aceptar la invitación.' : 'El empleado elige su PIN. Si necesita uno nuevo, crea un código y compártelo con él.'}</p>{editing.active && (editing.pinReady || invitation?.status !== 'pending') && <button type="button" className="button secondary" disabled={busy} onClick={() => void authorizePin(editing)}>{editing.pinReady ? 'Crear código para restablecer PIN' : 'Crear código para PIN'}</button>}{(editing.pinReady || editing.googleLinked || invitation?.status !== 'pending' || !editing.active) && <p>{editing.pinReady && !editing.googleLinked && editing.active ? 'PIN en caja' : accessLabel(editing)}</p>}
            {!editing.active && <button type="button" className="button secondary" disabled={busy} onClick={() => void reactivateEmployee(editing)}>Reactivar empleado</button>}
            {currentCode?.parameter === 'setup' && codeCard()}
            </section><section className="management-detail management-google" aria-labelledby="google-title"><h2 id="google-title">{editing.googleLinked ? 'Cuenta de Google' : 'Invitación'}</h2>{editing.googleLinked && <p>Cuenta vinculada.</p>}{!editing.googleLinked && !invitation && <p>Comparte una invitación para vincular su cuenta de Google. Conservará el PIN que ya usa.</p>}{invitation && <div className="management-invitation"><strong>{invitationLabel(invitation)}</strong><p>{invitationDetail(invitation)}</p></div>}
            {currentCode?.parameter === 'invite' && <p className="field-help">Comparte este enlace con {editing.name}. No se envía por correo automáticamente.</p>}
            {currentCode?.parameter === 'invite' && codeCard()}
            {editing.active && !editing.googleLinked && <>
              {invitation?.status === 'pending' && currentCode?.parameter !== 'invite' && <p className="field-help">El enlace sólo se muestra al crearlo. Renueva la invitación para obtener uno nuevo.</p>}
              <div className="management-actions">{(currentCode?.parameter !== 'invite' || invitation?.status !== 'pending') && <button type="button" className="button secondary" disabled={busy} onClick={() => void linkGoogle(editing)}>{invitation ? 'Renovar invitación' : 'Crear invitación'}</button>}{invitation?.status === 'pending' && <button type="button" className="button secondary" disabled={busy} onClick={() => void revoke('invitation', invitation.id)}>Cancelar invitación</button>}</div>
            </>}
          </section>
          <div className="management-danger"><button type="button" className="management-text-button" disabled={busy} onClick={() => { setConfirmDelete(true); setError(''); setNotice(''); operation.current = null }}>Eliminar empleado</button></div>
        </>}
      </> : team && <>
        <section hidden={tab !== 'employees'} id="management-employees-panel" aria-label="Empleados" className="management-section">
          <button ref={listButton} type="button" className="button primary" disabled={busy} onClick={() => openForm()}>Agregar empleado</button>
          <ul className="management-list" aria-label="Empleados">{employees.map((employee) => <li key={employee.id}><div><strong>{employee.name}</strong><p>{roles[employee.role]}. {accessLabel(employee)}</p></div><button type="button" className="button secondary" aria-label={`Administrar ${employee.name}`} disabled={busy} onClick={() => openForm(employee)}>Administrar</button></li>)}</ul>
          {!employees.length && <p className="management-empty">Aún no has agregado empleados.</p>}
        </section><section hidden={tab !== 'devices'} id="management-devices-panel" aria-label="Dispositivos de caja" className="management-section"><p>Vincula una tablet o computadora para empleados que tienen acceso de caja con PIN. Quienes usan Google deben entrar desde su dispositivo vinculado.</p>
          {codeCard()}
          {deviceToRemove && <div className="management-device-confirm" role="region" aria-labelledby="remove-device-title" aria-describedby="remove-device-help"><h2 id="remove-device-title">¿Desvincular {deviceToRemove.name}?</h2><p id="remove-device-help">Se cerrarán las sesiones en ese dispositivo. Necesitarás vincularlo de nuevo para usarlo como caja.</p><div className="management-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void revoke('device', deviceToRemove.id)}>Confirmar desvinculación</button><button type="button" className="button secondary" disabled={busy} onClick={() => setDeviceToRemove(null)}>Cancelar</button></div></div>}
          <ul className="management-list" aria-label="Dispositivos">{team.devices.map((device) => <li key={device.id}><div><strong>{device.name}</strong><p>{device.registerName}{device.active ? '' : '. Sin acceso'}</p></div>{device.active && <button type="button" className="button secondary" aria-label={`Desvincular ${device.name}`} disabled={busy} onClick={() => { setDeviceToRemove({ id: device.id, name: device.name }); setError(''); setNotice('') }}>Desvincular</button>}</li>)}</ul>
          {!team.devices.length && <p className="management-empty">Aún no hay tablets o computadoras vinculadas.</p>}
          <button type="button" className="button secondary" disabled={busy} onClick={() => void pairing()}>Vincular dispositivo</button>
        </section>
      </>}
    </>}
  </div>
}
