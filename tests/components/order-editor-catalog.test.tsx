// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import OrderEditor from '../../src/features/operations/OrderEditor'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { OperationalOrder, OrderLine } from '../../src/lib/operations-contracts'
import type { Product, ProductDetails } from '../../src/lib/pos-contracts'
import { emptyDetails } from '../../src/lib/product-details'
import { maxOperationalMoneyCents, maxOperationalUnitPriceCents } from '../../src/lib/operational-money'

const originalShow = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })
afterEach(() => { cleanup(); vi.clearAllMocks() })

function product(details: Partial<ProductDetails> = {}): Product {
  return { id: '00000000-0000-4000-a000-000000000001', name: 'Latte sintético', category: 'Café', priceCents: 4500, active: true, version: 2, details: { ...emptyDetails(), ...details } }
}
function order(items: OrderLine[]): OperationalOrder {
  return { id: '00000000-0000-4000-a000-000000000010', revision: 3, name: 'Cuenta sintética', orderKind: 'service', tableId: null, status: 'open', phase: 'service', frozen: false, createdAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:00:00Z', operatorName: 'Persona sintética', items, discount: null, grossCents: 4500, discountCents: 0, totalCents: 4500, taxCents: 0, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 4500 }
}
function storedLine(overrides: Partial<OrderLine> = {}): OrderLine {
  return { lineId: '00000000-0000-4000-a000-000000000020', productId: product().id, version: 1, name: 'Nombre histórico', kitchenName: 'Preparación histórica', category: 'Café', selectionLabel: 'Grande, Leche vegetal', note: 'Sin hielo', quantity: 1, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 4500, grossCents: 4500, discountCents: 0, totalCents: 4500, taxCents: 0, taxBps: 0, taxTreatment: 'vat_0', ...overrides }
}
function editor(value = product(), savedOrder?: OperationalOrder) {
  const mutation: OperationalMutation = { execute: vi.fn().mockResolvedValue(order([])), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
  const props = { products: [value], order: savedOrder, mutation, onSaved: vi.fn(), onCancel: vi.fn() }
  return { ...render(<OrderEditor {...props} />), mutation, props }
}
const optionalSet = { id: 'extras', name: 'Extras', min: 0, max: 1, options: [{ id: 'milk', name: 'Leche vegetal', priceCents: 750 }] }

test('accounts honor quick add for optional extras and a sole available variant', async () => {
  const view = editor(product({ skipCustomization: true, modifierSets: [optionalSet], variations: [
    { id: 'sold', name: 'Chico', priceCents: 1000, sku: '', barcode: '', soldOut: true },
    { id: 'available', name: 'Grande', priceCents: 5500, sku: '', barcode: '', soldOut: false },
  ] }))
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Latte sintético, Desde $55.00' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'save_order', items: [expect.objectContaining({ unitPriceCents: 5500, selection: { variationId: 'available', modifierIds: [], variablePriceCents: null } })] }), 'service'))
})

test('required extras still demand a choice even when quick add is enabled', async () => {
  const view = editor(product({ skipCustomization: true, modifierSets: [{ ...optionalSet, min: 1 }] }))
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Latte sintético, $45.00' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Latte sintético' }))
  expect((dialog.getByRole('button', { name: 'Agregar · $45.00' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('radio', { name: /Leche vegetal/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Agregar · $52.50' }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ unitPriceCents: 5250, selection: { variationId: null, modifierIds: ['milk'], variablePriceCents: null } })] }), 'service'))
})

test('open-price cards explain the amount choice and never quick add canonical zero', async () => {
  const view = editor({ ...product({ variablePrice: true, skipCustomization: true }), priceCents: 0 })
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Latte sintético, Precio abierto' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Latte sintético' }))
  expect((dialog.getByRole('button', { name: 'Agregar · $0.00' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(dialog.getByLabelText('Precio de esta venta MXN'), { target: { value: '12.34' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Agregar · $12.34' }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ unitPriceCents: 1234, selection: { variationId: null, modifierIds: [], variablePriceCents: 1234 } })] }), 'service'))
})

test('the card price uses the lowest available variant and a chosen variant keeps its exact amount', async () => {
  const view = editor(product({ variations: [
    { id: 'sold', name: 'Chico', priceCents: 1000, sku: '', barcode: '', soldOut: true },
    { id: 'medium', name: 'Mediano', priceCents: 5500, sku: '', barcode: '', soldOut: false },
    { id: 'large', name: 'Grande', priceCents: 6751, sku: '', barcode: '', soldOut: false },
  ] }))
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Latte sintético, Desde $55.00' }))
  const dialog = within(screen.getByRole('dialog'))
  expect((dialog.getByRole('radio', { name: /Chico/ }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('radio', { name: /Grande/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Agregar · $67.51' }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ unitPriceCents: 6751, selection: expect.objectContaining({ variationId: 'large' }) })] }), 'service'))
})

test('details expose food information and customer attributes without adding or offering catalog mutations', () => {
  editor(product({ description: 'Café de temporada', customerName: 'Latte de la casa', calories: 120, dietary: 'Vegetariano', allergens: 'Leche', customAttributes: [{ name: 'Origen', value: 'Chiapas' }] }))
  fireEvent.click(screen.getByRole('button', { name: 'Detalles de Latte sintético' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Latte sintético' }))
  for (const text of ['Café de temporada', 'En la cuenta: Latte de la casa', 'Calorías: 120 kcal', 'Preferencias alimentarias: Vegetariano', 'Alérgenos: Leche', 'Origen', 'Chiapas']) expect(dialog.getByText(text)).toBeTruthy()
  for (const action of ['Marcar agotado', 'Editar producto', 'Eliminar producto']) expect(dialog.queryByRole('button', { name: action })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Cerrar' }))
  expect(screen.getByText('Añade productos')).toBeTruthy()
})

test('details can customize an optional extra even when the main card quick adds', async () => {
  const view = editor(product({ skipCustomization: true, modifierSets: [optionalSet] }))
  fireEvent.click(screen.getByRole('button', { name: 'Detalles de Latte sintético' }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.click(dialog.getByRole('radio', { name: /Leche vegetal/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Agregar · $52.50' }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ unitPriceCents: 5250, selection: expect.objectContaining({ modifierIds: ['milk'] }) })] }), 'service'))
})

test('saving edits preserves accepted prices, versions, selections and sent kitchen notes after catalog changes', async () => {
  const historical = storedLine({ sentQuantity: 1, selection: { variationId: 'old-size', modifierIds: ['old-extra'], variablePriceCents: null } })
  const view = editor({ ...product(), priceCents: 9000, version: 8 }, order([historical]))
  expect(screen.getByText('Nombre histórico')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Quitar Nombre histórico' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3, items: [{ lineId: historical.lineId, productId: historical.productId, quantity: 1, unitPriceCents: 4500, version: 1, selection: historical.selection, note: 'Sin hielo' }] }), 'service'))
})

test('an overflowing subtotal is blocked visibly until quantities are reduced', async () => {
  const view = editor(product(), order([storedLine({ quantity: 101, unitPriceCents: maxOperationalUnitPriceCents })]))
  expect(screen.getByRole('alert').textContent).toContain('El subtotal supera el límite')
  expect((screen.getByRole('button', { name: 'Guardar cuenta' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  expect(view.mutation.execute).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Reducir Nombre histórico' }))
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ quantity: 100 })] }), 'service'))
})

test('the exact monetary maximum is accepted without rounding away a cent', async () => {
  const view = editor(product(), order([storedLine({ quantity: 100, unitPriceCents: maxOperationalUnitPriceCents }), storedLine({ lineId: 'extra-cent', unitPriceCents: 99 })]))
  expect(screen.getByText('$99,999,999.99')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(view.mutation.execute).toHaveBeenCalledOnce())
  const command = vi.mocked(view.mutation.execute).mock.calls[0][0]
  if (command.command !== 'save_order') throw new Error('Expected account save')
  expect(command.items.reduce((sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitPriceCents), 0n)).toBe(BigInt(maxOperationalMoneyCents))
})

test('pending recovery blocks creating a new save without changing the original operation', () => {
  const view = editor(product(), order([storedLine()]))
  const pending = { command: 'save_order' as const, operationId: 'accepted-operation', orderId: 'accepted-order', expectedRevision: 1, name: 'Guardada', tableId: null, items: [] }
  view.rerender(<OrderEditor {...view.props} mutation={{ ...view.mutation, pending }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  expect(view.mutation.execute).not.toHaveBeenCalled()
  expect(pending).toEqual({ command: 'save_order', operationId: 'accepted-operation', orderId: 'accepted-order', expectedRevision: 1, name: 'Guardada', tableId: null, items: [] })
})

test('the full account can still read product details while adding remains disabled', () => {
  const view = editor(product({ description: 'Información disponible al llenar la cuenta' }), order(Array.from({ length: 40 }, (_, index) => storedLine({ lineId: `accepted-${index}` }))))
  expect((screen.getByRole('button', { name: 'Agregar Latte sintético, $45.00' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Detalles de Latte sintético' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Latte sintético' }))
  expect(dialog.getByText('Información disponible al llenar la cuenta')).toBeTruthy()
  expect((dialog.getByRole('button', { name: 'Agregar · $45.00' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('button', { name: 'Agregar · $45.00' }))
  expect(view.mutation.execute).not.toHaveBeenCalled()
  expect(screen.getByRole('region', { name: 'Artículos de la cuenta' }).querySelectorAll('li')).toHaveLength(40)
})

test('a product dialog already open becomes read-only while an account request is pending', () => {
  const view = editor(product({ modifierSets: [optionalSet] }))
  fireEvent.click(screen.getByRole('button', { name: 'Detalles de Latte sintético' }))
  const pending = { command: 'save_order' as const, operationId: 'pending-save', orderId: 'pending-order', expectedRevision: null, name: 'Guardada', tableId: null, items: [] }
  view.rerender(<OrderEditor {...view.props} mutation={{ ...view.mutation, pending }} />)
  const dialog = within(screen.getByRole('dialog'))
  expect((dialog.getByRole('button', { name: 'Agregar · $45.00' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('button', { name: 'Agregar · $45.00' }))
  expect(screen.getByText('Añade productos')).toBeTruthy()
  expect(view.mutation.execute).not.toHaveBeenCalled()
})

test('frozen accounts retain read-only product information without editing financial snapshots', () => {
  const view = editor(product({ allergens: 'Leche' }), { ...order([storedLine()]), frozen: true })
  expect((screen.getByRole('button', { name: 'Guardar cuenta' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Detalles de Latte sintético' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Alérgenos: Leche')).toBeTruthy()
  expect((dialog.getByRole('button', { name: 'Agregar · $45.00' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('button', { name: 'Agregar · $45.00' }))
  expect(view.mutation.execute).not.toHaveBeenCalled()
})

test.each([{ quantity: 1.5 }, { unitPriceCents: 4500.5 }, { unitPriceCents: maxOperationalUnitPriceCents + 1 }])('invalid monetary integers remain visible and cannot be saved: %j', invalid => {
  const view = editor(product(), order([storedLine(invalid)]))
  expect(screen.getByRole('alert').textContent).toBe('Revisa las cantidades y los precios de la cuenta.')
  expect((screen.getByRole('button', { name: 'Guardar cuenta' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  expect(view.mutation.execute).not.toHaveBeenCalled()
})
