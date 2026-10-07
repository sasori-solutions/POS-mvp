// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import OrderDiscountEditor from '../../src/features/operations/OrderDiscountEditor'
import type { OperationalOrder } from '../../src/lib/operations-contracts'

const order: OperationalOrder = {
  id: 'synthetic-order', revision: 1, name: 'Cuenta sintética', tableId: null,
  status: 'open', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', operatorName: 'Persona sintética',
  phase: 'checkout', frozen: false, items: [], discount: null, grossCents: 19_500, discountCents: 0,
  totalCents: 19_500, taxCents: 0, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 19_500,
}
afterEach(cleanup)

test('opening focuses a mode button without automatically opening a numeric keyboard', () => {
  render(<OrderDiscountEditor order={order} onApply={vi.fn()} onCancel={vi.fn()} />)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Importe', exact: true }))
  expect(document.activeElement).not.toBe(screen.getByLabelText('Porcentaje'))
})

test('percentage shortcuts are draft inputs and require a reason before applying', async () => {
  const onApply = vi.fn(), onCancel = vi.fn()
  render(<OrderDiscountEditor order={order} onApply={onApply} onCancel={onCancel} />)
  fireEvent.click(screen.getByRole('button', { name: '10%' }))
  expect(screen.getByText('−$19.50')).toBeTruthy()
  expect(screen.getByText('$175.50')).toBeTruthy()
  expect(onApply).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Aplicar descuento' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: '  Cortesía   del día  ' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' })))
  expect(onApply).toHaveBeenCalledExactlyOnceWith({ kind: 'percent', value: 1_000, reason: 'Cortesía del día' })
  expect(screen.getByText('Se aplica a toda la cuenta.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
  expect(onCancel).toHaveBeenCalledOnce()
})

test('fixed discount validates against gross and retains each mode draft', async () => {
  const onApply = vi.fn()
  render(<OrderDiscountEditor order={order} onApply={onApply} onCancel={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Importe', exact: true }))
  fireEvent.change(screen.getByLabelText('Importe del descuento'), { target: { value: '200.00' } })
  expect(screen.getByRole('alert').textContent).toBe('Máximo $195.00.')
  expect(screen.getByLabelText('Importe del descuento').getAttribute('aria-invalid')).toBe('true')
  fireEvent.change(screen.getByLabelText('Importe del descuento'), { target: { value: '50.00' } })
  expect(screen.getByText('$145.00')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Porcentaje', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '15%' }))
  expect(screen.getByText('$165.75')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Importe', exact: true }))
  expect((screen.getByLabelText('Importe del descuento') as HTMLInputElement).value).toBe('$50.00')
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cortesía' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' })))
  expect(onApply).toHaveBeenCalledExactlyOnceWith({ kind: 'fixed', value: 5_000, reason: 'Cortesía' })
})

test('editing starts from the saved discount and removing is explicit', async () => {
  const onApply = vi.fn()
  render(<OrderDiscountEditor order={{ ...order, discount: { kind: 'percent', value: 1_525, reason: 'Cortesía' }, discountCents: 2_974, totalCents: 16_526 }} onApply={onApply} onCancel={vi.fn()} />)
  expect((screen.getByLabelText('Porcentaje') as HTMLInputElement).value).toBe('15.25%')
  expect((screen.getByLabelText('Motivo') as HTMLInputElement).value).toBe('Cortesía')
  expect(screen.getByText('$165.26')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Quitar descuento' })))
  expect(onApply).toHaveBeenCalledExactlyOnceWith(null)
})

test('pending application prevents duplicate clicks and cancellation', async () => {
  let complete!: () => void
  const onApply = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
  render(<OrderDiscountEditor order={order} onApply={onApply} onCancel={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '20%' }))
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cortesía' } })
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  expect(onApply).toHaveBeenCalledOnce()
  expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('status', { name: 'Aplicando descuento' })).toBeTruthy()
  await act(async () => complete())
  expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(false)
})

test('a server rejection keeps the editor draft and releases pending controls for the parent retry', async () => {
  const onApply = vi.fn().mockRejectedValue(new Error('Synthetic server rejection'))
  render(<OrderDiscountEditor order={order} onApply={onApply} onCancel={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '15%' }))
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cortesía' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' })))
  expect(onApply).toHaveBeenCalledOnce()
  expect((screen.getByLabelText('Porcentaje') as HTMLInputElement).value).toBe('15%')
  expect((screen.getByLabelText('Motivo') as HTMLInputElement).value).toBe('Cortesía')
  expect((screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByRole('status', { name: 'Aplicando descuento' })).toBeNull()
})

test('a valid discount applies directly without payment confirmations', async () => {
  const onApply = vi.fn()
  render(<OrderDiscountEditor order={order} onApply={onApply} onCancel={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '10%' }))
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cortesía' } })
  const apply = screen.getByRole('button', { name: 'Aplicar descuento' }) as HTMLButtonElement
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText(/recibí|recibiste|confirma/i)).toBeNull()
  expect(apply.disabled).toBe(false)
  await act(async () => fireEvent.click(apply))
  expect(onApply).toHaveBeenCalledExactlyOnceWith({ kind: 'percent', value: 1_000, reason: 'Cortesía' })
})

test('removing a saved discount is direct and has no payment confirmation', async () => {
  const onApply = vi.fn()
  const discounted = { ...order, discount: { kind: 'percent' as const, value: 1_000, reason: 'Cortesía' }, discountCents: 1_950, totalCents: 17_550 }
  render(<OrderDiscountEditor order={discounted} onApply={onApply} onCancel={vi.fn()} />)
  const remove = screen.getByRole('button', { name: 'Quitar descuento' }) as HTMLButtonElement
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText(/recibí|recibiste|confirma/i)).toBeNull()
  expect(remove.disabled).toBe(false)
  await act(async () => fireEvent.click(remove))
  expect(onApply).toHaveBeenCalledExactlyOnceWith(null)
})

