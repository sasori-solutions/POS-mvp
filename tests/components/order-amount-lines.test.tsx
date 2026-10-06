// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import OrderEditor from '../../src/features/operations/OrderEditor'
import OrderDetail from '../../src/features/operations/OrderDetail'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { OperationalOrder, OrderLine } from '../../src/lib/operations-contracts'
import type { BusinessContext } from '../../src/lib/contracts'

const amount: OrderLine = {
  kind: 'amount', lineId: 'amount-line', productId: null, version: 1, name: 'Concepto original', kitchenName: '',
  category: '', selectionLabel: '', selection: null, note: '', quantity: 1, paidQuantity: 0, sentQuantity: 0,
  unitPriceCents: 1001, grossCents: 1001, discountCents: 0, totalCents: 1001, taxCents: 0, taxBps: 0, taxTreatment: 'unconfigured',
}
const product: OrderLine = { ...amount, kind: 'product', lineId: 'product-line', productId: 'product', name: 'Latte', kitchenName: 'Latte', unitPriceCents: 5800, grossCents: 5800, totalCents: 5800 }
const order: OperationalOrder = {
  id: 'order', revision: 1, name: 'Cuenta sintética', orderKind: 'service', tableId: null, status: 'open', phase: 'service', frozen: false,
  createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', operatorName: 'Persona sintética',
  items: [amount, product], discount: null, grossCents: 6801, discountCents: 0, totalCents: 6801, taxCents: 0,
  paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 6801,
}
function mutation(): OperationalMutation { return { execute: vi.fn().mockResolvedValue(order), busy: false, pending: null, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } }
afterEach(cleanup)

test('editing a mixed account preserves free amounts without catalog identities and allows concept, price and quantity corrections', async () => {
  const request = mutation()
  render(<OrderEditor order={order} products={[]} mutation={request} onSaved={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.click(screen.getByText('Editar importe'))
  fireEvent.change(screen.getByLabelText('Concepto (opcional)'), { target: { value: 'Concepto corregido' } })
  fireEvent.change(screen.getByLabelText('Importe unitario'), { target: { value: '12.34' } })
  fireEvent.click(screen.getByRole('button', { name: 'Añadir Concepto corregido', exact: true }))
  expect(screen.queryByLabelText('Nota de cocina para Concepto corregido')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledOnce())
  expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({
    command: 'save_order', orderId: order.id, expectedRevision: 1, orderKind: 'service',
    items: [
      { kind: 'amount', lineId: amount.lineId, name: 'Concepto corregido', quantity: 2, unitPriceCents: 1234, note: '' },
      { lineId: product.lineId, productId: product.productId, version: 1, quantity: 1, unitPriceCents: 5800, note: '' },
    ],
  }), 'service')
})

test('invalid free amounts block saving and a frozen paid account blocks edits', () => {
  const request = mutation()
  const props = { order, products: [], mutation: request, onSaved: vi.fn(), onCancel: vi.fn() }
  const view = render(<OrderEditor {...props} />)
  fireEvent.click(screen.getByText('Editar importe'))
  fireEvent.change(screen.getByLabelText('Importe unitario'), { target: { value: '0.00' } })
  expect(screen.getByRole('alert').textContent).toBe('Escribe un importe mayor a $0.00.')
  expect((screen.getByRole('button', { name: 'Guardar cuenta' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  expect(request.execute).not.toHaveBeenCalled()
  view.unmount()
  render(<OrderEditor {...props} order={{ ...order, frozen: true, paidCents: 1001, balanceCents: 5800 }} />)
  fireEvent.click(screen.getByText('Editar importe'))
  expect((screen.getByLabelText('Concepto (opcional)') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByLabelText('Importe unitario') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Guardar cuenta' }) as HTMLButtonElement).disabled).toBe(true)
})

test('an account can add a free amount through the same entry controls without creating a product', async () => {
  const request = mutation()
  render(<OrderEditor products={[]} mutation={request} onSaved={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Añadir importe libre' }))
  fireEvent.change(screen.getByLabelText('Importe', { exact: true }), { target: { value: '15.25' } })
  fireEvent.click(screen.getByRole('button', { name: 'Añadir concepto' }))
  fireEvent.change(screen.getByLabelText('Concepto (opcional)'), { target: { value: 'Trabajo sintético' } })
  fireEvent.click(screen.getByRole('button', { name: 'Añadir $15.25' }))
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Teclado de importe' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledOnce())
  expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ items: [{ kind: 'amount', lineId: expect.any(String), name: 'Trabajo sintético', quantity: 1, unitPriceCents: 1525, note: '' }] }), 'service')
})

test('service details never prepare free amounts and only offer kitchen actions for unsent catalog products', () => {
  const request = mutation()
  const business = { id: 'business', name: 'Sintético', role: 'owner', profile: { paymentMethods: ['cash'] } } as BusinessContext
  const props = { business, methods: ['cash' as const], attempts: [], mutation: request, onSaved: vi.fn(), onEdit: vi.fn(), onStartCheckout: vi.fn(), refresh: vi.fn(), collectionAllowed: true }
  const view = render(<OrderDetail {...props} order={{ ...order, items: [amount] }} />)
  expect(screen.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
  expect(screen.getByText('Importe libre')).toBeTruthy()
  expect(screen.getByText('0 pagados')).toBeTruthy()
  view.rerender(<OrderDetail {...props} order={{ ...order, items: [amount, { ...product, sentQuantity: 1 }] }} />)
  expect(screen.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
  view.rerender(<OrderDetail {...props} order={order} />)
  expect(screen.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  const amountRow = screen.getByText('1 × Concepto original').closest('li')!
  expect(within(amountRow).queryByText(/enviados/)).toBeNull()
  expect(request.execute).not.toHaveBeenCalled()
})
