// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import HomeScreen from '../../src/components/HomeScreen'
import { useCatalog, type CatalogState } from '../../src/components/useCatalog'
import { useOperations, useOperationalMutation, type OperationalMutation } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { Product } from '../../src/lib/pos-contracts'

vi.mock('../../src/components/useCatalog', async original => ({ ...await original<object>(), useCatalog: vi.fn() }))
vi.mock('../../src/features/operations/useOperations', async original => ({ ...await original<object>(), useOperations: vi.fn(), useOperationalMutation: vi.fn() }))
const business: BusinessContext = { id: 'business', name: 'Mostrador sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-02T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
const product: Product = { id: 'product', name: 'Café', category: 'Bebidas', priceCents: 3500, version: 1, active: true }
const order: OperationalOrder = { id: 'saved-order', revision: 1, name: 'Mostrador', tableId: null, status: 'open', phase: 'service', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: 'Persona sintética', items: [{ lineId: 'accepted-line', productId: product.id, version: 1, name: product.name, kitchenName: product.name, category: product.category, selectionLabel: 'Chico', note: '', quantity: 1, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 3500, grossCents: 3500, discountCents: 0, totalCents: 3500, taxCents: 483, taxBps: 1600, taxTreatment: 'vat_16' }], discount: null, grossCents: 3500, discountCents: 0, totalCents: 3500, taxCents: 483, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 3500 }
let catalog: CatalogState, snapshot: OperationsSnapshot, mutation: OperationalMutation
const refresh = vi.fn().mockResolvedValue(undefined)
const props = { business, operatorToken: 'synthetic-memory-only', onLock: vi.fn(), onLogout: vi.fn(), busy: false, error: '' }
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(() => {
  localStorage.clear()
  catalog = { products: [product], paymentMethods: ['cash'], loaded: true, loading: false, error: '', refresh, upsert: vi.fn(), remove: vi.fn() }
  snapshot = { enabled: true, shift: null, orders: [], tables: [], attempts: [] }
  mutation = { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command !== 'save_order') throw new Error('Unexpected mutation')
    return { ...order, id: command.orderId }
  })
  vi.mocked(useCatalog).mockImplementation(() => catalog)
  vi.mocked(useOperations).mockImplementation(() => ({ snapshot, loading: false, error: '', refresh }))
  vi.mocked(useOperationalMutation).mockImplementation(() => mutation)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })
function currentSale() { return within(screen.getByRole('complementary', { name: 'Venta actual' })) }
async function saveAndClose() {
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta y cobrar $35.00' }))
  const dialog = await screen.findByRole('dialog', { name: 'Mostrador' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
}

test('closing the collection panel preserves the order and reopening it never creates another account', async () => {
  render(<HomeScreen {...props} />)
  await saveAndClose()
  expect(currentSale().getByText('Café')).toBeTruthy()
  expect(currentSale().getByText('Cantidad: 1')).toBeTruthy()
  expect(currentSale().queryByText('Tu cuenta está vacía')).toBeNull()
  fireEvent.click(currentSale().getByRole('button', { name: 'Continuar cobro $35.00' }))
  expect(await screen.findByRole('dialog', { name: 'Mostrador' })).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('a saved account keeps its accepted selections, discount and IVA when the catalog changes', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const discounted = { ...saved, revision: 2, discount: { kind: 'fixed' as const, value: 500, reason: 'Descuento sintético' }, discountCents: 500, totalCents: 3000, taxCents: 414, balanceCents: 3000, items: saved.items.map(line => ({ ...line, discountCents: 500, totalCents: 3000, taxCents: 414 })) }
  snapshot = { ...snapshot, orders: [discounted] }
  catalog = { ...catalog, products: [] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('Chico')).toBeTruthy()
  expect(currentSale().getByText('$4.14')).toBeTruthy()
  expect(currentSale().getByRole('button', { name: 'Continuar cobro $30.00' })).toBeTruthy()
  expect(currentSale().queryByText('Tu cuenta está vacía')).toBeNull()
})

test('partial payment retains the account; only its resolved status clears it', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const partial: OperationalOrder = { ...saved, revision: 2, phase: 'checkout', frozen: true, grossCents: 7000, totalCents: 7000, taxCents: 966, paidCents: 3500, balanceCents: 3500, items: saved.items.map(line => ({ ...line, quantity: 2, paidQuantity: 1, grossCents: 7000, totalCents: 7000, taxCents: 966 })) }
  snapshot = { ...snapshot, orders: [{ ...saved, id: 'another-account', status: 'paid' }, partial] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByRole('button', { name: 'Continuar cobro $35.00' })).toBeTruthy()
  snapshot = { ...snapshot, orders: [{ ...partial, revision: 3, status: 'paid', paidCents: 7000, balanceCents: 0, items: partial.items.map(line => ({ ...line, paidQuantity: 2 })) }] }
  view.rerender(<HomeScreen {...props} />)
  await waitFor(() => expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy())
  snapshot = { ...snapshot, orders: [] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('starting a new account leaves the previous saved account available and creates a different identity', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  snapshot = { ...snapshot, orders: [saved] }
  view.rerender(<HomeScreen {...props} />)
  fireEvent.click(currentSale().getByRole('button', { name: 'Nueva cuenta' }))
  expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Mostrador\s*En servicio · 1 artículos/ })).toBeTruthy()
  await saveAndClose()
  const commands = vi.mocked(mutation.execute).mock.calls.map(([command]) => command)
  expect(commands).toHaveLength(2)
  expect(commands[1]).toHaveProperty('expectedRevision', null)
  expect(commands[1]).not.toHaveProperty('orderId', saved.id)
})

test('an exact retry after a lost save response restores the accepted account and can resume it', async () => {
  const command = { command: 'save_order' as const, operationId: 'original-operation', orderId: order.id, expectedRevision: null, name: 'Mostrador', tableId: null, items: [] }
  mutation = { ...mutation, pending: command }
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledWith(command))
  mutation = { ...mutation, pending: null, lastResult: { command: 'save_order', result: order } }
  view.rerender(<HomeScreen {...props} />)
  const dialog = await screen.findByRole('dialog', { name: 'Mostrador' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
  fireEvent.click(currentSale().getByRole('button', { name: 'Continuar cobro $35.00' }))
  expect(await screen.findByRole('dialog', { name: 'Mostrador' })).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('a zero-balance open account remains visible until its status is explicitly resolved', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  snapshot = { ...snapshot, orders: [{ ...saved, revision: 2, totalCents: 0, balanceCents: 0, discount: { kind: 'percent', value: 10000, reason: 'Cortesía sintética' }, discountCents: 3500, taxCents: 0, items: saved.items.map(line => ({ ...line, totalCents: 0, discountCents: 3500, taxCents: 0 })) }] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('Café')).toBeTruthy()
  expect(currentSale().getByRole('button', { name: 'Continuar cobro $0.00' })).toBeTruthy()
})

test('saving another counter account does not replace a draft being entered in Venta', () => {
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  mutation = { ...mutation, lastResult: { command: 'save_order', result: order } }
  view.rerender(<HomeScreen {...props} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(currentSale().getByRole('button', { name: 'Aumentar Café' })).toBeTruthy()
  expect(currentSale().getByRole('button', { name: 'Guardar cuenta y cobrar $35.00' })).toBeTruthy()
})
