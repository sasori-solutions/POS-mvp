import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../../lib/account'
import type { OperationsCommand, OperationsResponses, OperationsSnapshot } from '../../lib/operations-contracts'
import { posRequest, type PosAccess } from '../../lib/pos'
import { accessErrorCodes } from '../../components/useCatalog'
import { parsePromotionCommand } from '../../../supabase/functions/account/promotion-validation'

type Mutation = Extract<OperationsCommand, { operationId: string }>
export type OperationOrigin = 'counter' | 'service'
type PendingOperation = { pending: Mutation | null; pendingOrigin: OperationOrigin | null }
const commands = new Set(['activate_operations', 'open_shift', 'cash_movement', 'begin_shift_close', 'abort_shift_close', 'close_shift', 'save_order', 'set_order_discount', 'cancel_order', 'send_order', 'set_kitchen_status', 'save_table', 'set_table_layout', 'move_order', 'close_order', 'begin_order_checkout', 'resume_order_service', 'update_checkout','record_checkout','record_payment','prepare_checkout', 'start_checkout', 'mark_checkout_uncertain', 'resolve_checkout', 'prepare_reversal', 'prepare_waiver', 'confirm_waiver', 'associate_service_tables', 'release_service_visit', 'continue_service_order', 'save_service_course', 'send_service_course', 'cancel_service_course', 'save_service_reservation', 'set_service_reservation_status', 'save_promotion', 'apply_order_promotion'])
const credentials = /"(?:operatorToken|deviceToken|pin|currentPin|confirmation|access_token|refresh_token|deviceProof|access|businessId|authSessionId|authorization|Authorization)"\s*:/

function parseOperation(value: string): PendingOperation {
  const record: unknown = JSON.parse(value)
  const invalid = () => new Error('El reintento guardado necesita revisión.')
  if (!record || typeof record !== 'object' || Array.isArray(record) || credentials.test(value) || credentials.test(JSON.stringify(record))) throw invalid()
  const saved = record as Record<string, unknown>
  let command: unknown = record
  let origin: OperationOrigin | null = null
  if ('payload' in saved || 'origin' in saved) {
    if (Object.keys(saved).length !== 2 || !Object.hasOwn(saved, 'payload') || !Object.hasOwn(saved, 'origin')
      || saved.origin !== 'counter' && saved.origin !== 'service') throw invalid()
    command = saved.payload
    origin = saved.origin
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw invalid()
  const item = command as Record<string, unknown>
  if (typeof item.command !== 'string' || !commands.has(item.command) || typeof item.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.operationId)
    || origin !== null && item.command !== 'save_order' || 'payload' in item || 'origin' in item) throw invalid()
  if (item.command === 'save_promotion' || item.command === 'apply_order_promotion') {
    try {
      // Validate the draft, but retain its exact accepted payload and UUID for replay.
      if (!parsePromotionCommand(item, [])) throw invalid()
    } catch { throw invalid() }
  }
  return { pending: command as Mutation, pendingOrigin: origin }
}
function readPendingOperation(key: string): PendingOperation {
  const value = localStorage.getItem(key)
  return value ? parseOperation(value) : { pending: null, pendingOrigin: null }
}

/** Recovery may carry local navigation origin; HTTP still receives the exact mutation. */
export function readOperation(key: string): Mutation | null {
  return readPendingOperation(key).pending
}

type MutationState = {
  scope: string
  pending: Mutation | null
  pendingOrigin: OperationOrigin | null
  busy: boolean
  error: string
  notice: string
  lastResult: { command: Mutation['command']; result: unknown } | null
}
const mutationState = (scope: string): MutationState => ({ scope, pending: null, pendingOrigin: null, busy: false, error: '', notice: '', lastResult: null })
const uncertainErrorCodes = new Set(['NETWORK_ERROR', 'SERVER_ERROR', 'OPERATION_CONFLICT', ...accessErrorCodes])

