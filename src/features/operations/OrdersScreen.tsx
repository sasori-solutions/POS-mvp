import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, ClipboardList, Play, Plus, ReceiptText } from 'lucide-react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { KitchenBatch, OperationalOrder, OperationsSnapshot } from '../../lib/operations-contracts'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import type { OperationalMutation } from './useOperations'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'
import LoadingPlaceholder, { PendingIndicator } from '../../components/LoadingPlaceholder'
import './operations-polish.css'

type KitchenStage = 'pending' | 'preparing' | 'completed'
const stages: [KitchenStage, string][] = [['pending', 'Pendientes'], ['preparing', 'En proceso'], ['completed', 'Completadas']]
const stageOf = (batch: KitchenBatch): KitchenStage => batch.status === 'delivered' || batch.fullyCancelled ? 'completed' : ['preparing', 'ready'].includes(batch.status) ? 'preparing' : 'pending'
type KitchenState = { scope: string; batches: KitchenBatch[]; loaded: boolean; error: string }

export default function OrdersScreen({ business, access, snapshot, mutation, onOrder, onNew, refresh, onSessionError }: { business: BusinessContext; access: PosAccess; snapshot: OperationsSnapshot; mutation: OperationalMutation; onOrder: (order: OperationalOrder) => void; onNew: () => void; refresh: () => Promise<void>; onSessionError?: (error: AccountClientError) => void }) {
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const accountsEnabled = business.profile.accountsEnabled !== false
  // Disabling new accounts never strands an account that still needs payment.
  const sections = [allowed('kitchen.read') ? 'Comandas' : '', allowed('orders.read') && (accountsEnabled || snapshot.orders.length > 0) ? 'Cuentas' : ''].filter(Boolean)
  const [tab, setTab] = useState(sections[0] ?? 'Comandas')
  const scope = JSON.stringify([access.businessId, access.operatorToken, access.deviceToken ?? null, business.role, business.permissions])
  const [state, setState] = useState<KitchenState>({ scope, batches: [], loaded: false, error: '' })
  const [stage, setStage] = useState<KitchenStage>('pending')
  const [updating, setUpdating] = useState<{ scope: string; batchId: string } | null>(null)
  const submitted = useRef<string | null>(null)
  const sequence = useRef(0)
  const currentScope = useRef(scope); currentScope.current = scope
  const alive = useRef(false)
  const errorHandler = useRef(onSessionError); errorHandler.current = onSessionError
  const visible = state.scope === scope ? state : { scope, batches: [], loaded: false, error: '' }
  const disabled = mutation.busy || Boolean(mutation.pending) || updating?.scope === scope
  const activeTab = sections.includes(tab) ? tab : sections[0]
  const visibleBatches = visible.batches.filter(batch => stageOf(batch) === stage)
  const canReadKitchen = allowed('kitchen.read')
  const kitchen = useCallback(async () => {
    if (!snapshot.enabled || !canReadKitchen) return
    const request = ++sequence.current
    const current = () => alive.current && currentScope.current === scope && sequence.current === request
    try {
      const result = await posRequest(access, { command: 'kitchen' })
      if (current()) setState({ scope, batches: result.batches, loaded: true, error: '' })
    } catch (caught) {
      if (!current()) return
      const sessionError = caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)
      setState(previous => ({ scope, batches: sessionError || previous.scope !== scope ? [] : previous.batches, loaded: !sessionError && previous.scope === scope && previous.loaded, error: caught instanceof Error ? caught.message : 'No pudimos cargar las comandas.' }))
      if (sessionError) errorHandler.current?.(caught as AccountClientError)
    }
  }, [scope, snapshot.enabled, canReadKitchen])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; sequence.current++ }
  }, [scope])
  useEffect(() => { void kitchen() }, [snapshot, kitchen])
  useEffect(() => {
    if (mutation.lastResult?.command !== 'set_kitchen_status') return
    const saved = mutation.lastResult.result as KitchenBatch
    setState(previous => previous.scope === scope ? { ...previous, batches: previous.batches.map(batch => batch.id === saved.id && saved.revision > batch.revision ? saved : batch) } : previous)
  }, [mutation.lastResult, scope])
  async function advance(batch: KitchenBatch) {
    if (disabled || submitted.current === scope || !allowed('kitchen.operate')) return
    submitted.current = scope
    setUpdating({ scope, batchId: batch.id })
    const next = batch.kind === 'cancellation' || batch.status !== 'queued' ? 'delivered' : 'preparing'
    try {
      const saved = await mutation.execute({ command: 'set_kitchen_status', operationId: crypto.randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: next })
      if (!alive.current || currentScope.current !== scope) return
      setState(previous => previous.scope === scope ? { ...previous, batches: previous.batches.map(item => item.id === saved.id && saved.revision > item.revision ? saved : item) } : previous)
      await kitchen()
      if (alive.current && currentScope.current === scope) await refresh()
    } catch { /* The persisted command remains recoverable in the shell. */ }
    finally {
      if (submitted.current === scope) submitted.current = null
      if (alive.current && currentScope.current === scope) setUpdating(null)
    }
  }
  return <div className="ops-section operations-polish orders-workspace">
    {!snapshot.enabled && <p className="operations-caption">Activa los turnos en Caja para comenzar.</p>}
    {sections.length > 1 && <div className="operations-segments orders-sections" role="group" aria-label="Comandas y cuentas">{sections.map(section => <button key={section} type="button" aria-pressed={activeTab === section} onClick={() => setTab(section)}>{section}</button>)}</div>}
    {activeTab === 'Cuentas' && <>
      <div className="operations-heading"><span className="operations-caption">{snapshot.orders.length} {snapshot.orders.length === 1 ? 'cuenta abierta' : 'cuentas abiertas'}</span>{accountsEnabled && allowed('orders.manage') && <button className="pos-button pos-primary operations-compact-action" disabled={disabled || !snapshot.enabled} onClick={() => onNew()}><Plus size={18} aria-hidden="true" />Abrir cuenta</button>}</div>
      {snapshot.orders.length ? <ul className="orders-account-list">{snapshot.orders.map(order => <li key={order.id}><button className="operations-record-button" onClick={() => onOrder(order)}><span className="operations-record-icon"><ReceiptText size={20} aria-hidden="true" /></span><div><strong>{order.name}</strong><small>{order.operatorName} · {order.balanceCents === 0 ? 'Sin saldo' : order.phase === 'checkout' ? 'Cobro parcial' : 'Por cobrar'}</small></div><strong>{money(order.balanceCents)}</strong><ChevronRight size={18} aria-hidden="true" /></button></li>)}</ul> : <div className="operations-empty"><ReceiptText size={28} strokeWidth={1.5} aria-hidden="true" /><h2>No hay cuentas abiertas</h2></div>}
    </>}
    {activeTab === 'Comandas' && <>
      <div className="comanda-stage-tabs" role="group" aria-label="Estado de comandas">{stages.map(([value, label]) => <button type="button" key={value} aria-pressed={stage === value} onClick={() => setStage(value)}><span>{label}</span>{visible.loaded && <span className="comanda-stage-count" aria-hidden="true">{visible.batches.filter(batch => stageOf(batch) === value).length}</span>}</button>)}</div>
      {visible.error && <div className="operations-error" role="alert"><p>{visible.error}</p><button className="pos-button pos-secondary" onClick={() => void kitchen()}>Reintentar</button></div>}
      {!visible.loaded && !visible.error && snapshot.enabled && <LoadingPlaceholder variant="cards" rows={4} label="Cargando comandas" />}
      <div className="ops-kitchen-grid operations-kitchen-grid">{visibleBatches.map(batch => {
        const currentStage = stageOf(batch)
        const working = updating?.scope === scope && updating.batchId === batch.id
        const label = batch.kind === 'cancellation' ? 'Confirmar cancelación' : currentStage === 'pending' ? 'Comenzar' : 'Completar'
        return <section className="ops-card comanda-card" key={batch.id} aria-label={`Comanda ${batch.orderName}`} aria-busy={working}>
        <div className="operations-heading comanda-heading"><div><h2>{batch.orderName}</h2>{batch.tableName && <span className="operations-caption">{batch.tableName}</span>}</div><time className="operations-caption" dateTime={batch.createdAt}>{new Intl.DateTimeFormat('es-MX', { timeStyle: 'short', timeZone: business.timezone }).format(new Date(batch.createdAt))}</time></div>
        <span className={`operations-status ${currentStage === 'completed' && !batch.fullyCancelled ? 'operations-status-active' : currentStage === 'preparing' ? 'operations-status-preparing' : ''}`}>{batch.fullyCancelled ? 'Cancelada' : currentStage === 'completed' ? 'Completada' : batch.kind === 'cancellation' ? 'Cancelación' : currentStage === 'preparing' ? 'En proceso' : 'Pendiente'}</span>
        {batch.reason && <p className="operations-caption">{batch.reason}</p>}
        <ul className="ops-list comanda-items">{batch.items.map(line => <li key={line.lineId}><span>
          <strong>{Math.max(0, line.quantity - (line.cancelledQuantity ?? 0))} × {line.name}</strong>
          {(line.cancelledQuantity ?? 0) > 0 && <small>Cantidad original: {line.quantity} · Canceladas: {line.cancelledQuantity}</small>}
          {line.selectionLabel && <small>{line.selectionLabel}</small>}{line.note && <small className="comanda-note">Nota: {line.note}</small>}
          {line.comboComponents?.map(component => <small key={component.productId}>{Math.max(0, line.quantity - (line.cancelledQuantity ?? 0)) * component.quantity} × {component.kitchenName || component.name}{component.selectionLabel ? ` · ${component.selectionLabel}` : ''}</small>)}
        </span></li>)}</ul>
        {allowed('kitchen.operate') && currentStage !== 'completed' && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void advance(batch)}>{working ? <PendingIndicator label="Actualizando comanda" /> : currentStage === 'pending' && batch.kind !== 'cancellation' ? <Play size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}{label}</button>}
      </section>})}</div>
      {visible.loaded && !visibleBatches.length && <div className="operations-empty"><ClipboardList size={28} strokeWidth={1.5} aria-hidden="true" /><h2>{stage === 'completed' ? 'No hay comandas completadas.' : stage === 'preparing' ? 'No hay comandas en proceso.' : 'No hay comandas pendientes.'}</h2></div>}
    </>}
  </div>
}
