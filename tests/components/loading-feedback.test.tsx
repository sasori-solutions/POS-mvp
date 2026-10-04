// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import LoadingPlaceholder from '../../src/components/LoadingPlaceholder'
import { PosDialog } from '../../src/components/PosShared'
import PaymentMethodPicker from '../../src/components/PaymentMethodPicker'

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.removeAttribute('open') } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

test.each(['list', 'form', 'catalog', 'cards', 'detail', 'chart', 'page'] as const)('the %s module uses shapes with an accessible loading name and no visible loading copy', variant => {
  render(<LoadingPlaceholder variant={variant} label="Cargando módulo" />)
  const loading = screen.getByRole('status', { name: 'Cargando módulo' })
  expect(loading.getAttribute('aria-busy')).toBe('true')
  expect(loading.textContent).toBe('')
  expect(loading.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(0)
})

test('catalog loading can retain its existing filters without drawing duplicates', () => {
  const { container } = render(<LoadingPlaceholder variant="catalog" filters={false} rows={6} />)
  expect(container.querySelector('.ui-placeholder-search')).toBeNull()
  expect(container.querySelectorAll('.ui-placeholder-image')).toHaveLength(6)
})

test('overlapping dialogs have unique headings and retain the requested module class', () => {
  const onClose = vi.fn()
  render(<><PosDialog title="Editar cuenta" className="order-editor-dialog" onClose={onClose}><p>Cuenta</p></PosDialog><PosDialog title="Extras" className="product-selection-dialog" onClose={vi.fn()}><p>Presentación</p></PosDialog></>)
  const order = screen.getByRole('dialog', { name: 'Editar cuenta' })
  const extras = screen.getByRole('dialog', { name: 'Extras' })
  expect(order.getAttribute('aria-labelledby')).not.toBe(extras.getAttribute('aria-labelledby'))
  expect(order.classList.contains('order-editor-dialog')).toBe(true)
  expect(extras.classList.contains('product-selection-dialog')).toBe(true)
  fireEvent.click(order.querySelector('button')!)
  expect(onClose).toHaveBeenCalledOnce()
})

test.each([1, 2])('payment methods use all available columns without inactive empty slots: %s', count => {
  const methods = count === 1 ? ['cash'] as const : ['cash', 'transfer'] as const
  render(<PaymentMethodPicker methods={[...methods]} value="cash" disabled={false} onChange={vi.fn()} name="payment" />)
  expect(screen.getByRole('group', { name: 'Método de pago' }).style.getPropertyValue('--payment-columns')).toBe(String(methods.length))
  expect(screen.getAllByRole('radio')).toHaveLength(methods.length)
})
