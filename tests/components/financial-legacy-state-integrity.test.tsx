// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import SaleScreen from '../../src/components/SaleScreen'
import { AccountClientError } from '../../src/lib/account'
import { posRequest, type PosAccess } from '../../src/lib/pos'
import { pendingSaleKey, type PendingSale } from '../../src/lib/pending-sale'
import type { CatalogState } from '../../src/components/useCatalog'
import { accessErrorCodes } from '../../src/components/useCatalog'
import type { Product, Sale } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access: PosAccess = { businessId: '00000000-0000-4000-8000-000000000001', operatorToken: 'synthetic-memory-only' }
const employeeId = '00000000-0000-4000-8000-000000000002'
const product: Product = { id: '00000000-0000-4000-8000-000000000003', name: 'Café sintético', category: '', active: true, version: 1, priceCents: 1001 }
const command: PendingSale = { command: 'complete_sale', operationId: '00000000-0000-4000-8000-000000000004', paymentMethod: 'cash', totalCents: 1001, items: [{ productId: product.id, quantity: 1, unitPriceCents: 1001, version: 1 }] }
const key = pendingSaleKey(access.businessId, employeeId)
const sale: Sale = { id: '00000000-0000-4000-8000-000000000005', createdAt: '2026-10-03T12:00:00Z', timezone: 'America/Mexico_City', totalCents: 1001, paymentMethod: 'cash', itemCount: 1, operatorName: 'Persona sintética', items: [{ productId: product.id, name: product.name, category: '', quantity: 1, unitPriceCents: 1001, totalCents: 1001 }] }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let catalog: CatalogState
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_name: string, callback: () => unknown) => callback()) } })
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  catalog = { products: [product], paymentMethods: ['cash'], loaded: true, loading: false, error: '', refresh: vi.fn().mockResolvedValue(undefined), upsert: vi.fn(), remove: vi.fn() }
})
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals() })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })
function props(currentAccess = access) { return { access: currentAccess, employeeId, catalog, onProducts: vi.fn(), onHistory: vi.fn(), onSessionError: vi.fn() } }

test.each(accessErrorCodes)('legacy recovery keeps the exact uncertain sale when its retry fails with %s', async code => {
  localStorage.setItem(key, JSON.stringify(command))
  const properties = props()
  vi.mocked(posRequest).mockRejectedValue(new AccountClientError(code, 'Acceso retirado'))
  render(<SaleScreen {...properties} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reintentar registro' }))
  await waitFor(() => expect(properties.onSessionError).toHaveBeenCalledOnce())
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
  expect(screen.getByRole('button', { name: 'Reintentar registro' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Venta registrada' })).toBeNull()
})

test('a legacy response from the previous business neither exposes its receipt nor clears its recovery payload', async () => {
  const response = deferred<Sale>()
  localStorage.setItem(key, JSON.stringify(command))
  vi.mocked(posRequest).mockReturnValue(response.promise)
  const properties = props(), nextAccess = { ...access, businessId: '00000000-0000-4000-8000-000000000006', operatorToken: 'next-synthetic-memory-only' }
  const view = render(<SaleScreen {...properties} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reintentar registro' }))
  await waitFor(() => expect(posRequest).toHaveBeenCalledOnce())
  view.rerender(<SaleScreen {...properties} access={nextAccess} />)
  await act(async () => response.resolve(sale))
  expect(screen.queryByRole('heading', { name: 'Venta registrada' })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull()
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
  expect(catalog.refresh).not.toHaveBeenCalled()
})

test('a previous legacy token rejection cannot invalidate the next operator using the same business', async () => {
  const response = deferred<Sale>()
  localStorage.setItem(key, JSON.stringify(command))
  vi.mocked(posRequest).mockReturnValue(response.promise)
  const properties = props(), view = render(<SaleScreen {...properties} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reintentar registro' }))
  await waitFor(() => expect(posRequest).toHaveBeenCalledOnce())
  view.rerender(<SaleScreen {...properties} access={{ ...access, operatorToken: 'next-synthetic-memory-only' }} />)
  await act(async () => response.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior terminada')))
  expect(properties.onSessionError).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command)
  expect(screen.queryByText('Sesión anterior terminada')).toBeNull()
  expect((screen.getByRole('button', { name: 'Reintentar registro' }) as HTMLButtonElement).disabled).toBe(false)
})

test('closing legacy checkout while waiting to persist never writes or sends an old sale', async () => {
  let runLocked!: () => unknown, release!: (value: unknown) => void
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn((_name: string, callback: () => unknown) => {
    runLocked = callback
    return new Promise(resolve => { release = resolve })
  }) } })
  const view = render(<SaleScreen {...props()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café sintético, $10.01' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(runLocked).toBeTypeOf('function'))
  view.unmount()
  expect(runLocked).toThrow('La sesión cambió')
  release(undefined)
  await act(async () => { await Promise.resolve() })
  expect(localStorage.getItem(key)).toBeNull()
  expect(posRequest).not.toHaveBeenCalled()
})

test('new legacy checkout never offers manual card collection', async () => {
  catalog.paymentMethods = ['card_external', 'card_integrated']
  render(<SaleScreen {...props()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café sintético, $10.01' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const card = await screen.findByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement
  expect(card.disabled).toBe(true)
  expect(screen.queryByRole('radio', { name: /Tarjeta externa|Registro manual/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  expect(posRequest).not.toHaveBeenCalled()
  expect(localStorage.getItem(key)).toBeNull()
})

test('an uncertain historical card operation retries its exact payload and UUID without creating a Point payment', async () => {
  const historical = { ...command, paymentMethod: 'card_external' as const }
  localStorage.setItem(key, JSON.stringify(historical))
  vi.mocked(posRequest).mockResolvedValue({ ...sale, paymentMethod: 'card_external' })
  render(<SaleScreen {...props()} />)
  const retry = await screen.findByRole('button', { name: 'Reintentar registro' })
  expect(screen.queryByRole('radio', { name: /Tarjeta/ })).toBeNull()
  fireEvent.click(retry)
  await waitFor(() => expect(posRequest).toHaveBeenCalledOnce())
  expect(posRequest).toHaveBeenCalledWith(access, historical)
  expect(await screen.findByRole('heading', { name: 'Venta registrada' })).toBeTruthy()
  expect(localStorage.getItem(key)).toBeNull()
})
