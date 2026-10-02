// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useCatalog } from '../../src/components/useCatalog'
import { AccountClientError } from '../../src/lib/account'
import { posRequest } from '../../src/lib/pos'
import type { PosResponses } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/pos', () => ({ posRequest: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const access = { businessId: 'business', operatorToken: 'operator' }
const catalog: PosResponses['catalog'] = { products: [{ id: 'latte', name: 'Latte', category: 'Café', active: true, priceCents: 5800, version: 1 }], paymentMethods: ['cash'] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('focus and reconnection share an ongoing catalog refresh', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(catalog)
  const { result } = renderHook(() => useCatalog(access, true))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const refresh = deferred<PosResponses['catalog']>()
  vi.mocked(posRequest).mockReturnValue(refresh.promise)
  act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')) })
  expect(posRequest).toHaveBeenCalledTimes(2)
  expect(result.current.products[0].name).toBe('Latte')
  await act(async () => refresh.resolve(catalog))
})

test('a failed refresh stays visible until a successful retry confirms the catalog', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(catalog)
  const { result } = renderHook(() => useCatalog(access, true))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  vi.mocked(posRequest).mockRejectedValueOnce(new Error('Catálogo sin confirmar'))
  await act(async () => result.current.refresh())
  const retry = deferred<PosResponses['catalog']>()
  vi.mocked(posRequest).mockReturnValueOnce(retry.promise)
  act(() => { void result.current.refresh() })
  expect(result.current.error).toBe('Catálogo sin confirmar')
  await act(async () => retry.resolve(catalog))
  expect(result.current.error).toBe('')
})

test('a late refresh cannot overwrite a product that was just saved', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(catalog)
  const { result } = renderHook(() => useCatalog(access, true))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const refresh = deferred<PosResponses['catalog']>()
  vi.mocked(posRequest).mockReturnValueOnce(refresh.promise)
  act(() => { void result.current.refresh() })
  act(() => result.current.upsert({ ...catalog.products[0], version: 2, priceCents: 6000 }))
  await act(async () => refresh.resolve(catalog))
  expect(result.current.products[0].priceCents).toBe(6000)
})

test('background refresh still reports revoked operator access', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(catalog)
  const onSessionError = vi.fn()
  const { result } = renderHook(() => useCatalog(access, true, onSessionError))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const error = new AccountClientError('SESSION_INVALID', 'Vuelve a entrar')
  vi.mocked(posRequest).mockRejectedValueOnce(error)
  await act(async () => result.current.refresh())
  expect(onSessionError).toHaveBeenCalledWith(error)
})

test('a late refresh cannot restore a product that was just deleted', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(catalog)
  const { result } = renderHook(() => useCatalog(access, true))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const refresh = deferred<PosResponses['catalog']>()
  vi.mocked(posRequest).mockReturnValueOnce(refresh.promise)
  act(() => { void result.current.refresh() })
  act(() => result.current.remove('latte'))
  expect(result.current.products).toEqual([])
  await act(async () => refresh.resolve(catalog))
  expect(result.current.products).toEqual([])
})

test('an operator change cannot reuse an outstanding request from the previous operator', async () => {
  const previous = deferred<PosResponses['catalog']>()
  vi.mocked(posRequest).mockReturnValueOnce(previous.promise).mockResolvedValueOnce({ ...catalog, products: [] })
  const { result, rerender } = renderHook(({ token }) => useCatalog({ ...access, operatorToken: token }, true), { initialProps: { token: 'previous' } })
  rerender({ token: 'current' })
  await act(async () => previous.resolve(catalog))
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.products).toEqual([])
})
