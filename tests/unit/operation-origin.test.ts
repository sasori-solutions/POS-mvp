// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readOperation, useOperationalMutation, type OperationOrigin } from '../../src/features/operations/useOperations'
import { AccountClientError } from '../../src/lib/account'
import type { OperationsCommand } from '../../src/lib/operations-contracts'
import { posRequest, type PosAccess } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const access: PosAccess = { businessId: id(1), operatorToken: 'synthetic-memory-only' }
const employee = id(2), key = `pos-operations:${access.businessId}:${employee}`
const command: Extract<OperationsCommand, { command: 'save_order' }> = {
  command: 'save_order', operationId: id(3), orderId: id(4), expectedRevision: null, name: 'Mostrador', tableId: null,
  items: [{ lineId: id(5), productId: id(6), version: 1, quantity: 1, unitPriceCents: 3500, note: '' }],
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_key: string, callback: () => unknown) => callback()) } })
})
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals() })

test.each(['counter', 'service'] as const)('a durable %s origin unwraps to the exact HTTP mutation', origin => {
  localStorage.setItem(key, JSON.stringify({ payload: command, origin }))
  expect(readOperation(key)).toEqual(command)
  const view = renderHook(() => useOperationalMutation(access, employee))
  expect(view.result.current.pending).toEqual(command)
  expect(view.result.current.pendingOrigin).toBe(origin)
  expect(localStorage.getItem(key)).not.toContain(access.operatorToken)
})

test('legacy raw save/payment records retain their exact shape and have no invented origin', async () => {
  const payment = { command: 'record_checkout', operationId: id(7), attemptId: id(8), expectedRevision: 1, confirmed: true } as const
  for (const input of [command, payment]) {
    const raw = JSON.stringify(input), response = deferred<never>()
    localStorage.setItem(key, raw)
    vi.mocked(posRequest).mockReturnValueOnce(response.promise)
    const view = renderHook(() => useOperationalMutation(access, employee))
    expect(view.result.current.pendingOrigin).toBeNull()
    let running!: Promise<unknown>
    await act(async () => { running = view.result.current.execute(input); await Promise.resolve() })
    expect(localStorage.getItem(key)).toBe(raw)
    expect(posRequest).toHaveBeenLastCalledWith(access, input)
    await act(async () => { response.reject(new AccountClientError('NETWORK_ERROR', 'Respuesta perdida')); await expect(running).rejects.toThrow('Respuesta perdida') })
    expect(readOperation(key)).toEqual(input)
    view.unmount()
  }
})

test.each([
  { payload: command, origin: 'unknown' }, { payload: command, origin: null },
  { payload: command, origin: ['counter'] }, { payload: command, origin: { value: 'service' } },
  { payload: command }, { origin: 'counter' }, { payload: null, origin: 'counter' },
  { payload: [command], origin: 'counter' }, { payload: command, origin: 'counter', operationId: id(9) },
  { payload: { ...command, operationId: 'invalid' }, origin: 'service' },
  { payload: { command: 'record_checkout', operationId: id(3) }, origin: 'counter' },
  { payload: { payload: command, origin: 'counter' }, origin: 'service' },
  { ...command, origin: 'counter' },
])('malformed or unrelated origin metadata remains untouched for review: %j', value => {
  const raw = JSON.stringify(value)
  localStorage.setItem(key, raw)
  expect(() => readOperation(key)).toThrow('El reintento guardado necesita revisión.')
  const view = renderHook(() => useOperationalMutation(access, employee))
  expect(view.result.current.pending).toBeNull()
  expect(view.result.current.pendingOrigin).toBeNull()
  expect(view.result.current.error).toContain('No pudimos leer el reintento')
  expect(localStorage.getItem(key)).toBe(raw)
})

