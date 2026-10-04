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