export function useOperationalMutation(access: PosAccess, employeeId: string, onSessionError?: (error: AccountClientError) => void) {
  const key = `pos-operations:${access.businessId}:${employeeId}`
  const scope = JSON.stringify([key, access.operatorToken, access.deviceToken ?? null])
  const [state, setState] = useState<MutationState>(() => mutationState(scope))
  const generation = useRef(0)
  const alive = useRef(false)
  const currentScope = useRef(scope); currentScope.current = scope
  const submitting = useRef<{ scope: string; generation: number } | null>(null)
  const errorHandler = useRef(onSessionError); errorHandler.current = onSessionError
  const visible = state.scope === scope ? state : mutationState(scope)
  const isCurrent = (run: { scope: string; generation: number }) => alive.current && currentScope.current === run.scope && generation.current === run.generation
  useEffect(() => {
    alive.current = true
    const run = { scope, generation: ++generation.current }
    const initial = mutationState(scope)
    try { Object.assign(initial, readPendingOperation(key)) } catch { initial.error = 'No pudimos leer el reintento guardado. Conserva este dispositivo y pide ayuda.' }
    setState(initial)
    const stored = (event: StorageEvent) => {
      if (event.key !== key || !isCurrent(run) || submitting.current?.generation === run.generation) return
      try {
        const pending = readPendingOperation(key)
        setState(previous => previous.scope === scope ? { ...previous, ...pending } : previous)
      } catch { setState(previous => previous.scope === scope ? { ...previous, error: 'No pudimos leer el reintento guardado.' } : previous) }
    }
    window.addEventListener('storage', stored)
    return () => { alive.current = false; generation.current++; window.removeEventListener('storage', stored) }
  }, [key, scope])
  async function execute<C extends Mutation['command']>(input: Extract<Mutation, { command: C }>, origin?: OperationOrigin): Promise<OperationsResponses[C]> {
    // Capture the exact JSON payload before a queued browser lock or caller edit can change it.
    const command = JSON.parse(JSON.stringify(input)) as Extract<Mutation, { command: C }>
    const run = { scope, generation: generation.current }
    const active = () => isCurrent(run)
    const assertCurrent = () => { if (!active()) throw new Error('La sesión cambió. Reabre la cuenta para revisar la solicitud guardada.') }
    const update = (patch: Partial<MutationState>) => { if (active()) setState(previous => previous.scope === scope ? { ...previous, ...patch } : previous) }
    assertCurrent()
    if (submitting.current?.scope === run.scope && submitting.current.generation === run.generation) throw new Error('Espera a que termine la solicitud actual.')
    submitting.current = run
    update({ busy: true, error: '', notice: '' })
    try {
      if (!navigator.onLine) throw new AccountClientError('NETWORK_ERROR', 'Sin conexión. Vuelve a conectar antes de continuar.')
      if (!navigator.locks) throw new Error('Abre el POS en un navegador actualizado para proteger los reintentos entre pestañas.')
      let persisted: PendingOperation | undefined
      await navigator.locks.request(key, () => {
        assertCurrent()
        const saved = readPendingOperation(key), stored = saved.pending
        if (stored && JSON.stringify(stored) !== JSON.stringify(command)) throw new Error('Resuelve el reintento pendiente antes de iniciar otra acción.')
        if (origin !== undefined && (command.command !== 'save_order' || origin !== 'counter' && origin !== 'service')) throw new Error('El origen del reintento necesita revisión.')
        if (origin !== undefined && saved.pendingOrigin !== null && saved.pendingOrigin !== origin) throw new Error('Conserva el origen de la solicitud guardada para reintentarla.')
        const pendingOrigin = saved.pendingOrigin ?? origin ?? null
        const value = JSON.stringify(pendingOrigin === null ? command : { payload: command, origin: pendingOrigin })
        const recovery = parseOperation(value)
        // One durable write couples origin to this exact UUID. Access never enters storage.
        localStorage.setItem(key, value)
        persisted = recovery
      })
      assertCurrent()
      if (!persisted) throw new Error('No pudimos guardar el reintento. Conserva este dispositivo y pide ayuda.')
      update(persisted)
      const result = await posRequest(access, command)
      // A closed scope cannot deliver money results or remove the recovery record it can no longer show.
      assertCurrent()
      const pending = await navigator.locks.request(key, () => {
        assertCurrent()
        if (readOperation(key)?.operationId === command.operationId) localStorage.removeItem(key)
        return readPendingOperation(key)
      })
      assertCurrent()
      update({ ...pending, notice: '', lastResult: { command: command.command, result } })
      return result as OperationsResponses[C]
    } catch (caught) {
      if (active()) {
        update({ error: caught instanceof Error ? caught.message : 'No pudimos confirmar la solicitud.' })
        if (caught instanceof AccountClientError && !uncertainErrorCodes.has(caught.code)) {
          // Only a current transactional refusal proves no effects. Auth is checked before replay,
          // so an expired/revoked session must retain the original uncertain payment UUID.
          try {
            const pending = await navigator.locks?.request(key, () => {
              assertCurrent()
              if (readOperation(key)?.operationId === command.operationId) localStorage.removeItem(key)
              return readPendingOperation(key)
            })
            assertCurrent()
            if (pending !== undefined) update(pending)
          } catch { /* Preserve recovery on storage failure or scope change. */ }
        }
        if (active() && caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
      }
      throw caught
    } finally {
      if (submitting.current === run) submitting.current = null
      update({ busy: false })
    }
  }
  return { execute, pending: visible.pending, pendingOrigin: visible.pendingOrigin, busy: visible.busy, error: visible.error, notice: visible.notice, lastResult: visible.lastResult, clearNotice: () => setState(previous => previous.scope === scope ? { ...previous, notice: '' } : previous) }
}
// Optional for existing consumers/fixtures; the live hook always returns the paired value.
export type OperationalMutation = Omit<ReturnType<typeof useOperationalMutation>, 'pendingOrigin'> & { pendingOrigin?: OperationOrigin | null }

type OperationsState = { scope: string; snapshot: OperationsSnapshot | null; error: string; refreshing: boolean }

export function useOperations(access: PosAccess, enabled: boolean, onSessionError?: (error: AccountClientError) => void) {
  const scope = JSON.stringify([access.businessId, access.operatorToken, access.deviceToken ?? null])
  const [state, setState] = useState<OperationsState>({ scope, snapshot: null, error: '', refreshing: enabled })
  const sequence = useRef(0)
  const alive = useRef(false)
  const currentScope = useRef(scope); currentScope.current = scope
  const currentEnabled = useRef(enabled); currentEnabled.current = enabled
  const errorHandler = useRef(onSessionError); errorHandler.current = onSessionError
  const refresh = useCallback(async () => {
    if (!enabled || !alive.current || !currentEnabled.current || currentScope.current !== scope) return
    const request = ++sequence.current
    const current = () => alive.current && currentEnabled.current && currentScope.current === scope && sequence.current === request
    setState(previous => ({ scope, snapshot: previous.scope === scope ? previous.snapshot : null, error: previous.scope === scope ? previous.error : '', refreshing: true }))
    try {
      const result = await posRequest(access, { command: 'operations' })
      if (current()) setState({ scope, snapshot: result, error: '', refreshing: false })
    } catch (caught) {
      if (!current()) return
      const sessionError = caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)
      setState(previous => ({ scope, snapshot: sessionError || previous.scope !== scope ? null : previous.snapshot, error: caught instanceof Error ? caught.message : 'No pudimos cargar la operación.', refreshing: false }))
      if (sessionError) errorHandler.current?.(caught as AccountClientError)
    }
  }, [scope, enabled])
  useEffect(() => {
    alive.current = true
    void refresh()
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh() }
    const timer = window.setInterval(focus, 10_000)
    window.addEventListener('online', focus); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    return () => { alive.current = false; sequence.current++; window.clearInterval(timer); window.removeEventListener('online', focus); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [refresh])
  // Data is never visible for a new operator, revoked scope, or disabled module.
  const visible = enabled && state.scope === scope ? state : null
  const snapshot = visible?.snapshot ?? null
  const refreshing = enabled && (visible?.refreshing ?? true)
  return { snapshot, error: visible?.error ?? '', loading: refreshing && !snapshot, refreshing, refresh }
}
