import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, CreditCard } from 'lucide-react'
import { AccountClientError } from '../lib/account'
import type { PointCommand, PointResponses, PointSettings } from '../lib/point-contracts'
import { pointRequest } from '../lib/point-client'
import type { PosAccess } from '../lib/pos'
import type { PointController } from './usePoint'
import { accessErrorCodes } from './useCatalog'

export default function PointSetup(props: Parameters<typeof PointSetupSession>[0]) {
  return <PointSetupSession key={`${props.access.businessId}:${props.access.operatorToken}:${props.access.deviceToken ?? ''}`} {...props} />
}

function PointSetupSession({ access, controller, onBack, onSessionError }: {
  access: PosAccess; controller: PointController; onBack: () => void; onSessionError?: (error: AccountClientError) => void
}) {
  const [resources, setResources] = useState<PointResponses['resources'] | null>(null)
  const [branchId, setBranchId] = useState(''), [registerId, setRegisterId] = useState(''), [serial, setSerial] = useState('')
  const [newBranch, setNewBranch] = useState(''), [newRegister, setNewRegister] = useState('')
  const [environment, setEnvironment] = useState<'live' | 'sandbox'>('sandbox')
  const [location, setLocation] = useState({street_name: '', street_number: '', city_name: '', state_name: '', latitude: '', longitude: '', reference: ''})
  const locationValid = Boolean(location.street_name.trim() && location.street_number.trim() && location.city_name.trim() && location.state_name.trim() && location.latitude.trim() && location.longitude.trim() && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude)) && Math.abs(Number(location.latitude)) <= 90 && Math.abs(Number(location.longitude)) <= 180)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const alive = useRef(true), running = useRef(false), heading = useRef<HTMLHeadingElement>(null)
  const settings = controller.settings
  const verifiedConnection = settings?.connection?.status === 'connected' && Boolean(settings.connection.verifiedAt)
  const ready = settings?.terminals.some(t => t.verified && !t.physicalStepsPending && t.mode === 'PDV' && t.active)
  useEffect(() => { alive.current = true; heading.current?.focus(); return () => { alive.current = false } }, [])
  useEffect(() => { if (verifiedConnection) void loadResources() }, [verifiedConnection])
  function failure(caught: unknown) {
    if (!alive.current) return
    setError(caught instanceof Error ? caught.message : 'No pudimos completar este paso.')
    if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
  }
  async function loadResources() {
    if (!alive.current) return
    try { const result = await pointRequest(access, { command: 'resources' }); if (alive.current) setResources(result) } catch (caught) { failure(caught) }
  }
  async function update(command: PointCommand, success: string) {
    if (running.current || !navigator.onLine) return
    running.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await pointRequest(access, command)
      if (!alive.current) return
      if (result && typeof result === 'object' && 'permissions' in result) controller.setSettings(result as PointSettings)
      else await controller.refresh()
      if (!alive.current) return
      setNotice(success); await loadResources()
    } catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function connect() {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try {
      const result = await pointRequest(access, { command: 'oauth_start', operationId: crypto.randomUUID(), environment })
      if (!alive.current) return
      const url = new URL(result.authorizationUrl)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('No pudimos abrir la autorización de Mercado Pago.')
      window.location.assign(url.href)
    } catch (caught) { failure(caught); running.current = false; if (alive.current) setBusy(false) }
  }
  const steps = [['Conectar Mercado Pago', verifiedConnection], ['Sucursal y caja', Boolean(settings?.terminals.length)], ['Vincular y probar terminal', ready], ['Activar cobros', settings?.enabled]] as const
  return <div className="point-setup ops-form max-w-160 [&_input]:min-h-12 [&_select]:min-h-12">
    <button className="back-button" onClick={onBack} disabled={busy}><ArrowLeft size={18} aria-hidden="true" />Volver</button>
    <h2 ref={heading} tabIndex={-1} className="text-2xl font-medium">Mercado Pago Point</h2>
    <p>Conecta tu cuenta y una terminal por caja. El dueño completa la vinculación física en Mercado Pago.</p>
    <ol className="point-steps grid grid-cols-2 gap-3 tablet:grid-cols-4" aria-label="Progreso del alta">{steps.map(([name, completed], index) => <li key={name} className="rounded-lg border border-line p-3 text-sm"><span className="flex min-h-8 items-center gap-2">{completed ? <Check size={18} aria-label="Completado" /> : <span aria-hidden="true">{index + 1}</span>}<strong>{name}</strong></span></li>)}</ol>
    {(error || controller.error) && <p className="text-danger" role="alert">{error || controller.error}</p>}
    {notice && <p role="status" aria-live="polite">{notice}</p>}
    {controller.loading && !settings && <p role="status">Consultando la configuración…</p>}
    {!settings && <button className="pos-button pos-secondary" disabled={controller.loading} onClick={() => void controller.refresh()}>Reintentar configuración</button>}
    {settings && !settings.permissions.manage ? <p>No tienes permiso para configurar esta integración. Pide ayuda al dueño.</p> : settings && <>
      <section className="ops-card"><h3>1. Cuenta de Mercado Pago</h3>
        <p>{verifiedConnection ? `Credenciales verificadas (${settings.connection!.environment === 'sandbox' ? 'sandbox' : 'producción'}).` : settings.connection?.status === 'revoked' ? 'La conexión fue revocada. Reconecta para iniciar cobros nuevos.' : settings.connection ? 'La conexión requiere verificación o reconexión.' : 'Aún no hay una cuenta conectada.'}</p>
        <label>Entorno<select value={environment} onChange={event => setEnvironment(event.target.value as 'live' | 'sandbox')} disabled={busy}><option value="sandbox">Sandbox de pruebas</option><option value="live">Producción (requiere piloto físico)</option></select></label>
        <button className="pos-button pos-primary" disabled={busy} onClick={() => void connect()}>{settings.connection ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago'}</button>
        {settings.connection && <button className="pos-button pos-secondary" disabled={busy} onClick={() => void update({ command: 'verify_connection' }, 'Conexión consultada. Revisa también la configuración de la terminal.')}>Verificar conexión</button>}
      </section>
      {verifiedConnection && <section className="ops-card"><h3>2. Sucursal y caja del proveedor</h3>
        <p>Elige recursos de esta cuenta. Una caja en modo PDV admite una sola terminal.</p>
        <label>Sucursal de Mercado Pago<select value={branchId} onChange={event => { setBranchId(event.target.value); setRegisterId('') }} disabled={busy}><option value="">Selecciona una sucursal</option>{resources?.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>
        <label>Caja de Mercado Pago<select value={registerId} onChange={event => setRegisterId(event.target.value)} disabled={busy || !branchId}><option value="">Selecciona una caja</option>{resources?.registers.filter(register => register.branchId === branchId).map(register => <option key={register.id} value={register.id}>{register.name}</option>)}</select></label>
        <details><summary>Crear sucursal o caja</summary><div className="ops-form">
          <label>Nombre de sucursal nueva<input value={newBranch} maxLength={100} onChange={event => setNewBranch(event.target.value)} disabled={busy} /></label>
          {([['street_name', 'Calle'], ['street_number', 'Número exterior'], ['city_name', 'Ciudad'], ['state_name', 'Estado'], ['latitude', 'Latitud real'], ['longitude', 'Longitud real'], ['reference', 'Referencia de ubicación (opcional)']] as const).map(([field, label]) => <label key={field}>{label}<input value={location[field]} maxLength={100} inputMode={field === 'latitude' || field === 'longitude' ? 'decimal' : 'text'} onChange={event => setLocation(previous => ({...previous, [field]: event.target.value}))} disabled={busy} /></label>)}
          <p className="text-sm">Usa las coordenadas verificadas de la sucursal. Revisa la ubicación antes de crearla.</p>
          <button className="pos-button pos-secondary" disabled={busy || !newBranch.trim() || !locationValid} onClick={() => void update({ command: 'create_branch', operationId: crypto.randomUUID(), name: newBranch.trim(), location: {...location, latitude: Number(location.latitude), longitude: Number(location.longitude)} }, 'Sucursal creada. Selecciónala para continuar.')}>Crear sucursal</button>
          <label>Nombre de caja nueva<input value={newRegister} maxLength={100} onChange={event => setNewRegister(event.target.value)} disabled={busy} /></label>
          <button className="pos-button pos-secondary" disabled={busy || !branchId || !newRegister.trim()} onClick={() => void update({ command: 'create_register', operationId: crypto.randomUUID(), branchId, name: newRegister.trim() }, 'Caja creada. Selecciónala para continuar.')}>Crear caja</button>
        </div></details>
      </section>}
      {verifiedConnection && <section className="ops-card"><h3>3. Terminal por serial</h3>
        <label>Serial de terminal<input value={serial} maxLength={100} onChange={event => setSerial(event.target.value)} disabled={busy} autoComplete="off" /></label>
        <button className="pos-button pos-primary" disabled={busy || !branchId || !registerId || !serial.trim()} onClick={() => void update({ command: 'link_terminal', operationId: crypto.randomUUID(), serial: serial.trim(), branchId, registerId }, 'Vínculo guardado. Completa los pasos físicos y verifica la terminal.')}>Vincular terminal a esta caja</button>
        <div className="rounded-lg bg-surface p-4 text-sm"><p>En la app de Mercado Pago, entra a tu terminal Point, selecciona esta sucursal y caja y habilita el modo PDV. Confirma los pasos en el equipo.</p><p className="mt-2">La app verifica la asignación y el modo. El proveedor no acredita presencia en línea con estos datos.</p></div>
        {settings.terminals.map(terminal => <div key={terminal.id} className="point-terminal rounded-lg border border-line p-4"><CreditCard size={22} aria-hidden="true" /><strong>{terminal.serial}</strong><p>{terminal.branchName} / {terminal.registerName}</p><p>{terminal.verified && terminal.mode === 'PDV' && !terminal.physicalStepsPending ? 'Asignación y modo PDV verificados' : 'Vinculación física o configuración pendiente'}</p><button className="pos-button pos-secondary" disabled={busy} onClick={() => void update({ command: 'test_terminal', terminalId: terminal.id }, 'Configuración consultada. Un cobro físico de piloto requiere ensayo en el equipo.')}>Probar configuración de terminal</button></div>)}
      </section>}
      <section className="ops-card"><h3>4. Activación</h3><p>{settings.enabled ? 'Cobros nuevos habilitados para este negocio.' : 'Cobros nuevos desactivados. La recuperación y conciliación siguen disponibles.'}</p>
        <p className="text-sm">La activación depende también de la configuración del entorno. Verificar configuración no acredita un cobro físico.</p>
        <button className="pos-button pos-primary" disabled={busy || !settings.enabled && (!verifiedConnection || !ready)} onClick={() => void update({ command: 'activate', enabled: !settings.enabled }, settings.enabled ? 'Cobros nuevos desactivados. Los intentos anteriores se conservan.' : 'Activación guardada.')}>{settings.enabled ? 'Desactivar cobros nuevos' : 'Activar tarjeta integrada'}</button>
      </section>
      {settings.connection && <details><summary>Desconectar cuenta</summary><p>Bloquea cobros nuevos y conserva los registros y la conciliación.</p><label className="ops-check"><input type="checkbox" checked={confirmDisconnect} onChange={event => setConfirmDisconnect(event.target.checked)} disabled={busy} /><span>Confirmo la desconexión.</span></label><button className="pos-button pos-secondary" disabled={busy || !confirmDisconnect} onClick={() => void update({ command: 'disconnect' }, 'Cuenta desconectada. La evidencia y los pendientes se conservan.')}>Desconectar Mercado Pago</button></details>}
    </>}
  </div>
}
