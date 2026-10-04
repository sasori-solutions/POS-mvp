import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../../lib/account'
import type { OperationsCommand, OperationsResponses, OperationsSnapshot } from '../../lib/operations-contracts'
import { posRequest, type PosAccess } from '../../lib/pos'
import { accessErrorCodes } from '../../components/useCatalog'

type Mutation = Extract<OperationsCommand, { operationId: string }>
const commands = new Set(['activate_operations', 'open_shift', 'cash_movement', 'begin_shift_close', 'abort_shift_close', 'close_shift', 'save_order', 'set_order_discount', 'cancel_order', 'send_order', 'set_kitchen_status', 'save_table', 'move_order', 'close_order', 'begin_order_checkout', 'resume_order_service', 'update_checkout','record_checkout','record_payment','prepare_checkout', 'start_checkout', 'mark_checkout_uncertain', 'resolve_checkout', 'prepare_reversal', 'prepare_waiver', 'confirm_waiver'])

/** The only durable operational payload is a mutation, never its access envelope. */
export function readOperation(key: string): Mutation | null {
  const value = localStorage.getItem(key)
  if (!value) return null
  const command: unknown = JSON.parse(value)
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error('El reintento guardado necesita revisión.')
  const item = command as Record<string, unknown>
  if (!commands.has(String(item.command)) || typeof item.operationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.operationId)
    || /"(?:operatorToken|deviceToken|pin|access_token|deviceProof)"\s*:/.test(value)) throw new Error('El reintento guardado necesita revisión.')
  return command as Mutation
}

type MutationState = {
  scope: string
  pending: Mutation | null
  busy: boolean
  error: string
  notice: string
  lastResult: { command: Mutation['command']; result: unknown } | null
}
const mutationState = (scope: string): MutationState => ({ scope, pending: null, busy: false, error: '', notice: '', lastResult: null })
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
    try { initial.pending = readOperation(key) } catch { initial.error = 'No pudimos leer el reintento guardado. Conserva este dispositivo y pide ayuda.' }
    setState(initial)
    const stored = (event: StorageEvent) => {
      if (event.key !== key || !isCurrent(run) || submitting.current?.generation === run.generation) return
      try {
        const pending = readOperation(key)
        setState(previous => previous.scope === scope ? { ...previous, pending } : previous)
      } catch { setState(previous => previous.scope === scope ? { ...previous, error: 'No pudimos leer el reintento guardado.' } : previous) }
    }
    window.addEventListener('storage', stored)
    return () => { alive.current = false; generation.current++; window.removeEventListener('storage', stored) }
  }, [key, scope])
  async function execute<C extends Mutation['command']>(input: Extract<Mutation, { command: C }>): Promise<OperationsResponses[C]> {
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
      await navigator.locks.request(key, () => {
        assertCurrent()
        const stored = readOperation(key)
        if (stored && JSON.stringify(stored) !== JSON.stringify(command)) throw new Error('Resuelve el reintento pendiente antes de iniciar otra acción.')
        localStorage.setItem(key, JSON.stringify(command))
      })
      assertCurrent()
      update({ pending: command })
      const result = await posRequest(access, command)
      // A closed scope cannot deliver money results or remove the recovery record it can no longer show.
      assertCurrent()
      const pending = await navigator.locks.request(key, () => {
        assertCurrent()
        if (readOperation(key)?.operationId === command.operationId) localStorage.removeItem(key)
        return readOperation(key)
      })
      assertCurrent()
      update({ pending, notice: '', lastResult: { command: command.command, result } })
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
              return readOperation(key)
            })
            assertCurrent()
            if (pending !== undefined) update({ pending })
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
  return { execute, pending: visible.pending, busy: visible.busy, error: visible.error, notice: visible.notice, lastResult: visible.lastResult, clearNotice: () => setState(previous => previous.scope === scope ? { ...previous, notice: '' } : previous) }
}
export type OperationalMutation = ReturnType<typeof useOperationalMutation>

export function useOperations(access: PosAccess, enabled: boolean, onSessionError?: (error: AccountClientError) => void) {
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(enabled)
  const sequence = useRef(0)
  const errorHandler = useRef(onSessionError); errorHandler.current = onSessionError
  const refresh = useCallback(async () => {
    if (!enabled) return
    const request = ++sequence.current
    setLoading(true)
    try {
      const result = await posRequest(access, { command: 'operations' })
      if (sequence.current === request) { setSnapshot(result); setError('') }
    } catch (caught) {
      if (sequence.current !== request) return
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar la operación.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
    } finally { if (sequence.current === request) setLoading(false) }
  }, [access.businessId, access.operatorToken, access.deviceToken, enabled])
  useEffect(() => {
    setSnapshot(null)
    void refresh()
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh() }
    const timer = window.setInterval(focus, 10_000)
    window.addEventListener('online', focus); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
    return () => { sequence.current++; window.clearInterval(timer); window.removeEventListener('online', focus); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [refresh])
  return { snapshot, error, loading, refresh }
}
