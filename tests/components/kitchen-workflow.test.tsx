// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import OrdersScreen from '../../src/features/operations/OrdersScreen'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { KitchenBatch, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import { posRequest } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access = { businessId: 'business', operatorToken: 'synthetic-memory-only' }
const business = { id: access.businessId, role: 'owner', timezone: 'America/Mexico_City', profile: { accountsEnabled: true } } as BusinessContext
const snapshot: OperationsSnapshot = { enabled: true, shift: null, orders: [], tables: [], attempts: [] }
const batch: KitchenBatch = { id: 'batch', orderId: 'order', orderName: 'Mesa sintética', tableName: '', status: 'queued', kind: 'items', revision: 1, createdAt: '2026-10-04T12:00:00Z', reason: '', items: [{ lineId: 'line', name: 'Café', selectionLabel: '', note: '', quantity: 1 }] }
function mutation(): OperationalMutation { return { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } }
const props = { business, access, snapshot, onOrder: vi.fn(), onNew: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) }
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('a kitchen batch advances pending to in progress and then completed with current revisions', async () => {
  let saved = batch
  vi.mocked(posRequest).mockImplementation(async () => ({ batches: [saved] }))
  const request = mutation()
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command !== 'set_kitchen_status') throw new Error('Unexpected command')
    expect(command.expectedRevision).toBe(saved.revision)
    saved = { ...saved, status: command.status, revision: saved.revision + 1 }
    return saved
  })
  render(<OrdersScreen {...props} mutation={request} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Comenzar' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Comanda Mesa sintética' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'En proceso' }))
  fireEvent.click(screen.getByRole('button', { name: 'Completar' }))
  await waitFor(() => expect(saved.status).toBe('delivered'))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Comanda Mesa sintética' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Completadas' }))
  expect(within(screen.getByRole('region', { name: 'Comanda Mesa sintética' })).getByText('Completada')).toBeTruthy()
  expect(request.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedRevision: 1, status: 'preparing' }))
  expect(request.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({ expectedRevision: 2, status: 'delivered' }))
})

test('legacy ready work is in progress, while cancelled work never has a preparation action', async () => {
  vi.mocked(posRequest).mockResolvedValue({ batches: [{ ...batch, status: 'ready' }, { ...batch, id: 'cancelled', orderName: 'Cancelada', fullyCancelled: true }] })
  render(<OrdersScreen {...props} mutation={mutation()} />)
  await screen.findByText('No hay comandas pendientes.')
  fireEvent.click(screen.getByRole('button', { name: 'En proceso' }))
  expect(screen.getByRole('button', { name: 'Completar' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Completadas' }))
  expect(within(screen.getByRole('region', { name: 'Comanda Cancelada' })).queryByRole('button')).toBeNull()
})

test('background refresh keeps the same kitchen card and does not remount placeholders', async () => {
  let resolve!: (value: { batches: KitchenBatch[] }) => void
  vi.mocked(posRequest).mockResolvedValueOnce({ batches: [batch] }).mockReturnValueOnce(new Promise(yes => { resolve = yes }))
  const request = mutation(), view = render(<OrdersScreen {...props} mutation={request} />)
  const original = await screen.findByRole('region', { name: 'Comanda Mesa sintética' })
  view.rerender(<OrdersScreen {...props} mutation={request} snapshot={{ ...snapshot }} />)
  expect(screen.getByRole('region', { name: 'Comanda Mesa sintética' })).toBe(original)
  expect(screen.queryByRole('status', { name: 'Cargando comandas' })).toBeNull()
  await act(async () => resolve({ batches: [batch] }))
})

test('direct-charge businesses cannot create accounts but existing unpaid accounts remain payable', async () => {
  const direct = { ...business, profile: { ...business.profile, accountsEnabled: false } }
  vi.mocked(posRequest).mockResolvedValue({ batches: [] })
  const request = mutation(), view = render(<OrdersScreen {...props} business={direct} mutation={request} />)
  expect(screen.queryByRole('button', { name: 'Cuentas' })).toBeNull()
  const existing = { id: 'old', name: 'Cuenta anterior', operatorName: 'Persona sintética', balanceCents: 1001, phase: 'service' } as OperationalOrder
  view.rerender(<OrdersScreen {...props} business={direct} mutation={request} snapshot={{ ...snapshot, orders: [existing] }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cuentas' }))
  expect(screen.queryByRole('button', { name: 'Abrir cuenta' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Cuenta anterior/ }))
  expect(props.onOrder).toHaveBeenCalledWith(existing)
})
