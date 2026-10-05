import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, CreditCard, FlaskConical, Link2, Smartphone } from 'lucide-react'
import { AccountClientError } from '../lib/account'
import type { PointAvailableTerminal, PointCommand, PointResponses, PointSettings } from '../lib/point-contracts'
import { pointRequest } from '../lib/point-client'
import type { PosAccess } from '../lib/pos'
import type { PointController } from './usePoint'
import LoadingPlaceholder, { PendingIndicator } from './LoadingPlaceholder'
import { accessErrorCodes } from './useCatalog'
import './point-setup.css'

type SetupOperation = { payload: string; id: string }
function operationFor(ref: { current: SetupOperation | null }, payload: unknown): string {
  const fingerprint = JSON.stringify(payload)
  if (ref.current?.payload !== fingerprint) ref.current = { payload: fingerprint, id: crypto.randomUUID() }
  return ref.current.id
}

export default function PointSetup(props: Parameters<typeof PointSetupSession>[0]) {
  return <PointSetupSession key={`${props.access.businessId}:${props.access.operatorToken}:${props.access.deviceToken ?? ''}`} {...props} />
}

function PointSetupSession({ access, controller, onSessionError, onStartSale, onOpenCash, onOpenPaymentMethods, onBack, readyToCharge = true, paymentMethodEnabled = true }: {
  access: PosAccess; controller: PointController; onBack?: () => void; onStartSale?: () => void; onOpenCash?: () => void; onOpenPaymentMethods?: () => void; readyToCharge?: boolean; paymentMethodEnabled?: boolean; onSessionError?: (error: AccountClientError) => void
}) {
  const settings = controller.settings
  const connection = settings?.connection
  const connected = connection?.status === 'connected'
  const verified = connected && Boolean(connection.verifiedAt)
  const [environment, setEnvironment] = useState<'live' | 'sandbox'>(connection?.environment ?? 'sandbox')
  const sandbox = connected ? connection!.environment === 'sandbox' : environment === 'sandbox'
  const officialSandbox = sandbox && settings?.sandbox?.official === true
  const sandboxOperation = useRef(crypto.randomUUID())
  const [resources, setResources] = useState<PointResponses['resources'] | null>(null)
  const [resourcesBusy, setResourcesBusy] = useState(false), [resourcesError, setResourcesError] = useState('')
  const [branchId, setBranchId] = useState(''), [registerId, setRegisterId] = useState(''), [serial, setSerial] = useState('')
  const normalizedSerial = serial.trim()
  const readyTerminals = settings?.terminals.filter(t => t.verified && t.active && t.mode === 'PDV' && !t.physicalStepsPending) ?? []
  const readyTerminal = readyTerminals.find(t => t.serial === normalizedSerial) ?? readyTerminals[0]
  const [manual, setManual] = useState(false), [changingTerminal, setChangingTerminal] = useState(false)
  const [newBranch, setNewBranch] = useState(''), [newRegister, setNewRegister] = useState('')
  const branchOperation = useRef<SetupOperation | null>(null), registerOperation = useRef<SetupOperation | null>(null)
  const [location, setLocation] = useState({ street_name: '', street_number: '', city_name: '', state_name: '', latitude: '', longitude: '', reference: '' })
  const locationValid = Boolean(location.street_name.trim() && location.street_number.trim() && location.city_name.trim() && location.state_name.trim() && location.latitude.trim() && location.longitude.trim() && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude)) && Math.abs(Number(location.latitude)) <= 90 && Math.abs(Number(location.longitude)) <= 180)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [needsTestBusiness, setNeedsTestBusiness] = useState(false)
  const [online, setOnline] = useState(navigator.onLine), [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const alive = useRef(true), running = useRef(false), resourceRequest = useRef(0), verification = useRef('')
  const stepHeading = useRef<HTMLHeadingElement>(null)
  const connectionKey = `${connection?.id ?? ''}:${connection?.environment ?? ''}:${connection?.status ?? ''}:${connection?.verifiedAt ?? ''}:${settings?.permissions.manage}`
  const currentConnection = useRef(connectionKey); currentConnection.current = connectionKey
  const step = !verified ? 0 : !readyTerminal || changingTerminal ? 1 : 2
  const needsPaymentMethod = Boolean(settings?.enabled && !paymentMethodEnabled)
  const chargesPaused = settings?.chargesEnabled === false
  const activationComplete = Boolean(settings?.enabled && readyTerminal && paymentMethodEnabled && !chargesPaused)
  const realModeHint = settings?.sandbox?.testBusiness ? 'Este negocio conserva las pruebas. Para cobros reales, usa un negocio aparte.'
    : settings?.availableEnvironment !== undefined && settings.availableEnvironment !== 'live' ? 'Los cobros reales todavía no están habilitados.' : ''
  const disabled = busy || !online
  const linked = settings?.terminals.find(t => t.serial === normalizedSerial && t.branchId === branchId && t.registerId === registerId)
  const selected = resources?.terminals.find(t => t.serial === normalizedSerial)
  const selectionReady = Boolean(normalizedSerial && branchId && registerId)

  useEffect(() => {
    alive.current = true
    const network = () => setOnline(navigator.onLine)
    window.addEventListener('online', network); window.addEventListener('offline', network)
    return () => { alive.current = false; resourceRequest.current++; window.removeEventListener('online', network); window.removeEventListener('offline', network) }
  }, [])
  useEffect(() => { if (connection) setEnvironment(connection.environment) }, [connection?.id, connection?.environment])
  useEffect(() => { stepHeading.current?.focus() }, [step, Boolean(settings)])
  useEffect(() => {
    resourceRequest.current++
    setResources(null); setResourcesBusy(false); setResourcesError(''); setBranchId(''); setRegisterId(''); setSerial('')
    if (verified && settings?.permissions.manage) void loadResources(true)
  }, [connectionKey])
  useEffect(() => {
    if (!connected || verified || !settings?.permissions.manage || !online || running.current || verification.current === connectionKey) return
    verification.current = connectionKey
    void update({ command: 'verify_connection' })
  }, [connectionKey, online])

  function failure(caught: unknown, command?: PointCommand['command']) {
    if (!alive.current) return
    const testBusinessRequired = command === 'connect_sandbox' && caught instanceof AccountClientError && caught.code === 'POINT_STATE_INVALID'
    setNeedsTestBusiness(testBusinessRequired)
    setError(testBusinessRequired ? 'Usa un negocio nuevo, sin ventas previas, para vincular la terminal virtual.' : caught instanceof Error ? caught.message : 'No pudimos completar este paso. Inténtalo de nuevo.')
    if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
  }
  function selectTerminal(terminal: PointAvailableTerminal) {
    setManual(false); setSerial(terminal.serial); setBranchId(terminal.branchId); setRegisterId(terminal.registerId); setError('')
  }
  async function loadResources(resetSelection = false) {
    if (!alive.current || !navigator.onLine) return
    const request = ++resourceRequest.current, key = currentConnection.current
    const current = () => alive.current && request === resourceRequest.current && key === currentConnection.current
    setResourcesBusy(true); setResourcesError('')
    try {
      const result = await pointRequest(access, { command: 'resources' })
      if (!current()) return
      setResources(result)
      // A single discovered terminal is a complete choice, not a guessed device.
      if (result.terminals.length === 1 && (resetSelection || !serial)) selectTerminal(result.terminals[0])
      else if ((resetSelection || !branchId) && result.branches.length === 1) {
        setBranchId(result.branches[0].id)
        const registers = result.registers.filter(item => item.branchId === result.branches[0].id)
        if (registers.length === 1) setRegisterId(registers[0].id)
      }
    } catch (caught) {
      if (!current()) return
      setResourcesError(caught instanceof Error ? caught.message : 'No pudimos buscar las terminales.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
    } finally { if (current()) setResourcesBusy(false) }
  }
  async function update(command: PointCommand, success = ''): Promise<PointSettings | null> {
    if (running.current || !navigator.onLine) return null
    running.current = true; setBusy(true); setError(''); setNotice(''); setNeedsTestBusiness(false)
    try {
      const result = await pointRequest(access, command)
      if (!alive.current) return null
      if (result && typeof result === 'object' && 'permissions' in result) {
        const next = result as PointSettings
        controller.setSettings(next)
        if (command.command === 'activate' && command.enabled) setChangingTerminal(false)
        if (command.command === 'test_terminal' && next.terminals.some(t => t.id === command.terminalId && t.verified && t.active && t.mode === 'PDV' && !t.physicalStepsPending)) setChangingTerminal(false)
        if (command.command === 'disconnect') { setConfirmDisconnect(false); setChangingTerminal(false) }
        setNotice(success)
        return next
      }
      await loadResources()
      if (alive.current) setNotice(success)
      return null
    } catch (caught) { failure(caught, command.command); return null }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function connect() {
    if (running.current || !navigator.onLine) return
    running.current = true; setBusy(true); setError(''); setNeedsTestBusiness(false)
    try {
      const result = await pointRequest(access, { command: 'oauth_start', operationId: crypto.randomUUID(), environment })
      if (!alive.current) return
      const url = new URL(result.authorizationUrl)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('No pudimos abrir Mercado Pago.')
      window.location.assign(url.href)
    } catch (caught) { failure(caught); running.current = false; if (alive.current) setBusy(false) }
  }
  function createRegister() {
    const payload = { branchId, name: newRegister.trim() }
    void update({ command: 'create_register', operationId: operationFor(registerOperation, payload), ...payload }, 'Caja creada. Ya puedes seleccionarla.')
  }
  function createBranch() {
    const payload = { name: newBranch.trim(), location: { ...location, latitude: Number(location.latitude), longitude: Number(location.longitude) } }
    void update({ command: 'create_branch', operationId: operationFor(branchOperation, payload), ...payload }, 'Sucursal creada. Ya puedes seleccionarla.')
  }
  const stepNames = ['Cuenta', 'Terminal', 'Listo']
  const busyIcon = busy ? <PendingIndicator label="Guardando vinculación" /> : null
  const locationFields = ([['street_name', 'Calle'], ['street_number', 'Número'], ['city_name', 'Ciudad'], ['state_name', 'Estado'], ['latitude', 'Latitud'], ['longitude', 'Longitud'], ['reference', 'Referencia (opcional)']] as const)

  return <div className="terminal-setup">
    {onBack && <div className="terminal-settings-heading"><button type="button" className="terminal-text-button" onClick={onBack} disabled={busy}><ChevronLeft size={18} aria-hidden="true" />Configuración</button><h2>Vincular una terminal</h2></div>}
    <div className="terminal-provider"><span><CreditCard size={20} aria-hidden="true" />Mercado Pago</span>{sandbox && <span className="terminal-test-badge"><FlaskConical size={15} aria-hidden="true" />Modo prueba</span>}</div>
    <ol className="terminal-progress" aria-label="Pasos para vincular una terminal">{stepNames.map((name, index) => <li key={name} data-complete={index < step || index === 2 && activationComplete} aria-current={step === index ? 'step' : undefined}><span aria-hidden="true">{index < step || index === 2 && activationComplete ? <Check size={15} /> : index + 1}</span>{name}</li>)}</ol>
    {!online && <p role="alert" className="terminal-error">Sin conexión. Tus avances están guardados.</p>}
    {(error || controller.error) && <p role="alert" className="terminal-error">{error || controller.error}</p>}
    {notice && <p role="status" className="terminal-notice">{notice}</p>}
    {!settings ? controller.loading ? <LoadingPlaceholder variant="form" rows={2} label="Cargando vinculación" /> : <button className="pos-button pos-secondary" disabled={!online} onClick={() => void controller.refresh()}>Reintentar</button>
      : !settings.permissions.manage ? <p>El dueño del negocio puede vincular una terminal.</p> : <>
      <section className="terminal-stage" key={step} aria-labelledby="terminal-step-heading">
        <header className="terminal-stage-heading"><span className="terminal-stage-icon" aria-hidden="true">{step === 0 ? <Link2 size={26} /> : step === 1 ? <Smartphone size={26} /> : <Check size={26} />}</span>
          <h2 ref={stepHeading} tabIndex={-1} id="terminal-step-heading">{step === 0 ? 'Conecta tu cuenta' : step === 1 ? 'Elige tu terminal' : chargesPaused ? 'Cobros pausados' : needsPaymentMethod ? 'Habilita Tarjeta' : settings.enabled ? 'Todo listo para cobrar' : 'Activa tu terminal'}</h2>
          <p>{step === 0 ? 'Autoriza a tu negocio para enviar cobros a Mercado Pago.' : step === 1 ? sandbox ? 'Selecciona una terminal para los cobros de prueba.' : 'Estas terminales pertenecen a tu cuenta de Mercado Pago.' : chargesPaused ? 'Los cobros con terminal están pausados. Los pagos pendientes se siguen consultando.' : needsPaymentMethod ? 'Actívalo en Configuración → Formas de pago y guarda los cambios.' : settings.enabled ? sandbox ? 'Prueba el cobro completo sin mover dinero.' : 'El importe se enviará desde la pantalla de cobro.' : sandbox ? 'Los pagos de este modo son de prueba.' : 'Confirma esta terminal para recibir cobros.'}</p>
        </header>
        {step === 0 ? <>
          {!connected && <div className="terminal-mode" role="group" aria-label="Modo de vinculación">{(['sandbox', 'live'] as const).map(mode => <button type="button" key={mode} aria-pressed={environment === mode} disabled={disabled || mode === 'live' && (settings.sandbox?.testBusiness === true || settings.availableEnvironment !== undefined && settings.availableEnvironment !== 'live')} onClick={() => { setEnvironment(mode); setError(''); setNeedsTestBusiness(false) }}>{mode === 'sandbox' ? 'Pruebas' : 'Cobros reales'}</button>)}</div>}
          {!connected && realModeHint && <p className="terminal-context">{realModeHint}</p>}
          {sandbox && <p className="terminal-context">{officialSandbox ? settings?.sandbox?.available ? 'Se vinculará una terminal virtual. Usa un negocio nuevo dedicado a pruebas.' : 'El simulador oficial necesita las credenciales de prueba de tu aplicación de Mercado Pago.' : 'Usa la cuenta y la terminal de prueba disponibles en este entorno.'}</p>}
          {connected ? <button className="pos-button pos-primary terminal-primary" disabled={disabled} onClick={() => void update({ command: 'verify_connection' })}>{busyIcon}Verificar cuenta</button>
            : officialSandbox ? <><button className="pos-button pos-primary terminal-primary" disabled={disabled || !settings.sandbox?.available} onClick={() => void update({ command: 'connect_sandbox', operationId: sandboxOperation.current })}>{busyIcon}Vincular terminal virtual</button>{needsTestBusiness && <a className="terminal-text-button" href="/business/new">Crear negocio de pruebas</a>}{!settings.sandbox?.available && <a className="terminal-text-button" href="https://www.mercadopago.com.mx/developers/es/docs/mp-point/create-application" target="_blank" rel="noopener noreferrer">Crear aplicación de Mercado Pago</a>}</>
            : <button className="pos-button pos-primary terminal-primary" disabled={disabled} onClick={() => void connect()}>{busyIcon}{connection ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago'}</button>}
        </> : step === 1 ? <>
          <div className="terminal-connected"><Check size={17} aria-hidden="true" /><span>Cuenta conectada</span></div>
          {resourcesBusy && !resources ? <LoadingPlaceholder variant="list" rows={2} label="Buscando terminales" /> : <>
            {resourcesError && <div className="terminal-resource-error" role="alert"><p>{resourcesError}</p><button className="terminal-text-button" disabled={disabled || resourcesBusy} onClick={() => void loadResources()}>Buscar de nuevo</button></div>}
            {resources && !resources.terminals.length && <p className="terminal-context">No encontramos terminales en esta cuenta. Vincula una desde Mercado Pago y vuelve a buscar.</p>}
            {!!resources?.terminals.length && <div className="terminal-options" role="group" aria-label="Terminales disponibles">{resources.terminals.map(terminal => <button type="button" className="terminal-option" key={terminal.id} aria-pressed={!manual && serial === terminal.serial} disabled={disabled} onClick={() => selectTerminal(terminal)}><Smartphone size={24} aria-hidden="true" /><span><strong>{sandbox ? 'Terminal de prueba' : terminal.serial}</strong><small>{[terminal.branchName, terminal.registerName].filter(Boolean).join(' / ') || terminal.serial}</small>{sandbox && <small>{terminal.serial}</small>}</span><span className="terminal-selection" aria-hidden="true">{!manual && serial === terminal.serial && <Check size={15} />}</span></button>)}</div>}
            {(manual || selected && (!selected.branchId || !selected.registerId)) && <div className="terminal-fields"><label>Número de serie<input value={serial} maxLength={100} onChange={event => setSerial(event.target.value)} autoComplete="off" disabled={disabled} /></label></div>}
            {(manual || selected) && <details className="terminal-adjustments" open={manual || !branchId || !registerId ? true : undefined}><summary>{branchId && registerId ? 'Sucursal y caja' : 'Seleccionar sucursal y caja'}<ChevronDown size={17} aria-hidden="true" /></summary><div className="terminal-fields terminal-field-pair"><label>Sucursal<select value={branchId} disabled={disabled || !resources} onChange={event => { setBranchId(event.target.value); setRegisterId('') }}><option value="">Selecciona una sucursal</option>{resources?.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label><label>Caja<select value={registerId} disabled={disabled || !branchId || !resources} onChange={event => setRegisterId(event.target.value)}><option value="">Selecciona una caja</option>{resources?.registers.filter(register => register.branchId === branchId).map(register => <option key={register.id} value={register.id}>{register.name}</option>)}</select></label></div></details>}
            {linked ? <>
              <p className="terminal-context">{sandbox ? 'Comprueba la configuración de la terminal de prueba.' : 'En la terminal, confirma la sucursal y caja y activa el modo Punto de venta.'}</p>
              <button className="pos-button pos-primary terminal-primary" disabled={disabled} onClick={() => void update({ command: 'test_terminal', terminalId: linked.id })}>{busyIcon}Comprobar terminal</button>
            </> : <button className="pos-button pos-primary terminal-primary" disabled={disabled || !selectionReady} onClick={() => void update({ command: 'link_terminal', operationId: crypto.randomUUID(), serial: serial.trim(), branchId, registerId })}>{busyIcon}Vincular terminal</button>}
            <details className="terminal-adjustments"><summary>No encuentro mi terminal<ChevronDown size={17} aria-hidden="true" /></summary><p>Vincúlala a una sucursal y caja en tu cuenta de Mercado Pago.</p><div className="terminal-inline-actions"><button className="terminal-text-button" disabled={disabled || resourcesBusy} onClick={() => void loadResources()}>Buscar de nuevo</button><button className="terminal-text-button" disabled={disabled} onClick={() => setManual(true)}>Usar número de serie</button></div></details>
            <details className="terminal-adjustments"><summary>Crear sucursal o caja<ChevronDown size={17} aria-hidden="true" /></summary><div className="terminal-fields"><label>Nombre de la nueva caja<input value={newRegister} maxLength={100} onChange={event => setNewRegister(event.target.value)} disabled={disabled} /></label><button className="pos-button pos-secondary" disabled={disabled || !branchId || !newRegister.trim()} onClick={createRegister}>Crear caja</button><details><summary>Crear una sucursal</summary><div className="terminal-fields"><label>Nombre de la sucursal<input value={newBranch} maxLength={100} onChange={event => setNewBranch(event.target.value)} disabled={disabled} /></label><div className="terminal-field-pair">{locationFields.map(([field, label]) => <label key={field}>{label}<input value={location[field]} maxLength={100} inputMode={field === 'latitude' || field === 'longitude' ? 'decimal' : 'text'} onChange={event => setLocation(previous => ({ ...previous, [field]: event.target.value }))} disabled={disabled} /></label>)}</div><button className="pos-button pos-secondary" disabled={disabled || !newBranch.trim() || !locationValid} onClick={createBranch}>Crear sucursal</button></div></details></div></details>
          </>}
        </> : <>
          {readyTerminal && <div className="terminal-ready"><Smartphone size={28} aria-hidden="true" /><div><strong>{sandbox ? 'Terminal de prueba' : readyTerminal.serial}</strong><span>{readyTerminal.branchName} / {readyTerminal.registerName}</span><small>{sandbox ? readyTerminal.serial : 'Configuración verificada'}</small></div><Check size={19} aria-hidden="true" /></div>}
          <div className="terminal-checkout-preview" aria-label="Cómo funciona el cobro"><span>Selecciona Tarjeta</span><ChevronDown size={16} aria-hidden="true" /><span>Envía el importe a la terminal</span><ChevronDown size={16} aria-hidden="true" /><span>El pago aprobado se registra solo</span></div>
          {settings.enabled && paymentMethodEnabled && !readyToCharge && <p className="terminal-context">Abre un turno en Caja para hacer el primer cobro.</p>}
          {chargesPaused ? <button className="pos-button pos-primary terminal-primary" disabled>Cobros pausados</button> : needsPaymentMethod ? <button className="pos-button pos-primary terminal-primary" disabled={disabled || !onOpenPaymentMethods} onClick={onOpenPaymentMethods}>Configurar formas de pago</button> : settings.enabled ? onStartSale && <button className="pos-button pos-primary terminal-primary" disabled={disabled} onClick={!readyToCharge && onOpenCash ? onOpenCash : onStartSale}>{!readyToCharge && onOpenCash ? 'Ir a Caja' : sandbox ? 'Probar un cobro' : 'Ir a Venta'}</button> : <button className="pos-button pos-primary terminal-primary" disabled={disabled} onClick={() => void update({ command: 'activate', enabled: true })}>{busyIcon}{sandbox ? 'Activar modo prueba' : 'Activar cobros'}</button>}
          {!settings.sandbox?.testBusiness && <button className="terminal-text-button" disabled={disabled} onClick={() => setChangingTerminal(true)}>Vincular otra terminal</button>}
        </>}
      </section>
      {connection && <details className="terminal-management"><summary>Administrar conexión<ChevronDown size={17} aria-hidden="true" /></summary><div className="terminal-management-body"><span>{connection.environment === 'sandbox' ? 'Cuenta de pruebas' : 'Cuenta para cobros reales'}</span>
        {settings.sandbox?.testBusiness && <><p>{realModeHint}</p><a className="terminal-text-button" href="/business/new">Crear negocio real</a></>}
        {settings.enabled && <button className="terminal-text-button" disabled={disabled} onClick={() => void update({ command: 'activate', enabled: false }, 'Cobros nuevos pausados.')}>Pausar cobros nuevos</button>}
        <p>Los pagos pendientes y su historial se conservan al desconectar.</p>
        {confirmDisconnect ? <div className="terminal-inline-actions"><button className="terminal-text-button terminal-danger" disabled={disabled} onClick={() => void update({ command: 'disconnect' }, 'Cuenta desconectada.')}>Desconectar cuenta</button><button className="terminal-text-button" disabled={disabled} onClick={() => setConfirmDisconnect(false)}>Cancelar</button></div> : <button className="terminal-text-button" disabled={disabled} onClick={() => setConfirmDisconnect(true)}>Desconectar Mercado Pago</button>}
      </div></details>}
    </>}
  </div>
}
