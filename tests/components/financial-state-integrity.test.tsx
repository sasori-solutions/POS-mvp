// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useOperationalMutation } from '../../src/features/operations/useOperations'
import { AccountClientError } from '../../src/lib/account'
import { posRequest, type PosAccess } from '../../src/lib/pos'
import type { OperationsCommand } from '../../src/lib/operations-contracts'
import { accessErrorCodes } from '../../src/components/useCatalog'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access: PosAccess = { businessId: '00000000-0000-4000-8000-000000000001', operatorToken: 'synthetic-memory-only' }
const employeeId = '00000000-0000-4000-8000-000000000002'
const key = `pos-operations:${access.businessId}:${employeeId}`
const command: Extract<OperationsCommand, { command: 'record_checkout' }> = {
  command: 'record_checkout', operationId: '00000000-0000-4000-8000-000000000003',
  attemptId: '00000000-0000-4000-8000-000000000004', expectedRevision: 1, confirmed: true,
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_name: string, callback: () => unknown) => callback()) } })
})
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals() })

test.each(accessErrorCodes)('a retry refused with %s retains the original uncertain payment for the next authorized session', async code => {
  const onSessionError = vi.fn()
  const view = renderHook(() => useOperationalMutation(access, employeeId, onSessionError))
  vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Respuesta perdida'))
  await act(async () => { await expect(view.result.current.execute(command)).rejects.toThrow('Respuesta perdida') })
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
  vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError(code, 'Acceso no autorizado'))
  await act(async () => { await expect(view.result.current.execute(command)).rejects.toThrow('Acceso no autorizado') })
  // Auth checks happen before idempotency lookup: this refusal says nothing about the first payment's outcome.
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
  expect(view.result.current.pending).toEqual(command)
  expect(onSessionError).toHaveBeenCalledOnce()
})

test('a late accepted response cannot erase or expose recovery state belonging to the next business', async () => {
  const response = deferred<unknown>()
  const nextAccess = { ...access, businessId: '00000000-0000-4000-8000-000000000005', operatorToken: 'next-synthetic-memory-only' }
  const nextKey = `pos-operations:${nextAccess.businessId}:${employeeId}`
  const nextCommand = { ...command, operationId: '00000000-0000-4000-8000-000000000006', attemptId: '00000000-0000-4000-8000-000000000007' }
  localStorage.setItem(nextKey, JSON.stringify(nextCommand))
  vi.mocked(posRequest).mockReturnValue(response.promise)
  const view = renderHook(({ currentAccess }) => useOperationalMutation(currentAccess, employeeId), { initialProps: { currentAccess: access } })
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command); await Promise.resolve() })
  view.rerender({ currentAccess: nextAccess })
  await waitFor(() => expect(view.result.current.pending).toEqual(nextCommand))
  await act(async () => { response.resolve({ accepted: true }); await expect(running).rejects.toThrow('La sesión cambió') })
  expect(view.result.current.pending).toEqual(nextCommand)
  expect(view.result.current.lastResult).toBeNull()
  expect(JSON.parse(localStorage.getItem(nextKey)!)).toEqual(nextCommand)
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
})

test('a late access rejection from the previous scope cannot invalidate the next operator', async () => {
  const response = deferred<unknown>(), onSessionError = vi.fn()
  vi.mocked(posRequest).mockReturnValue(response.promise)
  const view = renderHook(({ currentAccess }) => useOperationalMutation(currentAccess, employeeId, onSessionError), { initialProps: { currentAccess: access } })
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command).catch(() => undefined); await Promise.resolve() })
  view.rerender({ currentAccess: { ...access, operatorToken: 'next-synthetic-memory-only' } })
  await act(async () => { response.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior terminada')); await running })
  expect(onSessionError).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
  expect(view.result.current.error).toBe('')
})

test('an unavailable durable write prevents any payment request', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('Storage full') })
  const view = renderHook(() => useOperationalMutation(access, employeeId))
  await act(async () => { await expect(view.result.current.execute(command)).rejects.toThrow('Storage full') })
  expect(posRequest).not.toHaveBeenCalled()
  expect(view.result.current.lastResult).toBeNull()
  write.mockRestore()
})

test('an exact successful retry removes only its own recovery command', async () => {
  localStorage.setItem(key, JSON.stringify(command))
  const result = { accepted: true }
  vi.mocked(posRequest).mockResolvedValue(result)
  const view = renderHook(() => useOperationalMutation(access, employeeId))
  await act(async () => { await view.result.current.execute(command) })
  expect(posRequest).toHaveBeenCalledWith(access, command)
  expect(localStorage.getItem(key)).toBeNull()
  expect(view.result.current.pending).toBeNull()
  expect(view.result.current.lastResult).toEqual({ command: command.command, result })
})

