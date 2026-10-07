// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CashScreen from '../../src/features/operations/CashScreen'
import type { BusinessContext } from '../../src/lib/contracts'
import type { CashShift, OperationsSnapshot, ShiftPaymentSummary } from '../../src/lib/operations-contracts'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import { posRequest, type PosAccess } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access: PosAccess = { businessId: 'synthetic-business', operatorToken: 'synthetic-memory-only' }
const business: BusinessContext = { id: access.businessId, name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-06T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
function summary(): ShiftPaymentSummary { return { collectedCents: 1004, refundedCents: 201, netCents: 803, pointRefundsNotAttributed: true, payments: [
  { paymentMethod: 'cash', collectedCents: 101, refundedCents: 0, netCents: 101 },
  { paymentMethod: 'card_external', collectedCents: 201, refundedCents: 201, netCents: 0 },
  { paymentMethod: 'card_integrated', collectedCents: 301, refundedCents: 0, netCents: 301 },
  { paymentMethod: 'transfer', collectedCents: 401, refundedCents: 0, netCents: 401 },
] } }
function shift(status: CashShift['status'] = 'open'): CashShift { return { id: 'synthetic-shift', revision: 1, status, openedAt: business.createdAt, closedAt: status === 'closed' ? '2026-10-06T13:00:00Z' : null, openedBy: 'Persona sintética', closedBy: status === 'closed' ? 'Persona sintética' : null, openingCents: 200, countedCents: status === 'closed' ? 301 : null, expectedCents: status === 'closed' ? 301 : null, differenceCents: status === 'closed' ? 0 : null, movements: [], paymentSummary: summary() } }
const snapshot = (current: CashShift | null): OperationsSnapshot => ({ enabled: true, shift: current, orders: [], tables: [], attempts: [] })
const mutation = (): OperationalMutation => ({ execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() })
beforeEach(() => { vi.mocked(posRequest).mockResolvedValue({ shifts: [] }) })
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('shows historical methods independently of current configuration and never presents Point refunds or net as complete', async () => {
  render(<CashScreen business={business} access={access} snapshot={snapshot(shift())} mutation={mutation()} refresh={vi.fn()} />)
  const region = screen.getByRole('region', { name: 'Cobros por método del turno' })
  expect(within(region).getByText('Tarjeta externa')).toBeTruthy()
  expect(within(region).getByText('Transferencia')).toBeTruthy()
  const point = within(region).getByText('Mercado Pago Point').closest('li')!
  expect(within(point).getByText('$3.01')).toBeTruthy()
  expect(within(point).queryByText('$0.00')).toBeNull()
  expect(within(point).getByLabelText('Consultar devoluciones en Pagos integrados')).toBeTruthy()
  expect(within(point).getByLabelText('Neto de Point sin atribución completa al turno')).toBeTruthy()
  expect(within(region).getByText('Neto registrado')).toBeTruthy()
  expect(within(region).getByText(/el neto registrado aquí no las descuenta/)).toBeTruthy()
  await act(async () => {})
})

it('updates the open shift summary when receipts change without a shift revision and hides it throughout blind closing', async () => {
  const current = shift(), props = { business, access, mutation: mutation(), refresh: vi.fn() }
  const { rerender } = render(<CashScreen {...props} snapshot={snapshot(current)} />)
  const fresh = structuredClone(current)
  fresh.paymentSummary!.collectedCents += 100; fresh.paymentSummary!.netCents += 100
  fresh.paymentSummary!.payments[0].collectedCents += 100; fresh.paymentSummary!.payments[0].netCents += 100
  rerender(<CashScreen {...props} snapshot={snapshot(fresh)} />)
  expect(screen.getByText('$11.04')).toBeTruthy()
  // Even a stale/malformed incoming DTO cannot show the active summary during count.
  rerender(<CashScreen {...props} snapshot={snapshot({ ...fresh, status: 'closing' })} />)
  expect(screen.queryByRole('region', { name: 'Cobros por método del turno' })).toBeNull()
  expect(screen.getByLabelText('Efectivo contado')).toBeTruthy()
  expect(screen.queryByText('$11.04')).toBeNull()
  rerender(<CashScreen {...props} snapshot={snapshot(fresh)} />)
  expect(screen.getByText('$11.04')).toBeTruthy()
  await act(async () => {})
})

it('reveals the closed result after submitting the blind count and supports older closed responses', async () => {
  const request = mutation(), closed = shift('closed')
  vi.mocked(request.execute).mockResolvedValue(closed)
  render(<CashScreen business={business} access={access} snapshot={snapshot(shift('closing'))} mutation={request} refresh={vi.fn()} />)
  expect(screen.queryByRole('region', { name: 'Cobros por método del turno' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Efectivo contado'), { target: { value: '3.01' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar conteo y cerrar' }))
  await screen.findByRole('region', { name: 'Cobros por método del turno' })
  expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'close_shift', countedCents: 301 }))
})

it('shows summaries in closed history, accepts legacy absence and hides open totals without cash.read', async () => {
  const closed = shift('closed'), legacy = { ...closed, id: 'legacy-closed', paymentSummary: undefined }
  vi.mocked(posRequest).mockResolvedValue({ shifts: [closed, legacy] })
  const props = { business, access, mutation: mutation(), refresh: vi.fn() }
  const { rerender } = render(<CashScreen {...props} snapshot={snapshot(null)} />)
  await screen.findByRole('region', { name: 'Cobros por método del turno' })
  expect(screen.getByRole('heading', { name: 'Turnos anteriores' })).toBeTruthy()
  rerender(<CashScreen {...props} business={{ ...business, role: 'cashier', permissions: ['sales.create', 'catalog.read'] }} snapshot={snapshot(shift())} />)
  expect(screen.queryByRole('region', { name: 'Cobros por método del turno' })).toBeNull()
})
