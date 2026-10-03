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

export function useOperationalMutation(access: PosAccess, employeeId: string, onSessionError?: (error: AccountClientError) => void) {
  const key = `pos-operations:${access.businessId}:${employeeId}`
  const [pending, setPending] = useState<Mutation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastResult, setLastResult] = useState<{ command: Mutation['command']; result: unknown } | null>(null)
  const alive = useRef(true)
  const submitting = useRef(false)
  useEffect(() => {
    alive.current = true
    try { setPending(readOperation(key)) } catch { setError('No pudimos leer el reintento guardado. Conserva este dispositivo y pide ayuda.') }
    const stored = (event: StorageEvent) => { if (event.key === key && !submitting.current) { try { setPending(readOperation(key)) } catch { setError('No pudimos leer el reintento guardado.') } } }
    window.addEventListener('storage', stored)
    return () => { alive.current = false; window.removeEventListener('storage', stored) }
  }, [key])
  async function execute<C extends Mutation['command']>(command: Extract<Mutation, { command: C }>): Promise<OperationsResponses[C]> {
    if (submitting.current) throw new Error('Espera a que termine la solicitud actual.')
    submitting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (!navigator.onLine) throw new AccountClientError('NETWORK_ERROR', 'Sin conexión. Vuelve a conectar antes de continuar.')
      if (!navigator.locks) throw new Error('Abre el POS en un navegador actualizado para proteger los reintentos entre pestañas.')
      await navigator.locks.request(key, () => {
        const stored = readOperation(key)
        if (stored && JSON.stringify(stored) !== JSON.stringify(command)) throw new Error('Resuelve el reintento pendiente antes de iniciar otra acción.')
        localStorage.setItem(key, JSON.stringify(command))
      })
      if (alive.current) setPending(command)
      const result = await posRequest(access, command)
      await navigator.locks.request(key, () => { if (readOperation(key)?.operationId === command.operationId) localStorage.removeItem(key) })
      if (alive.current) { setPending(null); setNotice(''); setLastResult({ command: command.command, result }) }
      return result as OperationsResponses[C]
    } catch (caught) {
      if (alive.current) {
        setError(caught instanceof Error ? caught.message : 'No pudimos confirmar la solicitud.')
        if (caught instanceof AccountClientError && !['NETWORK_ERROR', 'SERVER_ERROR', 'OPERATION_CONFLICT'].includes(caught.code)) {
          // A definite server refusal has no effects. Uncertain responses keep the exact request.
          try { await navigator.locks?.request(key, () => { if (readOperation(key)?.operationId === command.operationId) localStorage.removeItem(key) }); setPending(readOperation(key)) } catch { /* Preserve recovery on storage failure. */ }
        }
        if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
      }
      throw caught
    } finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  return { execute, pending, busy, error, notice, lastResult, clearNotice: () => setNotice('') }
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
