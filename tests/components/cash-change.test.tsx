// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import CashChangeCalculator from '../../src/components/CashChangeCalculator'
afterEach(cleanup)

test('cash change uses exact cents and does not permit an insufficient tender', () => {
  const onValidChange = vi.fn()
  render(<CashChangeCalculator totalCents={3501} disabled={false} onValidChange={onValidChange} />)
  expect(onValidChange).toHaveBeenLastCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: 'Calcular cambio' }))
  expect(onValidChange).toHaveBeenLastCalledWith(false)
  fireEvent.change(screen.getByRole('textbox', { name: 'Efectivo recibido' }), { target: { value: '35.00' } })
  expect(onValidChange).toHaveBeenLastCalledWith(false)
  expect(screen.getByText('El efectivo recibido debe cubrir $35.01.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '$50.00' }))
  expect(screen.getByText('$14.99')).toBeTruthy()
  expect(onValidChange).toHaveBeenLastCalledWith(true)
})

test('changing a split or discount clears the previous tender before showing another payment', () => {
  const onValidChange = vi.fn()
  const view = render(<CashChangeCalculator totalCents={3500} disabled={false} onValidChange={onValidChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Calcular cambio' }))
  fireEvent.click(screen.getByRole('button', { name: '$50.00' }))
  view.rerender(<CashChangeCalculator totalCents={2000} disabled={false} onValidChange={onValidChange} />)
  expect((screen.getByRole('textbox', { name: 'Efectivo recibido' }) as HTMLInputElement).value).toBe('')
  expect(screen.queryByText('$15.00')).toBeNull()
  expect(onValidChange).toHaveBeenLastCalledWith(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar importe exacto' }))
  expect(onValidChange).toHaveBeenLastCalledWith(true)
})

test('cash counting controls cannot change the payment while its request is in progress', () => {
  const view = render(<CashChangeCalculator totalCents={3500} disabled={false} onValidChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Calcular cambio' }))
  view.rerender(<CashChangeCalculator totalCents={3500} disabled onValidChange={vi.fn()} />)
  expect((screen.getByRole('textbox', { name: 'Efectivo recibido' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '$50.00' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Cobrar importe exacto' }) as HTMLButtonElement).disabled).toBe(true)
})
