// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import PromotionManager from '../../src/components/PromotionManager'
import SavedPromotionPicker from '../../src/features/operations/SavedPromotionPicker'
import { posRequest } from '../../src/lib/pos'
import type { Promotion } from '../../src/lib/promotion-contracts'
import type { Product } from '../../src/lib/pos-contracts'
import type { OperationalOrder } from '../../src/lib/operations-contracts'
import type { OperationalMutation } from '../../src/features/operations/useOperations'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const access = { businessId: id(1), operatorToken: 'synthetic-owner-memory' }
const product = { id: id(2), name: 'Café', category: 'Bebidas' } as Product
const promotion: Promotion = { id: id(3), revision: 1, name: 'Bebidas 10 %', active: true, kind: 'percent', value: 1000, scope: { productIds: [], categories: ['Bebidas'] } }
const order = { grossCents: 7000, items: [{ productId: id(2), name: 'Café', category: 'Bebidas', grossCents: 3500 }, { productId: id(4), name: 'Pan', category: 'Comidas', grossCents: 3500 }] } as OperationalOrder
beforeEach(() => vi.mocked(posRequest).mockResolvedValue({ promotions: [] }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('promotion management persists exact cents, selectors and version through the operational mutation', async () => {
  const execute = vi.fn(async command => ({ ...promotion, id: command.promotionId }))
  const mutation = { execute, pending: null, busy: false, lastResult: null } as unknown as OperationalMutation
  render(<PromotionManager access={access} products={[product]} mutation={mutation} />)
  fireEvent.click(screen.getByRole('button', { name: 'Crear promoción' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: '  Bebidas   10 % ' } })
  expect((screen.getByRole('button', { name: 'Guardar promoción' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Categoría: Bebidas' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Guardar promoción' })))
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'save_promotion', expectedRevision: null, name: 'Bebidas 10 %', kind: 'percent', value: 1000, active: true, scope: { productIds: [], categories: ['Bebidas'] } }))
  expect(execute.mock.calls[0][0].operationId).toMatch(/^[0-9a-f-]{36}$/)
  expect(screen.queryByRole('textbox', { name: 'Nombre' })).toBeNull()
})

test('saved promotions preview only matching snapshot lines and require an explicit apply action', async () => {
  vi.mocked(posRequest).mockResolvedValue({ promotions: [promotion] })
  const onApply = vi.fn()
  render(<SavedPromotionPicker access={access} order={order} disabled={false} onApply={onApply} />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Promoción' }), { target: { value: promotion.id } })
  expect(screen.getByText('Descuento: −$3.50 · Total: $66.50')).toBeTruthy()
  expect(onApply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: `Aplicar ${promotion.name}` }))
  expect(onApply).toHaveBeenCalledExactlyOnceWith(promotion)
})

test('a fixed promotion cannot subtract more than the eligible subtotal', async () => {
  vi.mocked(posRequest).mockResolvedValue({ promotions: [{ ...promotion, kind: 'fixed', value: 3501 }] })
  render(<SavedPromotionPicker access={access} order={order} disabled={false} onApply={vi.fn()} />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Promoción' }), { target: { value: promotion.id } })
  expect((screen.getByRole('button', { name: `Aplicar ${promotion.name}` }) as HTMLButtonElement).disabled).toBe(true)
})

test('a late library response cannot restore data after switching the operator session', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(posRequest).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never).mockResolvedValue({ promotions: [] })
  const view = render(<SavedPromotionPicker access={access} order={order} disabled={false} onApply={vi.fn()} />)
  view.rerender(<SavedPromotionPicker access={{ ...access, operatorToken: 'new-synthetic-operator' }} order={order} disabled={false} onApply={vi.fn()} />)
  await screen.findByText('Puedes crear promociones por producto o categoría desde Productos.')
  await act(async () => finish({ promotions: [promotion] }))
  expect(screen.queryByRole('combobox', { name: 'Promoción' })).toBeNull()
})

test('malformed library selectors become a visible retry error rather than crashing checkout', async () => {
  vi.mocked(posRequest).mockResolvedValue({ promotions: [{ ...promotion, scope: { productIds: null, categories: ['Bebidas'] } }] })
  render(<SavedPromotionPicker access={access} order={order} disabled={false} onApply={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Reintentar promociones' })).toBeTruthy()
})

test('a loaded library can refresh a changed promotion while retaining selection and requiring explicit application', async () => {
  const revised = { ...promotion, revision: 2, name: 'Bebidas 20 %', value: 2000 }
  let finish!: (value: { promotions: Promotion[] }) => void
  vi.mocked(posRequest).mockResolvedValueOnce({ promotions: [promotion] }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
  const onApply = vi.fn()
  render(<SavedPromotionPicker access={access} order={order} disabled={false} onApply={onApply} />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Promoción' }), { target: { value: promotion.id } })
  expect(screen.getByText('Descuento: −$3.50 · Total: $66.50')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar promociones' }))
  expect(screen.getByText('Consultando promociones…')).toBeTruthy()
  expect(screen.queryByRole('button', { name: `Aplicar ${promotion.name}` })).toBeNull()
  await act(async () => finish({ promotions: [revised] }))
  expect((screen.getByRole('combobox', { name: 'Promoción' }) as HTMLSelectElement).value).toBe(promotion.id)
  expect(screen.getByText('Descuento: −$7.00 · Total: $63.00')).toBeTruthy()
  expect(posRequest).toHaveBeenCalledTimes(2)
  expect(posRequest).toHaveBeenLastCalledWith(access, { command: 'promotions' })
  expect(onApply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: `Aplicar ${revised.name}` }))
  expect(onApply).toHaveBeenCalledExactlyOnceWith(revised)
})

test('an empty loaded library can refresh, while a pending parent action blocks that control', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce({ promotions: [] }).mockResolvedValueOnce({ promotions: [promotion] })
  const props = { access, order, onApply: vi.fn() }
  const view = render(<SavedPromotionPicker {...props} disabled={true} />)
  const refresh = await screen.findByRole('button', { name: 'Actualizar promociones' }) as HTMLButtonElement
  expect(refresh.disabled).toBe(true)
  fireEvent.click(refresh)
  expect(posRequest).toHaveBeenCalledOnce()
  view.rerender(<SavedPromotionPicker {...props} disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar promociones' }))
  expect(await screen.findByRole('combobox', { name: 'Promoción' })).toBeTruthy()
  expect(posRequest).toHaveBeenCalledTimes(2)
  expect(props.onApply).not.toHaveBeenCalled()
})