test.each(['operatorToken', 'deviceToken', 'pin', 'access_token', 'refresh_token', 'deviceProof', 'access', 'businessId', 'authSessionId'])('rejects %s anywhere in the stored wrapper or payload', field => {
  for (const value of [{ payload: command, origin: 'counter', [field]: 'synthetic-forbidden' }, { payload: { ...command, [field]: 'synthetic-forbidden' }, origin: 'service' }, { payload: { ...command, items: [{ ...command.items[0], [field]: 'synthetic-forbidden' }] }, origin: 'counter' }]) {
    localStorage.setItem(key, JSON.stringify(value))
    expect(() => readOperation(key)).toThrow()
  }
})

test('escaped credential keys cannot bypass recovery validation', () => {
  const raw = JSON.stringify({ payload: { ...command, operatorToken: 'synthetic-forbidden' }, origin: 'service' }).replace('operatorToken', '\\u006fperatorToken')
  localStorage.setItem(key, raw)
  expect(() => readOperation(key)).toThrow()
  expect(localStorage.getItem(key)).toBe(raw)
})

test.each(['counter', 'service'] as const)('lost %s save responses recover origin after reload and retry without metadata in HTTP', async origin => {
  const response = deferred<never>(), write = vi.spyOn(Storage.prototype, 'setItem')
  vi.mocked(posRequest).mockReturnValueOnce(response.promise).mockResolvedValueOnce({ accepted: true } as never)
  const first = renderHook(() => useOperationalMutation(access, employee))
  let running!: Promise<unknown>
  await act(async () => { running = first.result.current.execute(command, origin); await Promise.resolve() })
  expect(write).toHaveBeenCalledExactlyOnceWith(key, JSON.stringify({ payload: command, origin }))
  expect(first.result.current.pendingOrigin).toBe(origin)
  expect(posRequest).toHaveBeenCalledExactlyOnceWith(access, command)
  await act(async () => { response.reject(new AccountClientError('NETWORK_ERROR', 'Respuesta perdida')); await expect(running).rejects.toThrow('Respuesta perdida') })
  first.unmount()
  const nextAccess = { ...access, operatorToken: 'synthetic-next-session' }
  const second = renderHook(() => useOperationalMutation(nextAccess, employee))
  expect(second.result.current.pending).toEqual(command)
  expect(second.result.current.pendingOrigin).toBe(origin)
  await act(async () => { await second.result.current.execute(second.result.current.pending!) })
  expect(posRequest).toHaveBeenNthCalledWith(2, nextAccess, command)
  expect(second.result.current.pending).toBeNull()
  expect(second.result.current.pendingOrigin).toBeNull()
  expect(localStorage.getItem(key)).toBeNull()
})

test('a pending UUID cannot be reclassified or replaced during an exact retry', async () => {
  const raw = JSON.stringify({ payload: command, origin: 'service' })
  localStorage.setItem(key, raw)
  const view = renderHook(() => useOperationalMutation(access, employee))
  await act(async () => { await expect(view.result.current.execute(command, 'counter')).rejects.toThrow('Conserva el origen') })
  await act(async () => { await expect(view.result.current.execute({ ...command, operationId: id(9) }, 'service')).rejects.toThrow('Resuelve el reintento pendiente') })
  expect(posRequest).not.toHaveBeenCalled()
  expect(localStorage.getItem(key)).toBe(raw)
  expect(view.result.current.pendingOrigin).toBe('service')
  expect(view.result.current.pending?.operationId).toBe(command.operationId)
})

test('invalid origins and credential-bearing inputs are refused before storage or HTTP', async () => {
  const view = renderHook(() => useOperationalMutation(access, employee))
  for (const origin of ['unknown', null, { value: 'service' }]) {
    await act(async () => { await expect(view.result.current.execute(command, origin as OperationOrigin)).rejects.toThrow('El origen del reintento necesita revisión.') })
  }
  const payment = { command: 'record_checkout', operationId: id(7), attemptId: id(8), expectedRevision: 1, confirmed: true } as const
  await act(async () => { await expect(view.result.current.execute(payment, 'counter')).rejects.toThrow('El origen del reintento necesita revisión.') })
  await act(async () => { await expect(view.result.current.execute({ ...command, operatorToken: 'synthetic-forbidden' } as typeof command, 'service')).rejects.toThrow('El reintento guardado necesita revisión.') })
  expect(posRequest).not.toHaveBeenCalled()
  expect(localStorage.getItem(key)).toBeNull()
  expect(view.result.current.pendingOrigin).toBeNull()
})

