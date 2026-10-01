import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { accountRequest, AccountClientError } from '../lib/account'
import type { BusinessContext, BusinessRole, EmployeeSummary, AccountResponses } from '../lib/contracts'
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
type Code = { value: string; label: string; expiresAt: string; path: string; parameter: string }

export default function TeamPanel({ business, operatorToken, onBack, onSessionError }: TeamPanelProps) {
  const [team, setTeam] = useState<AccountResponses['team'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [denied, setDenied] = useState(business.role !== 'owner')
  const [form, setForm] = useState<'employee' | 'invitation' | null>(null)
  const [editing, setEditing] = useState<EmployeeSummary | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState<EmployeeRole>('cashier')
  const [active, setActive] = useState(true)
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [code, setCode] = useState<Code | null>(null)
  const mounted = useRef(true)
  const generation = useRef(0)
  const mutationBusy = useRef(false)
  const operation = useRef<{ fingerprint: string; id: string } | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; operation.current = null }
  }, [])

  function showError(caught: unknown) {
    if (!mounted.current) return
    const message = caught instanceof Error ? caught.message : 'No pudimos completar la solicitud. Intenta de nuevo.'
    setError(message)
    if (caught instanceof AccountClientError && sessionErrors.includes(caught.code)) {
      setDenied(true)
      setTeam(null)
      setCode(null)
      setPin('')
      setConfirmation('')
      operation.current = null
      onSessionError?.(caught)
    }
  }

  async function load() {
    const current = generation.current
    if (business.role !== 'owner') { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const result = await accountRequest({ action: 'team', businessId: business.id, operatorToken })
      if (mounted.current && current === generation.current) setTeam(result)
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) setLoading(false) }
  }

  useEffect(() => {
    generation.current += 1
    mutationBusy.current = false
    operation.current = null
    setBusy(false)
    setTeam(null)
    setCode(null)
    setForm(null)
    setPin('')
    setConfirmation('')
    setDenied(business.role !== 'owner')
    void load()
    return () => { generation.current += 1 }
  }, [business.id, business.role, operatorToken])

  function openForm(next: 'employee' | 'invitation', employee?: EmployeeSummary) {
    setForm(next)
    setEditing(employee ?? null)
    setName(employee?.name ?? '')
    setRole(employee && employee.role !== 'owner' ? employee.role : 'cashier')
    setActive(employee?.active ?? true)
    setPin('')
    setConfirmation('')
    setError('')
    setNotice('')
    operation.current = null
  }

  function operationId(payload: unknown) {
    const fingerprint = JSON.stringify(payload)
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() }
    return operation.current.id
  }

  async function saveEmployee(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutationBusy.current) return
    const employeeName = name.trim().replace(/\s+/g, ' ')
    if (employeeName.length < 2 || employeeName.length > 100) { setError('Escribe un nombre de 2 a 100 caracteres.'); return }
    if ((!editing || pin) && (!/^[0-9]{6}$/.test(pin) || pin !== confirmation)) {
      setError(pin !== confirmation ? 'Los PIN no coinciden.' : 'El PIN debe tener seis dígitos.')
      return
    }
    const current = generation.current
    mutationBusy.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (editing) {
        await accountRequest({ action: 'update_employee', businessId: business.id, operatorToken, employeeId: editing.id,
          name: employeeName, role, active, pin: pin || null })
      } else {
        const payload = { name: employeeName, role, pin }
        await accountRequest({ action: 'create_employee', businessId: business.id, operatorToken, ...payload, operationId: operationId(payload) })
      }
      if (!mounted.current || current !== generation.current) return
      setForm(null)
      operation.current = null
      setPin('')
      setConfirmation('')
      setNotice(editing ? 'Empleado actualizado.' : 'Empleado agregado. Ya puede entrar en una caja vinculada.')
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false); setPin(''); setConfirmation('') } }
  }

  async function createInvitation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mutationBusy.current) return
    const employeeName = name.trim().replace(/\s+/g, ' ')
    if (employeeName.length < 2 || employeeName.length > 100) { setError('Escribe un nombre de 2 a 100 caracteres.'); return }
    const current = generation.current
    mutationBusy.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = { name: employeeName, role }
      const result = await accountRequest({ action: 'create_invitation', businessId: business.id, operatorToken, ...payload, operationId: operationId(payload) })
      if (!mounted.current || current !== generation.current) return
      setCode({ value: result.invitationCode, label: 'Código de invitación', expiresAt: result.expiresAt, path: '/', parameter: 'invite' })
      setForm(null)
      operation.current = null
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function pairing() {
    if (mutationBusy.current) return
    const current = generation.current
    mutationBusy.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const payload = { action: 'create_pairing_code' }
      const result = await accountRequest({ action: 'create_pairing_code', businessId: business.id, operatorToken, operationId: operationId(payload) })
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
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (kind === 'invitation') await accountRequest({ action: 'revoke_invitation', businessId: business.id, operatorToken, invitationId: id })
      else await accountRequest({ action: 'revoke_device', businessId: business.id, operatorToken, deviceId: id })
      if (!mounted.current || current !== generation.current) return
      setNotice(kind === 'invitation' ? 'Invitación revocada.' : 'Dispositivo revocado. Sus operadores ya no pueden entrar.')
      if (kind === 'invitation') setCode(null)
      await load()
    } catch (caught) { if (current === generation.current) showError(caught) }
    finally { if (mounted.current && current === generation.current) { mutationBusy.current = false; setBusy(false) } }
  }

  async function copyCode() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${code.path}#${code.parameter}=${encodeURIComponent(code.value)}`)
      setNotice('Enlace copiado.')
    } catch { setError('No pudimos copiar el enlace. Puedes copiar el código del campo.') }
  }

  return <div className="management-shell">
    <button type="button" className="back-button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />Volver</button>
    <div className="management-heading"><h1>Personal y dispositivos</h1><p>{business.name}</p></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {notice && <p className="management-success" role="status">{notice}</p>}
    {denied ? <p className="management-warning">Sólo el dueño puede administrar el personal y las cajas.</p> : <>
      {loading && <div className="management-loading" role="status"><span className="loader" aria-hidden="true" />Cargando personal…</div>}
      {!loading && !team && <button type="button" className="button secondary" onClick={() => void load()}>Reintentar</button>}
      {code && <div className="management-code">
        <label htmlFor="management-code">{code.label}</label>
        <input id="management-code" value={code.value} readOnly onFocus={(event) => event.target.select()} />
        <p>Vence {new Date(code.expiresAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: business.timezone })}. Sólo se puede usar una vez.</p>
        <button type="button" className="button secondary" onClick={() => void copyCode()}>Copiar enlace</button>
        <button type="button" className="button secondary" onClick={() => setCode(null)}>Ocultar código</button>
      </div>}
      {form && <section className="management-section" aria-labelledby="employee-form-title">
        <h2 id="employee-form-title">{form === 'invitation' ? 'Nueva invitación' : editing ? 'Editar empleado' : 'Nuevo empleado'}</h2>
        <form className="management-form" onSubmit={form === 'invitation' ? createInvitation : saveEmployee}>
          <div className="field"><label htmlFor="employee-name">Nombre del empleado</label><input id="employee-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required disabled={busy} autoFocus /></div>
          <div className="field"><label htmlFor="employee-role">Rol</label><select id="employee-role" value={role} onChange={(event) => setRole(event.target.value as EmployeeRole)} disabled={busy}><option value="manager">Encargado</option><option value="cashier">Cajero</option><option value="kitchen">Cocina</option></select></div>
          <p className="field-help">{role === 'kitchen' ? 'Acceso a comandas, sin datos de dinero ni ajustes del dueño.' : role === 'cashier' ? 'Acceso a venta y comandas, sin ajustes del dueño ni costos.' : 'Acceso a operación, sin administrar personal ni datos del dueño.'}</p>
          {form === 'employee' && <>
            {editing && <p className="field-help">Deja el PIN vacío para conservar el actual.</p>}
            <div className="field"><label htmlFor="employee-pin">PIN del empleado</label><input id="employee-pin" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{6}" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} required={!editing} disabled={busy} /></div>
            <div className="field"><label htmlFor="employee-confirm">Confirmar PIN del empleado</label><input id="employee-confirm" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={confirmation} onChange={(event) => setConfirmation(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} required={!editing || Boolean(pin)} disabled={busy} /></div>
            {editing && <><label className="management-checkbox"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} disabled={busy} />Empleado activo</label>{!active && <p className="management-warning">Al guardar, se cerrará su acceso y no podrá volver a entrar.</p>}</>}
          </>}
          <div className="management-actions"><button className="button primary" disabled={busy} aria-busy={busy}>{busy ? 'Guardando…' : form === 'invitation' ? 'Generar invitación' : editing ? 'Guardar cambios' : 'Guardar empleado'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => { setForm(null); setPin(''); setConfirmation(''); operation.current = null }}>Cancelar</button></div>
        </form>
      </section>}
      {team && <>
        <section className="management-section" aria-labelledby="team-title"><h2 id="team-title">Personal</h2><p>Cada persona usa su propio PIN. El dueño conserva su acceso con Google.</p>
          <ul className="management-list">{team.employees.map((employee) => <li key={employee.id}><div><strong>{employee.name}</strong><p>{roles[employee.role]}{employee.active ? '' : ' (inactivo)'}</p></div>{employee.role !== 'owner' && <button type="button" className="button secondary" aria-label={`Editar ${employee.name}`} disabled={busy} onClick={() => openForm('employee', employee)}>Editar</button>}</li>)}</ul>
          {!team.employees.length && <p className="management-empty">Aún no has agregado empleados.</p>}
          <button type="button" className="button primary" disabled={busy} onClick={() => openForm('employee')}>Agregar empleado</button>
        </section>
        <section className="management-section" aria-labelledby="invitations-title"><h2 id="invitations-title">Invitaciones</h2><p>Comparte una invitación para que el empleado entre con Google y cree su PIN.</p>
          <ul className="management-list">{team.invitations.map((invitation) => <li key={invitation.id}><div><strong>{invitation.name}</strong><p>{roles[invitation.role]}{invitation.active ? new Date(invitation.expiresAt).getTime() <= Date.now() ? ' (vencida)' : '' : ' (revocada o utilizada)'}</p></div>{invitation.active && new Date(invitation.expiresAt).getTime() > Date.now() && <button type="button" className="button secondary" aria-label={`Revocar invitación de ${invitation.name}`} disabled={busy} onClick={() => void revoke('invitation', invitation.id)}>Revocar</button>}</li>)}</ul>
          {!team.invitations.length && <p className="management-empty">No hay invitaciones.</p>}
          <button type="button" className="button secondary" disabled={busy} onClick={() => openForm('invitation')}>Crear invitación</button>
        </section>
        <section className="management-section" aria-labelledby="devices-title"><h2 id="devices-title">Dispositivos</h2><p>Vincula una caja compartida. Los empleados pueden entrar allí sin dejar el Google del dueño.</p>
          <ul className="management-list">{team.devices.map((device) => <li key={device.id}><div><strong>{device.name}</strong><p>{device.registerName}{device.active ? '' : ' (revocado)'}</p></div>{device.active && <button type="button" className="button secondary" aria-label={`Revocar dispositivo ${device.name}`} disabled={busy} onClick={() => void revoke('device', device.id)}>Revocar</button>}</li>)}</ul>
          {!team.devices.length && <p className="management-empty">No hay dispositivos vinculados.</p>}
          <button type="button" className="button secondary" disabled={busy} onClick={() => void pairing()}>Emparejar dispositivo</button>
        </section>
      </>}
    </>}
  </div>
}
