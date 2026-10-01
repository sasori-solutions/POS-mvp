import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { accountRequest, AccountClientError } from '../lib/account'
import type { BusinessContext, BusinessRole, EmployeeSummary, EmployeeCreation, InvitationSummary, AccountResponses } from '../lib/contracts'
import './account-management.css'

interface TeamPanelProps {
  business: BusinessContext
  operatorToken: string
  onBack: () => void
  onSessionError?: (error: AccountClientError) => void
}

type EmployeeRole = Exclude<BusinessRole, 'owner'>
const roles: Record<BusinessRole, string> = { owner: 'Dueño', manager: 'Encargado', cashier: 'Cajero', kitchen: 'Cocina' }
const sessionErrors = ['AUTH_REQUIRED', 'GOOGLE_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'BUSINESS_ACCESS_DENIED', 'PERMISSION_DENIED', 'REAUTH_REQUIRED']
type Code = { setupId?: string; value: string; label: string; expiresAt: string; path: string; parameter: string; invitationId?: string; employeeId?: string }

export default function TeamPanel({ business, operatorToken, onBack, onSessionError }: TeamPanelProps) {
  const [team, setTeam] = useState<AccountResponses['team'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [denied, setDenied] = useState(business.role !== 'owner')
  const [tab, setTab] = useState<'employees' | 'devices'>('employees')
  const [form, setForm] = useState(false)
  const [editing, setEditing] = useState<EmployeeSummary | null>(null)
  const [inviteWithGoogle, setInviteWithGoogle] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState<EmployeeRole>('cashier')
  const [code, setCode] = useState<Code | null>(null)
  const [now, setNow] = useState(Date.now)
  const heading = useRef<HTMLHeadingElement>(null)
  const listButton = useRef<HTMLButtonElement>(null)
  const tabs = useRef<Partial<Record<'employees' | 'devices', HTMLButtonElement | null>>>({})
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

  useEffect(() => { if (form) heading.current?.focus() }, [form, editing?.id, confirmDelete])

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
        const deleted = result.deletedEmployees?.find((item) => item.id === selectedEmployee.current)
        if (deleted) {
          closeForm()
          setNotice(`${deleted.name} ya fue eliminado. Su acceso está cerrado.`)
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
    setTab('employees')
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
    setInviteWithGoogle(false)
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
          name: employeeName, role, pin: null, inviteWithGoogle,
          operationId: operationId({ action: 'create_employee', name: employeeName, role, pin: null, inviteWithGoogle }) })
      if (!mounted.current || current !== generation.current) return
      setEditing(employee)
      selectedEmployee.current = employee.id
      setName(employee.name)
      if (employee.pinSetup) setCode({ value: employee.pinSetup.setupCode, setupId: employee.pinSetup.setupId, label: 'Código para crear o restablecer PIN', expiresAt: employee.pinSetup.expiresAt, path: '', parameter: 'setup', employeeId: employee.id })
      if (employee.invitation) {
        const invitation = employee.invitation
        rememberInvitation(employee, invitation)
        setCode({ value: invitation.invitationCode, label: 'Código de invitación', expiresAt: invitation.expiresAt, path: '/', parameter: 'invite', employeeId: employee.id, invitationId: invitation.invitationId })
      }
      operation.current = null
      setNotice(editing ? 'Cambios guardados.' : inviteWithGoogle ? 'Empleado agregado.' : 'Empleado agregado. Comparte el código para que cree su PIN.')
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
      setNotice('Enlace creado.')
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
      setCode({ value: result.setupCode, setupId: result.setupId, label: 'Código para crear o restablecer PIN', expiresAt: result.expiresAt, path: '', parameter: 'setup', employeeId: employee.id })
      operation.current = null
      setNotice('Comparte el código con el empleado. Él elegirá su PIN en una caja vinculada o con su Google.')
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function employeeLifecycle(employee: EmployeeSummary, action: 'delete_employee' | 'restore_employee') {
    if (mutationBusy.current) return
    const current = generation.current
    mutationBusy.current = true
    requestSequence.current += 1
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await accountRequest({ action, businessId: business.id, operatorToken, employeeId: employee.id, operationId: operationId({ action, employeeId: employee.id }) })
      if (!mounted.current || current !== generation.current) return
      operation.current = null
      if (action === 'delete_employee') closeForm()
      setNotice(action === 'delete_employee' ? `${employee.name} fue eliminado. Su acceso y sus invitaciones quedaron cerrados.` : `${employee.name} fue restaurado. Tendrá que entrar de nuevo; los enlaces anteriores no se reactivan.`)
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
      setCode({ value: result.pairingCode, label: 'Código de emparejamiento', expiresAt: result.expiresAt, path: '/employee', parameter: 'pair' })
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
      setNotice(kind === 'invitation' ? 'Ese enlace ya no permite entrar.' : 'Dispositivo revocado. Sus operadores ya no pueden entrar.')
      if (kind === 'invitation') setCode(null)
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function copyCode() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.parameter === 'setup' ? code.value : `${window.location.origin}${code.path}#${code.parameter}=${encodeURIComponent(code.value)}`)
      setNotice(code.parameter === 'setup' ? 'Código copiado.' : 'Enlace copiado.')
    } catch { setError('No pudimos copiar el enlace. Puedes copiar el código del campo.') }
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
    return new Date(value).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: business.timezone })
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
  const currentCode = code && (form ? code.employeeId === editing?.id && (code.parameter === 'setup' ? new Date(code.expiresAt).getTime() > now : invitation?.id === code.invitationId && invitation?.status === 'pending') : tab === 'devices' && code.parameter === 'pair') ? code : null
  const employees = team?.employees.filter((employee) => employee.role !== 'owner' && !employee.deletedAt) ?? []
  const deletedEmployees = team?.deletedEmployees?.filter((employee) => employee.role !== 'owner') ?? []
  const employeeDirty = Boolean(editing && (name.trim().replace(/\s+/g, ' ') !== editing.name || role !== editing.role))

  function selectTab(next: 'employees' | 'devices', focus = false) {
    setTab(next)
    setCode(null)
    setError('')
    setNotice('')
    operation.current = null
    if (focus) tabs.current[next]?.focus()
  }

  function codeCard() {
    if (!currentCode) return null
    return <div className="management-code">
      <label htmlFor="management-code">{currentCode.label}</label>
      <input id="management-code" value={currentCode.value} readOnly onFocus={(event) => event.target.select()} />
      <p>{currentCode.parameter !== 'invite' && <>Vence el {date(currentCode.expiresAt)}. </>}Sólo se puede usar una vez.</p>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void copyCode()}>{currentCode.parameter === 'setup' ? 'Copiar código' : 'Copiar enlace'}</button>
    </div>
  }

  return <div className="management-shell" onKeyDown={(event) => { if (event.key === 'Escape' && form && !busy) { event.preventDefault(); if (confirmDelete) setConfirmDelete(false); else closeForm() } }}>
    <button type="button" className="back-button" disabled={busy} onClick={form ? closeForm : onBack}><ArrowLeft size={18} aria-hidden="true" />{form ? 'Volver a empleados' : 'Volver'}</button>
    <div className="management-heading"><h1 ref={heading} tabIndex={-1}>{confirmDelete && editing ? `¿Eliminar a ${editing.name}?` : form ? editing ? 'Administrar empleado' : 'Agregar empleado' : 'Personal y dispositivos'}</h1>{!form && <p>{business.name}</p>}</div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {notice && <p className="management-success" role="status">{notice}</p>}
    {denied ? <p className="management-warning">Sólo el dueño puede administrar el personal y las cajas.</p> : <>
      {loading && <div className="management-loading" role="status"><span className="loader" aria-hidden="true" />Cargando personal…</div>}
      {!loading && !team && <button type="button" className="button secondary" onClick={() => { setError(''); void load() }}>Reintentar</button>}
      {form ? confirmDelete && editing ? <section className="management-confirmation">
        <p>Se cerrarán sus sesiones y sus invitaciones. Dejará de aparecer en las cajas.</p>
        <p className="field-help">Sus registros se conservan y podrás restaurarlo desde Empleados eliminados.</p>
        <div className="management-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void employeeLifecycle(editing, 'delete_employee')}>Confirmar eliminación</button><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancelar eliminación</button></div>
      </section> : <>
        <form className="management-form" onSubmit={saveEmployee}>
          <div className="field"><label htmlFor="employee-name">Nombre del empleado</label><input id="employee-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required disabled={busy} /></div>
          <div className="field"><label htmlFor="employee-role">Rol</label><select id="employee-role" value={role} onChange={(event) => setRole(event.target.value as EmployeeRole)} disabled={busy}><option value="manager">Encargado</option><option value="cashier">Cajero</option><option value="kitchen">Cocina</option></select></div>
          {!editing && <><label className="management-checkbox"><input type="checkbox" checked={inviteWithGoogle} disabled={busy} onChange={(event) => { setInviteWithGoogle(event.target.checked); operation.current = null }} />Invitar a usar Google</label><p className="field-help">{inviteWithGoogle ? 'Se creará un enlace para que tú lo compartas. El empleado elegirá su PIN al aceptarlo.' : 'El empleado creará su propio PIN con un código que tú le compartes.'}</p></>}
          <div className="management-actions"><button className="button primary" disabled={busy || Boolean(editing && !employeeDirty)} aria-busy={busy}>{busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Guardar empleado'}</button>{!editing && <button type="button" className="button secondary" disabled={busy} onClick={closeForm}>Cancelar</button>}</div>
        </form>
        {editing && <>
          <section className="management-detail" aria-labelledby="access-title"><h2 id="access-title">Acceso</h2>{editing.active && <button type="button" className="button secondary" disabled={busy} onClick={() => void authorizePin(editing)}>{editing.pinReady ? 'Restablecer PIN' : 'Autorizar creación de PIN'}</button>}{(editing.pinReady || editing.googleLinked || invitation?.status !== 'pending' || !editing.active) && <p>{editing.pinReady && !editing.googleLinked && editing.active ? 'PIN en caja' : accessLabel(editing)}</p>}
            {!editing.active && <button type="button" className="button secondary" disabled={busy} onClick={() => void reactivateEmployee(editing)}>Reactivar empleado</button>}
            {invitation && <div className="management-invitation"><strong>{invitationLabel(invitation)}</strong><p>{invitationDetail(invitation)}</p></div>}
            {currentCode?.parameter === 'invite' && <p className="field-help">Comparte este enlace con {editing.name}. No se envía por correo automáticamente.</p>}
            {codeCard()}
            {editing.active && !editing.googleLinked && <>
              {invitation?.status === 'pending' && currentCode?.parameter !== 'invite' && <p className="field-help">El enlace sólo se muestra al crearlo. Renueva la invitación para obtener uno nuevo.</p>}
              <div className="management-actions">{(currentCode?.parameter !== 'invite' || invitation?.status !== 'pending') && <button type="button" className="button secondary" disabled={busy} onClick={() => void linkGoogle(editing)}>{invitation ? 'Renovar invitación' : 'Invitar a usar Google'}</button>}{invitation?.status === 'pending' && <button type="button" className="button secondary" disabled={busy} onClick={() => void revoke('invitation', invitation.id)}>Cancelar invitación</button>}</div>
              {!invitation && <p className="field-help">Crearás un enlace para compartirlo con el empleado.</p>}
            </>}
          </section>
          <div className="management-danger"><button type="button" className="management-text-button" disabled={busy} onClick={() => { setConfirmDelete(true); setError(''); setNotice(''); operation.current = null }}>Eliminar empleado</button></div>
        </>}
      </> : team && <>
        <div className="management-tabs" role="tablist" aria-label="Administrar personal y dispositivos">{(['employees', 'devices'] as const).map((item) => <button key={item} ref={(element) => { tabs.current[item] = element }} type="button" role="tab" tabIndex={tab === item ? 0 : -1} id={`management-${item}-tab`} aria-selected={tab === item} aria-controls={`management-${item}-panel`} className={tab === item ? 'selected' : ''} disabled={busy} onClick={() => selectTab(item)} onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return
          event.preventDefault()
          selectTab(event.key === 'Home' ? 'employees' : event.key === 'End' ? 'devices' : item === 'employees' ? 'devices' : 'employees', true)
        }}>{item === 'employees' ? 'Empleados' : 'Dispositivos'}</button>)}</div>
        <section hidden={tab !== 'employees'} id="management-employees-panel" role="tabpanel" aria-labelledby="management-employees-tab" className="management-section">
          <button ref={listButton} type="button" className="button primary" disabled={busy} onClick={() => openForm()}>Agregar empleado</button>
          <ul className="management-list" aria-label="Empleados">{employees.map((employee) => <li key={employee.id}><div><strong>{employee.name}</strong><p>{roles[employee.role]}. {accessLabel(employee)}</p></div><button type="button" className="button secondary" aria-label={`Administrar ${employee.name}`} disabled={busy} onClick={() => openForm(employee)}>Administrar</button></li>)}</ul>
          {!employees.length && <p className="management-empty">Aún no has agregado empleados.</p>}
          {deletedEmployees.length > 0 && <details className="management-deleted"><summary>Empleados eliminados</summary><p>Restaurar devuelve el acceso por PIN o Google que ya tenía. Los enlaces y las sesiones anteriores no se reactivan.</p><ul className="management-list" aria-label="Empleados eliminados">{deletedEmployees.map((employee) => <li key={employee.id}><div><strong>{employee.name}</strong><p>{roles[employee.role]}{employee.deletedAt ? `. Eliminado el ${date(employee.deletedAt)}` : ''}</p></div><button type="button" className="button secondary" aria-label={`Restaurar ${employee.name}`} disabled={busy} onClick={() => void employeeLifecycle(employee, 'restore_employee')}>Restaurar</button></li>)}</ul></details>}
        </section><section hidden={tab !== 'devices'} id="management-devices-panel" role="tabpanel" aria-labelledby="management-devices-tab" className="management-section"><p>Vincula una caja compartida para que los empleados entren con su PIN.</p>
          {codeCard()}
          <ul className="management-list" aria-label="Dispositivos">{team.devices.map((device) => <li key={device.id}><div><strong>{device.name}</strong><p>{device.registerName}{device.active ? '' : '. Sin acceso'}</p></div>{device.active && <button type="button" className="button secondary" aria-label={`Revocar dispositivo ${device.name}`} disabled={busy} onClick={() => void revoke('device', device.id)}>Revocar</button>}</li>)}</ul>
          {!team.devices.length && <p className="management-empty">No hay dispositivos vinculados.</p>}
          <button type="button" className="button secondary" disabled={busy} onClick={() => void pairing()}>Emparejar dispositivo</button>
        </section>
      </>}
    </>}
  </div>
}