test('a refreshed order retains the discount draft and updates its exact preview without extra steps', async () => {
  const props = { onApply: vi.fn(), onCancel: vi.fn() }
  const { rerender } = render(<OrderDiscountEditor {...props} order={order} />)
  fireEvent.click(screen.getByRole('button', { name: '15%' }))
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cortesía' } })
  rerender(<OrderDiscountEditor {...props} order={{ ...order, revision: 3, grossCents: 5_001 }} />)
  expect((screen.getByLabelText('Porcentaje') as HTMLInputElement).value).toBe('15%')
  expect((screen.getByLabelText('Motivo') as HTMLInputElement).value).toBe('Cortesía')
  expect(screen.getByText('−$7.50')).toBeTruthy()
  expect(screen.getByText('$42.51')).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect((screen.getByRole('button', { name: 'Aplicar descuento' }) as HTMLButtonElement).disabled).toBe(false)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' })))
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith({ kind: 'percent', value: 1_500, reason: 'Cortesía' })
})

test('scoped discounts preview the eligible subtotal and send criteria without changing other items', async () => {
  const onApply = vi.fn()
  const value = { ...order, items: [{ productId: '00000000-0000-4000-8000-000000000001', name: 'Café', category: 'Bebidas', grossCents: 3500 }, { productId: '00000000-0000-4000-8000-000000000002', name: 'Pan', category: 'Comidas', grossCents: 16_000 }] } as OperationalOrder
  render(<OrderDiscountEditor order={value} onApply={onApply} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Aplicar descuento a' }), { target: { value: 'selected' } })
  fireEvent.click(screen.getByRole('button', { name: '10%' }))
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Promo bebidas' } })
  expect((screen.getByRole('button', { name: 'Aplicar descuento' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Categoría: Bebidas' }))
  expect(screen.getByText('−$3.50')).toBeTruthy()
  expect(screen.getByText('$191.50')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' })))
  expect(onApply).toHaveBeenCalledExactlyOnceWith({ kind: 'percent', value: 1000, reason: 'Promo bebidas', scope: { productIds: [], categories: ['Bebidas'] } })
})

test('an order with 25 categories limits the draft to 24 and lets the user replace a selected category', async () => {
  const categories = Array.from({ length: 25 }, (_, index) => `Categoría ${String(index + 1).padStart(2, '0')}`)
  const value = { ...order, grossCents: 25_025, items: categories.map(category => ({ productId: null, name: category, category, grossCents: 1001 })) } as OperationalOrder
  const onApply = vi.fn()
  render(<OrderDiscountEditor order={value} onApply={onApply} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Aplicar descuento a' }), { target: { value: 'selected' } })
  fireEvent.click(screen.getByRole('button', { name: '10%' }))
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cortesía' } })
  for (const category of categories.slice(0, 24)) fireEvent.click(screen.getByRole('checkbox', { name: `Categoría: ${category}` }))
  const last = screen.getByRole('checkbox', { name: 'Categoría: Categoría 25' }) as HTMLInputElement
  expect(last.disabled).toBe(true)
  expect(last.checked).toBe(false)
  expect(screen.getByText('Máximo 24 categorías. Desmarca una para elegir otra.')).toBeTruthy()
  // A dispatched event must not bypass the same guard used by disabled controls.
  fireEvent.click(last)
  expect(last.checked).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Categoría: Categoría 01' }))
  expect(last.disabled).toBe(false)
  fireEvent.click(last)
  expect(last.checked).toBe(true)
  expect(screen.getByText('−$24.02')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' })))
  expect(onApply).toHaveBeenCalledExactlyOnceWith({ kind: 'percent', value: 1000, reason: 'Cortesía', scope: { productIds: [], categories: categories.slice(1) } })
})

test('inherited criteria outside the current account stay visible, preserve the draft and can be removed explicitly', async () => {
  const currentId = '00000000-0000-4000-8000-000000000001', absentId = '00000000-0000-4000-8000-000000000002'
  const scope = { productIds: [currentId, absentId], categories: ['Bebidas', 'Postres'] }
  const value = { ...order, grossCents: 1001, items: [{ productId: currentId, name: 'Café', category: 'Bebidas', grossCents: 1001 }], discount: { kind: 'percent', value: 1000, reason: 'Cortesía', scope, promotion: { id: '00000000-0000-4000-8000-000000000003', revision: 1, name: 'Biblioteca anterior' } } } as OperationalOrder
  const onApply = vi.fn()
  render(<OrderDiscountEditor order={value} onApply={onApply} onCancel={vi.fn()} />)
  const absentProduct = screen.getByRole('checkbox', { name: 'Producto fuera de esta cuenta 1' }) as HTMLInputElement
  const absentCategory = screen.getByRole('checkbox', { name: 'Categoría: Postres' }) as HTMLInputElement
  expect(absentProduct.checked).toBe(true)
  expect(absentCategory.checked).toBe(true)
  expect(screen.getByText('Los criterios fuera de esta cuenta se conservan. Desmárcalos para quitarlos.')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Guardar descuento' })))
  expect(onApply).toHaveBeenNthCalledWith(1, { kind: 'percent', value: 1000, reason: 'Cortesía', scope })
  fireEvent.click(absentProduct)
  fireEvent.click(absentCategory)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Guardar descuento' })))
  expect(onApply).toHaveBeenNthCalledWith(2, { kind: 'percent', value: 1000, reason: 'Cortesía', scope: { productIds: [currentId], categories: ['Bebidas'] } })
})
