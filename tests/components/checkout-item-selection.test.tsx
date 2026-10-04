// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import CheckoutItemSelection from '../../src/features/operations/CheckoutItemSelection'
import type { OperationalOrder, OrderLine } from '../../src/lib/operations-contracts'

const line: OrderLine = {
  version: 1, lineId: 'synthetic-coffee', productId: 'synthetic-product-coffee', name: 'Café sintético', kitchenName: 'Café sintético',
  category: 'Bebidas', selectionLabel: 'Grande', note: 'Sin hielo', quantity: 3, paidQuantity: 1, sentQuantity: 3,
  unitPriceCents: 101, grossCents: 303, discountCents: 2, totalCents: 301, taxCents: 40, taxBps: 1_600, taxTreatment: 'vat_16',
}
const order: OperationalOrder = {
  id: 'synthetic-order', revision: 1, name: 'Cuenta sintética', tableId: null, status: 'open',
  createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', operatorName: 'Persona sintética', phase: 'checkout', frozen: true,
  items: [line,
    { ...line, lineId: 'synthetic-pastry', productId: 'synthetic-product-pastry', name: 'Postre sintético', quantity: 1, paidQuantity: 0, sentQuantity: 0, selectionLabel: '', note: '', unitPriceCents: 5_500, grossCents: 5_500, discountCents: 500, totalCents: 5_000, taxCents: 0 },
    { ...line, lineId: 'synthetic-paid', name: 'Artículo ya pagado', quantity: 1, paidQuantity: 1, unitPriceCents: 1_000, grossCents: 1_000, discountCents: 0, totalCents: 1_000 }],
  discount: { kind: 'fixed', value: 502, reason: 'Cortesía' }, grossCents: 6_803, discountCents: 502, totalCents: 6_301,
  taxCents: 40, paidCents: 1_101, waivedCents: 0, cancelledCents: 0, balanceCents: 5_200,
}
afterEach(cleanup)

function Controlled({ initial = {}, disabled = false, changed = vi.fn() }: { initial?: Record<string, number>; disabled?: boolean; changed?: (next: Record<string, number>) => void }) {
  const [quantities, setQuantities] = useState(initial)
  return <CheckoutItemSelection order={order} quantities={quantities} disabled={disabled} onChange={next => { changed(next); setQuantities(next) }} />
}

test('plus and minus choose pending units without checkboxes or paid items', () => {
  const changed = vi.fn()
  render(<Controlled changed={changed} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText(/Artículo ya pagado/)).toBeNull()
  expect(screen.getByText('0 de 3 seleccionados')).toBeTruthy()
  const plus = screen.getByRole('button', { name: 'Añadir Café sintético a este cobro' })
  const minus = screen.getByRole('button', { name: 'Quitar Café sintético de este cobro' })
  fireEvent.click(plus)
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 1 })
  expect(screen.getByText('1 de 3 seleccionados')).toBeTruthy()
  fireEvent.click(plus)
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 2 })
  expect(screen.getByText('2 de 3 seleccionados')).toBeTruthy()
  expect((plus as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(minus)
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 1 })
  fireEvent.click(minus)
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 0 })
  expect((minus as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('0 de 3 seleccionados')).toBeTruthy()
})

test('a partial selection preserves exact discount cents after a prior payment', () => {
  render(<Controlled initial={{ 'synthetic-coffee': 1 }} />)
  expect((screen.getByRole('spinbutton', { name: 'Cantidad a cobrar de Café sintético' }) as HTMLInputElement).value).toBe('1')
  expect(screen.getByLabelText('Importe seleccionado: $1.00')).toBeTruthy()
  expect(screen.getByText('1 de 3 seleccionados')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Añadir Café sintético a este cobro' }))
  expect(screen.getByLabelText('Importe seleccionado: $2.00')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Añadir Café sintético a este cobro' }) as HTMLButtonElement).disabled).toBe(true)
})

test('Todos and Limpiar update pending lines together without reintroducing paid items', () => {
  const changed = vi.fn()
  render(<Controlled changed={changed} />)
  expect((screen.getByRole('button', { name: 'Limpiar' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Todos' }))
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 2, 'synthetic-pastry': 1 })
  expect(screen.getByText('3 de 3 seleccionados')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Todos' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 0, 'synthetic-pastry': 0 })
  expect(screen.getByLabelText('Importe disponible: $2.00')).toBeTruthy()
  expect(screen.getByLabelText('Importe disponible: $50.00')).toBeTruthy()
})

test('multiple pending units reject out-of-range or fractional quantity edits', () => {
  const changed = vi.fn()
  render(<Controlled changed={changed} />)
  const quantity = screen.getByRole('spinbutton', { name: 'Cantidad a cobrar de Café sintético' }) as HTMLInputElement
  expect(quantity.min).toBe('0')
  expect(quantity.max).toBe('2')
  expect((screen.getByRole('button', { name: 'Quitar Café sintético de este cobro' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(quantity, { target: { value: '3' } })
  fireEvent.change(quantity, { target: { value: '-1' } })
  fireEvent.change(quantity, { target: { value: '1.5' } })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.change(quantity, { target: { value: '1' } })
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 1 })
  fireEvent.click(screen.getByRole('button', { name: 'Quitar Café sintético de este cobro' }))
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-coffee': 0 })
})

test('single-unit lines use the same bounded stepper as every other product', () => {
  const changed = vi.fn()
  render(<Controlled changed={changed} />)
  const quantity = screen.getByRole('spinbutton', { name: 'Cantidad a cobrar de Postre sintético' }) as HTMLInputElement
  const plus = screen.getByRole('button', { name: 'Añadir Postre sintético a este cobro' }) as HTMLButtonElement
  const minus = screen.getByRole('button', { name: 'Quitar Postre sintético de este cobro' }) as HTMLButtonElement
  expect(quantity.min).toBe('0')
  expect(quantity.max).toBe('1')
  expect(quantity.value).toBe('0')
  expect(minus.disabled).toBe(true)
  fireEvent.click(plus)
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-pastry': 1 })
  expect(quantity.value).toBe('1')
  expect(plus.disabled).toBe(true)
  expect(screen.getByLabelText('Importe seleccionado: $50.00')).toBeTruthy()
  fireEvent.click(minus)
  expect(changed).toHaveBeenLastCalledWith({ 'synthetic-pastry': 0 })
  expect(quantity.value).toBe('0')
  expect(minus.disabled).toBe(true)
})

test('disabled selection blocks steppers, bulk actions and quantity edits', () => {
  const changed = vi.fn()
  render(<Controlled disabled initial={{ 'synthetic-coffee': 1 }} changed={changed} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  for (const input of screen.getAllByRole('spinbutton')) expect((input as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Añadir Café sintético a este cobro' }))
  fireEvent.click(screen.getByRole('button', { name: 'Quitar Café sintético de este cobro' }))
  fireEvent.click(screen.getByRole('button', { name: 'Todos' }))
  fireEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
  fireEvent.change(screen.getByLabelText('Cantidad a cobrar de Café sintético'), { target: { value: '2' } })
  expect(changed).not.toHaveBeenCalled()
})