test('unmounting after sending a payment retains recovery and rejects its late success', async () => {
  const response = deferred<unknown>()
  vi.mocked(posRequest).mockReturnValue(response.promise)
  const view = renderHook(() => useOperationalMutation(access, employeeId))
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command); await Promise.resolve() })
  view.unmount()
  response.resolve({ accepted: true })
  await expect(running).rejects.toThrow('La sesión cambió')
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
})

test('a scope closed while waiting for the browser lock never sends an old authorized request', async () => {
  let runLocked!: () => unknown, release!: (value: unknown) => void
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn((_name: string, callback: () => unknown) => {
    runLocked = callback
    return new Promise(resolve => { release = resolve })
  }) } })
  const view = renderHook(() => useOperationalMutation(access, employeeId))
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command); await Promise.resolve() })
  view.unmount()
  expect(runLocked).toThrow('La sesión cambió')
  release(undefined)
  await expect(running).rejects.toThrow('La sesión cambió')
  expect(posRequest).not.toHaveBeenCalled()
  expect(localStorage.getItem(key)).toBeNull()
})

test('a newer operator can recover the same original payment after the previous request finishes late', async () => {
  const old = deferred<unknown>(), accepted = { accepted: true }
  vi.mocked(posRequest).mockReturnValueOnce(old.promise).mockResolvedValueOnce(accepted)
  const nextAccess = { ...access, operatorToken: 'next-synthetic-memory-only' }
  const view = renderHook(({ currentAccess }) => useOperationalMutation(currentAccess, employeeId), { initialProps: { currentAccess: access } })
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command); await Promise.resolve() })
  view.rerender({ currentAccess: nextAccess })
  expect(view.result.current.pending).toEqual(command)
  await act(async () => { await expect(view.result.current.execute(command)).resolves.toBe(accepted) })
  old.resolve(accepted)
  await expect(running).rejects.toThrow('La sesión cambió')
  expect(posRequest).toHaveBeenNthCalledWith(2, nextAccess, command)
  expect(view.result.current.lastResult).toEqual({ command: command.command, result: accepted })
  expect(view.result.current.pending).toBeNull()
  expect(localStorage.getItem(key)).toBeNull()
})

test('a queued browser lock persists and sends the original JSON even when the caller mutates nested selections', async () => {
  const input: Extract<OperationsCommand, { command: 'prepare_checkout' }> = {
    command: 'prepare_checkout', operationId: command.operationId, orderId: command.attemptId,
    expectedRevision: 1, items: [{ lineId: employeeId, quantity: 1 }], paymentMethod: 'cash',
  }
  const captured = JSON.parse(JSON.stringify(input))
  let runLocked!: () => unknown, release!: (value: unknown) => void, calls = 0
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn((_name: string, callback: () => unknown) => {
    if (++calls > 1) return Promise.resolve(callback())
    runLocked = callback
    return new Promise(resolve => { release = resolve })
  }) } })
  const response = deferred<unknown>()
  vi.mocked(posRequest).mockReturnValue(response.promise)
  const view = renderHook(() => useOperationalMutation(access, employeeId))
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(input); await Promise.resolve() })
  input.items[0].quantity = 2
  input.items.push({ lineId: access.businessId, quantity: 5 })
  input.paymentMethod = 'transfer'
  input.operationId = '00000000-0000-4000-8000-000000000009'
  await act(async () => { runLocked(); release(undefined); await Promise.resolve() })
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(captured)
  expect(view.result.current.pending).toEqual(captured)
  expect(posRequest).toHaveBeenCalledWith(access, captured)
  expect(vi.mocked(posRequest).mock.calls[0][1]).not.toBe(input)
  await act(async () => { response.resolve({ accepted: true }); await running })
  expect(localStorage.getItem(key)).toBeNull()
  expect(view.result.current.lastResult?.command).toBe('prepare_checkout')
})

test('a delayed accepted response preserves a newer cross-tab recovery command in visible and durable state', async () => {
  const response = deferred<unknown>(), accepted = { accepted: true }
  const next = { ...command, operationId: '00000000-0000-4000-8000-000000000009', attemptId: '00000000-0000-4000-8000-000000000008' }
  vi.mocked(posRequest).mockReturnValue(response.promise)
  const view = renderHook(() => useOperationalMutation(access, employeeId))
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command); await Promise.resolve() })
  // Another tab recovered this UUID, then durably started the next transaction.
  localStorage.removeItem(key)
  localStorage.setItem(key, JSON.stringify(next))
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(next) })) })
  await act(async () => { response.resolve(accepted); await running })
  expect(view.result.current.pending).toEqual(next)
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(next)
  expect(view.result.current.lastResult).toEqual({ command: command.command, result: accepted })
  const different = { ...command, operationId: '00000000-0000-4000-8000-000000000010' }
  await act(async () => { await expect(view.result.current.execute(different)).rejects.toThrow('Resuelve el reintento pendiente') })
  expect(posRequest).toHaveBeenCalledOnce()
  expect(view.result.current.pending).toEqual(next)
})