test('a failed atomic wrapper write never sends a save or exposes detached origin', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('Storage full') })
  const view = renderHook(() => useOperationalMutation(access, employee))
  await act(async () => { await expect(view.result.current.execute(command, 'counter')).rejects.toThrow('Storage full') })
  expect(posRequest).not.toHaveBeenCalled()
  expect(view.result.current.pending).toBeNull()
  expect(view.result.current.pendingOrigin).toBeNull()
  write.mockRestore()
})

test('storage events update UUID and origin together, including legacy replacement and removal', () => {
  localStorage.setItem(key, JSON.stringify({ payload: command, origin: 'service' }))
  const view = renderHook(() => useOperationalMutation(access, employee))
  const replacement = { ...command, operationId: id(9), orderId: id(10) }
  act(() => {
    localStorage.setItem(key, JSON.stringify({ payload: replacement, origin: 'counter' }))
    window.dispatchEvent(new StorageEvent('storage', { key }))
  })
  expect(view.result.current.pending?.operationId).toBe(replacement.operationId)
  expect(view.result.current.pendingOrigin).toBe('counter')
  act(() => { localStorage.setItem(key, JSON.stringify(replacement)); window.dispatchEvent(new StorageEvent('storage', { key })) })
  expect(view.result.current.pending).toEqual(replacement)
  expect(view.result.current.pendingOrigin).toBeNull()
  act(() => { localStorage.removeItem(key); window.dispatchEvent(new StorageEvent('storage', { key })) })
  expect(view.result.current.pending).toBeNull()
  expect(view.result.current.pendingOrigin).toBeNull()
})

test('a delayed acceptance preserves a newer cross-tab wrapper and its different origin', async () => {
  const response = deferred<never>(), next = { ...command, operationId: id(9), orderId: id(10) }
  vi.mocked(posRequest).mockReturnValueOnce(response.promise)
  const view = renderHook(() => useOperationalMutation(access, employee))
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command, 'counter'); await Promise.resolve() })
  const raw = JSON.stringify({ payload: next, origin: 'service' })
  act(() => { localStorage.setItem(key, raw); window.dispatchEvent(new StorageEvent('storage', { key })) })
  await act(async () => { response.resolve({ accepted: true } as never); await running })
  expect(localStorage.getItem(key)).toBe(raw)
  expect(view.result.current.pending).toEqual(next)
  expect(view.result.current.pendingOrigin).toBe('service')
})

test('old-session results cannot expose origin in another business or clear either recovery record', async () => {
  const response = deferred<never>(), nextAccess = { ...access, businessId: id(11), operatorToken: 'synthetic-next-scope' }
  const nextKey = `pos-operations:${nextAccess.businessId}:${employee}`, next = { ...command, operationId: id(9), orderId: id(10) }
  localStorage.setItem(nextKey, JSON.stringify({ payload: next, origin: 'service' }))
  vi.mocked(posRequest).mockReturnValueOnce(response.promise)
  const view = renderHook(({ currentAccess }) => useOperationalMutation(currentAccess, employee), { initialProps: { currentAccess: access } })
  let running!: Promise<unknown>
  await act(async () => { running = view.result.current.execute(command, 'counter'); await Promise.resolve() })
  view.rerender({ currentAccess: nextAccess })
  expect(view.result.current.pending).toEqual(next)
  expect(view.result.current.pendingOrigin).toBe('service')
  await act(async () => { response.resolve({ accepted: true } as never); await expect(running).rejects.toThrow('La sesión cambió') })
  expect(view.result.current.pending).toEqual(next)
  expect(view.result.current.pendingOrigin).toBe('service')
  expect(readOperation(key)).toEqual(command)
  expect(readOperation(nextKey)).toEqual(next)
  expect(view.result.current.lastResult).toBeNull()
})
