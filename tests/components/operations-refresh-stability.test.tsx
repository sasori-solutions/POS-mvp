// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useOperations } from '../../src/features/operations/useOperations'
import { AccountClientError } from '../../src/lib/account'
import { posRequest } from '../../src/lib/pos'
import type { OperationsSnapshot } from '../../src/lib/operations-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access = { businessId: 'synthetic-business', operatorToken: 'synthetic-memory-only' }
const snapshot: OperationsSnapshot = { enabled: true, shift: null, orders: [], tables: [], attempts: [] }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('refresh keeps the valid operational data mounted and separates initial loading', async () => {
  const initial = deferred<OperationsSnapshot>(), next = deferred<OperationsSnapshot>()
  vi.mocked(posRequest).mockReturnValueOnce(initial.promise).mockReturnValueOnce(next.promise)
  const { result } = renderHook(() => useOperations(access, true))
  expect(result.current.loading).toBe(true)
  await act(async () => initial.resolve(snapshot))
  expect(result.current.snapshot).toBe(snapshot)
  expect(result.current.loading).toBe(false)
  let request!: Promise<void>
  act(() => { request = result.current.refresh() })
  expect(result.current.snapshot).toBe(snapshot)
  expect(result.current.loading).toBe(false)
  expect(result.current.refreshing).toBe(true)
  await act(async () => { next.resolve({ ...snapshot }); await request })
  expect(result.current.refreshing).toBe(false)
})

test('a failed refresh preserves data; a current authorization refusal clears it', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('Sin conexión')).mockRejectedValueOnce(new AccountClientError('PERMISSION_DENIED', 'Permiso retirado'))
  const onSessionError = vi.fn()
  const { result } = renderHook(() => useOperations(access, true, onSessionError))
  await act(async () => {})
  await act(async () => result.current.refresh())
  expect(result.current.snapshot).toBe(snapshot)
  expect(result.current.error).toBe('Sin conexión')
  await act(async () => result.current.refresh())
  expect(result.current.snapshot).toBeNull()
  expect(onSessionError).toHaveBeenCalledOnce()
})

test('switching operator hides old data synchronously and ignores its late refusal', async () => {
  const old = deferred<OperationsSnapshot>(), next = deferred<OperationsSnapshot>(), onSessionError = vi.fn()
  vi.mocked(posRequest).mockResolvedValueOnce(snapshot).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const { result, rerender } = renderHook(({ token }) => useOperations({ ...access, operatorToken: token }, true, onSessionError), { initialProps: { token: access.operatorToken } })
  await act(async () => {})
  act(() => { void result.current.refresh() })
  rerender({ token: 'next-synthetic-memory-only' })
  expect(result.current.snapshot).toBeNull()
  await act(async () => { old.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior')); next.resolve({ ...snapshot, pendingKitchenCount: 3 }) })
  expect(result.current.snapshot?.pendingKitchenCount).toBe(3)
  expect(onSessionError).not.toHaveBeenCalled()
})

test('temporarily leaving operations does not replace its same-session data on return', async () => {
  const next = deferred<OperationsSnapshot>()
  vi.mocked(posRequest).mockResolvedValueOnce(snapshot).mockReturnValueOnce(next.promise)
  const { result, rerender } = renderHook(({ enabled }) => useOperations(access, enabled), { initialProps: { enabled: true } })
  await act(async () => {})
  rerender({ enabled: false })
  expect(result.current.snapshot).toBeNull()
  rerender({ enabled: true })
  expect(result.current.snapshot).toBe(snapshot)
  expect(result.current.loading).toBe(false)
  await act(async () => next.resolve(snapshot))
})

test('a callback retained by a previous operator cannot hide the new snapshot or issue a read', async () => {
  const nextSnapshot = { ...snapshot, pendingKitchenCount: 5 }
  vi.mocked(posRequest).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(nextSnapshot)
  const { result, rerender } = renderHook(({ token }) => useOperations({ ...access, operatorToken: token }, true), { initialProps: { token: access.operatorToken } })
  await act(async () => {})
  const oldRefresh = result.current.refresh
  rerender({ token: 'next-synthetic-memory-only' })
  await act(async () => {})
  expect(result.current.snapshot).toBe(nextSnapshot)
  await act(async () => oldRefresh())
  expect(result.current.snapshot).toBe(nextSnapshot)
  expect(posRequest).toHaveBeenCalledTimes(2)
})
