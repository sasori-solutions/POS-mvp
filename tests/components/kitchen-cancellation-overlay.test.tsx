// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import OrdersScreen from '../../src/features/operations/OrdersScreen'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { KitchenBatch, OperationsSnapshot } from '../../src/lib/operations-contracts'
import { posRequest, type PosAccess } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access: PosAccess = { businessId: 'business', operatorToken: 'synthetic-memory-only' }
const business: BusinessContext = { id: access.businessId, name: 'Cocina sintética', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'cashier', permissions: ['kitchen.read', 'kitchen.operate'], createdAt: '2026-10-02T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
const snapshot: OperationsSnapshot = { enabled: true, shift: null, orders: [], tables: [], attempts: [] }
const batch: KitchenBatch = { id: 'batch', orderId: 'order', orderName: 'Cuenta sintética', tableName: 'Mesa prueba', createdAt: business.createdAt, revision: 2, status: 'queued', kind: 'items', fullyCancelled: false, reason: '', items: [{ lineId: 'line', name: 'Café', selectionLabel: 'Grande', note: 'Sin azúcar', quantity: 3, cancelledQuantity: 2 }] }
function renderKitchen() {
  const request: OperationalMutation = { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
  const refresh = vi.fn().mockResolvedValue(undefined)
  render(<OrdersScreen business={business} access={access} snapshot={snapshot} mutation={request} onOrder={vi.fn()} onNew={vi.fn()} refresh={refresh} />)
  return { request, refresh }
}
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('a batch of three with two cancelled shows only one unit to prepare using the current revision', async () => {
  vi.mocked(posRequest).mockResolvedValue({ batches: [batch] })
  const { request } = renderKitchen()
  const card = await screen.findByRole('region', { name: 'Comanda Cuenta sintética' })
  expect(within(card).getByText('1 × Café')).toBeTruthy()
  expect(within(card).getByText('Cantidad original: 3 · Canceladas: 2')).toBeTruthy()
  expect(within(card).queryByText('3 × Café')).toBeNull()
  expect(within(card).getByText('Nota: Sin azúcar')).toBeTruthy()
  vi.mocked(request.execute).mockResolvedValue({ ...batch, status: 'preparing', revision: 3 })
  vi.mocked(posRequest).mockResolvedValue({ batches: [{ ...batch, status: 'preparing', revision: 3 }] })
  fireEvent.click(within(card).getByRole('button', { name: 'Comenzar preparación' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith({ command: 'set_kitchen_status', operationId: expect.any(String), batchId: batch.id, expectedRevision: 2, status: 'preparing' }))
  expect(await within(card).findByRole('button', { name: 'Marcar lista' })).toBeTruthy()
  expect(within(card).getByText('1 × Café')).toBeTruthy()
})

test('fully cancelled work is hidden from the active kitchen and has no preparation actions in history', async () => {
  const cancelled: KitchenBatch = { ...batch, fullyCancelled: true, items: [{ ...batch.items[0], cancelledQuantity: 3 }] }
  vi.mocked(posRequest).mockResolvedValue({ batches: [cancelled] })
  const { request } = renderKitchen()
  await screen.findByText('No hay comandas pendientes.')
  expect(screen.queryByRole('region', { name: 'Comanda Cuenta sintética' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Mostrar entregadas y canceladas' }))
  const card = screen.getByRole('region', { name: 'Comanda Cuenta sintética' })
  expect(within(card).getByText('Cancelada', { exact: true })).toBeTruthy()
  expect(within(card).getByText('0 × Café')).toBeTruthy()
  expect(within(card).getByText('Cantidad original: 3 · Canceladas: 3')).toBeTruthy()
  expect(within(card).queryByRole('button')).toBeNull()
  expect(request.execute).not.toHaveBeenCalled()
})

test('acknowledging a cancellation notice preserves the original batch cancellation overlay', async () => {
  const notice: KitchenBatch = { ...batch, id: 'notice', revision: 1, kind: 'cancellation', reason: 'Cancelación sintética', items: [{ ...batch.items[0], quantity: 2, cancelledQuantity: 0 }] }
  vi.mocked(posRequest).mockResolvedValue({ batches: [batch, notice] })
  const { request, refresh } = renderKitchen()
  const acknowledge = await screen.findByRole('button', { name: 'Confirmar aviso' })
  vi.mocked(request.execute).mockResolvedValue({ ...notice, status: 'delivered', revision: 2 })
  vi.mocked(posRequest).mockResolvedValue({ batches: [batch, { ...notice, status: 'delivered', revision: 2 }] })
  fireEvent.click(acknowledge)
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith({ command: 'set_kitchen_status', operationId: expect.any(String), batchId: notice.id, expectedRevision: 1, status: 'delivered' }))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: 'Confirmar aviso' })).toBeNull()
  expect(screen.getAllByRole('region', { name: 'Comanda Cuenta sintética' })).toHaveLength(1)
  expect(screen.getByText('1 × Café')).toBeTruthy()
  expect(screen.getByText('Cantidad original: 3 · Canceladas: 2')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Comenzar preparación' })).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Mostrar entregadas y canceladas' }))
  expect(screen.getByText('Cancelación · Entregada')).toBeTruthy()
  expect(screen.getByText('2 × Café')).toBeTruthy()
  expect(screen.getAllByRole('region', { name: 'Comanda Cuenta sintética' })).toHaveLength(2)
})
