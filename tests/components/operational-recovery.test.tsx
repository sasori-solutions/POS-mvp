// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import OrderDetail from '../../src/features/operations/OrderDetail'
import SalesScreen from '../../src/components/SalesScreen'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { Sale } from '../../src/lib/pos-contracts'
import { posRequest } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async importOriginal => ({ ...await importOriginal<object>(), posRequest: vi.fn() }))
const business: BusinessContext = { id: 'business', name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-02T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
const order: OperationalOrder = { id: 'order', revision: 1, name: 'Cuenta gratis', tableId: 'table', status: 'open', phase: 'service', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: 'Persona sintética', items: [{ lineId: 'line', productId: 'product', version: 1, name: 'Café', kitchenName: 'Café', category: '', selectionLabel: '', note: '', quantity: 1, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 1001, grossCents: 1001, discountCents: 1001, totalCents: 0, taxCents: 0, taxBps: 1600, taxTreatment: 'vat_16' }], discount: { kind: 'percent', value: 10000, reason: 'Cortesía' }, grossCents: 1001, discountCents: 1001, totalCents: 0, taxCents: 0, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 0 }
const sale: Sale = { id: 'sale', totalCents: 1001, paymentMethod: 'cash', operatorName: 'Persona sintética', createdAt: business.createdAt, timezone: business.timezone, itemCount: 1, items: [] }
const refund: CheckoutAttempt = { id: 'refund', revision: 1, kind: 'reversal', status: 'prepared', orderId: null, shiftId: 'shift', saleId: null, originalSaleId: sale.id, paymentMethod: 'cash', totalCents: 1001, taxCents: 0, discountCents: 0, operatorName: 'Persona sintética', resolverName: null, createdAt: business.createdAt, resolvedAt: null, reason: 'Devolución sintética', items: [] }
function mutation(lastResult: OperationalMutation['lastResult'] = null): OperationalMutation {
  return { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult, clearNotice: vi.fn() }
}
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })

test('zero-total open accounts remain editable and can enter final checkout before explicit closure', async () => {
  const request = mutation(), onSaved = vi.fn()
  vi.mocked(request.execute).mockResolvedValue({ ...order, phase: 'checkout', revision: 2 })
  const props = { order, business, tables: [], methods: ['cash' as const], attempts: [], mutation: request, onSaved, onEdit: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined), collectionAllowed: true }
  const { rerender } = render(<OrderDetail {...props} />)
  expect(screen.queryByRole('button', { name: 'Cerrar cuenta y liberar mesa' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Finalizar cuenta para cobrar' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ phase: 'checkout' })))
  rerender(<OrderDetail {...props} order={{ ...order, phase: 'checkout' }} />)
  expect((screen.getByRole('button', { name: 'Preparar cobro completo' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByText('Descuento de toda la cuenta')).toBeNull()
  rerender(<OrderDetail {...props} order={{ ...order, status: 'paid', phase: 'checkout', frozen: true }} />)
  expect(screen.getByRole('button', { name: 'Cerrar cuenta y liberar mesa' })).toBeTruthy()
})

test.each(['snapshot', 'exact-retry'] as const)('a persisted refund is recoverable from %s within sales without cash access', async source => {
  vi.mocked(posRequest).mockImplementation(async (_access, command) => command.command === 'sales' ? { sales: [sale], nextCursor: null } : command.command === 'attempt' ? refund : sale)
  const request = mutation(source === 'exact-retry' ? { command: 'prepare_reversal', result: refund } : null)
  render(<SalesScreen access={{ businessId: business.id, operatorToken: 'synthetic-memory-only' }} ownOnly={false} canReverse mutation={request} attempts={source === 'snapshot' ? [refund] : []} collectionAllowed />)
  fireEvent.click(await screen.findByRole('button', { name: /^Ver venta/ }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Iniciar devolución' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.queryByText('Devolver venta completa')).toBeNull()
})
