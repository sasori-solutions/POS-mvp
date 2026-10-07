// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import ProductSelection from '../../src/components/ProductSelection'
import ProductEditor from '../../src/components/ProductEditor'
import ModifierLibrary from '../../src/components/ModifierLibrary'
import { AccountClientError } from '../../src/lib/account'
import { emptyDetails } from '../../src/lib/product-details'
import { posRequest } from '../../src/lib/pos'
import type { Product, SharedModifierGroup } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const group: SharedModifierGroup = { id: 'group', version: 2, name: 'Extras', min: 1, max: 3, linkedProducts: [{ id: 'coffee', name: 'Café' }, { id: 'latte', name: 'Latte' }], options: [{ id: 'shot', name: 'Shot', priceCents: 101, maxQuantity: 2 }, { id: 'milk', name: 'Sin leche', priceCents: -300 }, { id: 'oat', name: 'Avena', priceCents: 0, soldOut: true }] }
const product: Product = { id: 'coffee', name: 'Café', category: '', priceCents: 1001, version: 1, active: true, details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, modifierSets: [{ id: group.id, name: group.name, min: group.min, max: group.max, options: group.options }] } }
const access = { businessId: 'synthetic', operatorToken: 'a'.repeat(64) }

test('whole extras use bounded touch steppers, signed totals and visible availability', () => {
  const added = vi.fn()
  render(<ProductSelection product={product} onClose={vi.fn()} onAdd={added} />)
  const plus = screen.getByRole('button', { name: 'Añadir Shot' }) as HTMLButtonElement
  fireEvent.click(plus); fireEvent.click(plus)
  expect(screen.getByLabelText('Unidades de Shot').textContent).toBe('2')
  expect(plus.disabled).toBe(true)
  expect((screen.getByRole('checkbox', { name: /Avena/ }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /Sin leche/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Agregar · $9.03' }))
  expect(added).toHaveBeenCalledWith({ variationId: null, modifierIds: ['shot', 'shot', 'milk'], variablePriceCents: null })
})

test('mandatory groups without sufficient available units block adding with an explicit reason', () => {
  render(<ProductSelection product={{ ...product, details: { ...product.details!, modifierSets: [{ ...product.details!.modifierSets[0], options: group.options.map(option => ({ ...option, soldOut: true })) }] } }} onClose={vi.fn()} onAdd={vi.fn()} />)
  expect(screen.getByRole('alert').textContent).toContain('Extras: no hay suficientes opciones')
  expect((screen.getByRole('button', { name: /Agregar ·/ }) as HTMLButtonElement).disabled).toBe(true)
})

test('an adjustment below zero stays visible and blocks committing the selection', () => {
  render(<ProductSelection product={{ ...product, priceCents: 100 }} onClose={vi.fn()} onAdd={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox', { name: /Sin leche/ }))
  expect(screen.getByRole('alert').textContent).toContain('entre $0.00')
  expect((screen.getByRole('button', { name: /Agregar ·/ }) as HTMLButtonElement).disabled).toBe(true)
})

test('shared editor exposes affected products and freezes the exact payload after response loss', async () => {
  const saved = vi.fn()
  vi.mocked(posRequest).mockResolvedValueOnce({ groups: [group] }).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Sin conexión')).mockResolvedValueOnce({ group: { ...group, version: 3 }, products: [] }).mockResolvedValue({ groups: [group] })
  render(<ModifierLibrary access={access} onProductsChanged={saved} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Editar grupo Extras' }))
  expect(screen.getByText(/Se actualizarán 2 productos: Café, Latte/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Grupo 1'), { target: { value: 'Extras de barra' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar para todos los productos' }))
  const retry = await screen.findByRole('button', { name: 'Reintentar cambio' })
  expect(screen.getByLabelText('Grupo 1').matches(':disabled')).toBe(true)
  const command = vi.mocked(posRequest).mock.calls[1][1]
  fireEvent.click(retry)
  await waitFor(() => expect(saved).toHaveBeenCalledWith([]))
  expect(vi.mocked(posRequest).mock.calls[2][1]).toEqual(command)
  expect(command).toMatchObject({ command: 'save_modifier_group', expectedVersion: 2, name: 'Extras de barra', options: [expect.objectContaining({ maxQuantity: 2 }), expect.objectContaining({ priceCents: -300 }), expect.objectContaining({ soldOut: true })] })
})

test('product editor links canonical groups and offers a separate independent copy', async () => {
  vi.mocked(posRequest).mockResolvedValue({ groups: [group] })
  render(<ProductEditor product={{ ...product, details: { ...product.details!, modifierSets: [] } }} products={[]} access={access} onClose={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Enlazar grupo de biblioteca' }))
  await screen.findByRole('option', { name: 'Extras · 2 productos' })
  fireEvent.change(screen.getByLabelText('Grupo compartido'), { target: { value: group.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Enlazar a este producto' }))
  expect(screen.getByText(/Grupo compartido · edítalo/)).toBeTruthy()
  expect(screen.queryByLabelText('Grupo 1')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Convertir en copia independiente' }))
  expect((screen.getByLabelText('Grupo 1') as HTMLInputElement).value).toBe('Extras')
  expect((screen.getByLabelText('Máximo de Shot') as HTMLInputElement).value).toBe('2')
})
