// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import ProductEditor from '../../src/components/ProductEditor'
import ProductSelection from '../../src/components/ProductSelection'
import { emptyDetails } from '../../src/lib/product-details'
import { posRequest } from '../../src/lib/pos'
import type { Product } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const access = { businessId: 'synthetic', operatorToken: 'a'.repeat(64) }
const details = () => ({ ...emptyDetails(), taxTreatment: 'vat_16' as const, taxBps: 1600 })
const base: Product = { id: '00000000-0000-4000-a000-000000000001', name: 'Café sintético', category: '', priceCents: 501, version: 1, active: true, details: details() }
const nested: Product = { ...base, details: { ...details(), modifierSets: [
  { id: 'preparation', name: 'Preparación', min: 1, max: 1, options: [{ id: 'milk', name: 'Con leche', priceCents: 100 }, { id: 'black', name: 'Negro', priceCents: 0 }] },
  { id: 'milk-type', name: 'Leche', parentOptionId: 'milk', min: 1, max: 1, options: [{ id: 'oat', name: 'Avena', priceCents: 101 }] },
  { id: 'temperature', name: 'Temperatura', parentOptionId: 'oat', min: 1, max: 1, options: [{ id: 'hot', name: 'Caliente', priceCents: -50 }] },
] } }

test('changing a parent removes hidden required descendants before committing a new selection', () => {
  const add = vi.fn()
  render(<ProductSelection product={nested} onAdd={add} onClose={vi.fn()} />)
  expect(screen.queryByRole('radio', { name: /Avena/ })).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: /Con leche/ }))
  expect((screen.getByRole('button', { name: /Agregar ·/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: /Avena/ }))
  fireEvent.click(screen.getByRole('radio', { name: /Caliente/ }))
  expect((screen.getByRole('button', { name: 'Agregar · $6.52' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('radio', { name: /Negro/ }))
  expect(screen.queryByRole('radio', { name: /Avena/ })).toBeNull()
  expect(screen.queryByRole('radio', { name: /Caliente/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Agregar · $5.01' }))
  expect(add).toHaveBeenCalledWith({ variationId: null, modifierIds: ['black'], variablePriceCents: null })
})

test('an unavailable mandatory child disables only its parent branch with a visible reason', () => {
  const product = { ...nested, details: { ...nested.details!, modifierSets: nested.details!.modifierSets.map(group => group.id === 'milk-type' ? { ...group, options: group.options.map(option => ({ ...option, soldOut: true })) } : group) } }
  render(<ProductSelection product={product} onAdd={vi.fn()} onClose={vi.fn()} />)
  expect((screen.getByRole('radio', { name: /Con leche/ }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText('No disponible: faltan opciones de preparación')).toBeTruthy()
  expect((screen.getByRole('radio', { name: /Negro/ }) as HTMLInputElement).disabled).toBe(false)
})

test('a fixed combo explicitly captures repeated component extras without adding component prices or submitting the product early', async () => {
  const child: Product = { ...base, id: '00000000-0000-4000-a000-000000000002', priceCents: 11600, details: { ...details(), modifierSets: [{ id: 'shots', name: 'Shots', min: 1, max: 2, options: [{ id: 'shot', name: 'Shot', priceCents: 101, maxQuantity: 2 }] }] } }
  const combo = { ...base, name: 'Desayuno', priceCents: 5001 }, saved = vi.fn()
  vi.mocked(posRequest).mockResolvedValue(combo)
  const view = render(<ProductEditor product={combo} products={[child]} access={access} onClose={vi.fn()} onSaved={saved} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Configurar como combo' }))
  fireEvent.change(screen.getByLabelText('Agregar al combo'), { target: { value: child.id } })
  fireEvent.click(screen.getByRole('button', { name: 'Añadir componente' }))
  fireEvent.click(screen.getByRole('button', { name: 'Añadir Shot' })); fireEvent.click(screen.getByRole('button', { name: 'Añadir Shot' }))
  fireEvent.click(screen.getByRole('button', { name: 'Agregar · $118.02' }))
  expect(posRequest).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Cantidad de Café sintético'), { target: { value: '2' } })
  fireEvent.submit(view.container.querySelector('form')!)
  await waitFor(() => expect(posRequest).toHaveBeenCalledExactlyOnceWith(access, expect.objectContaining({ priceCents: 5001, details: expect.objectContaining({ comboComponents: [{ productId: child.id, version: 1, quantity: 2, selection: { variationId: null, modifierIds: ['shot', 'shot'], variablePriceCents: null } }] }) })))
})

test('an unrelated edit preserves a configured combo snapshot after a component version changes', async () => {
  const child = { ...base, id: '00000000-0000-4000-a000-000000000002', version: 2 }, components = [{ productId: child.id, version: 1, quantity: 2 }]
  const combo = { ...base, name: 'Desayuno', details: { ...details(), comboComponents: components } }
  vi.mocked(posRequest).mockResolvedValue(combo)
  const view = render(<ProductEditor product={combo} products={[child]} access={access} onClose={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()} />)
  fireEvent.change(screen.getByLabelText(/Categoría/), { target: { value: 'Combos' } })
  fireEvent.submit(view.container.querySelector('form')!)
  await waitFor(() => expect(posRequest).toHaveBeenCalledWith(access, expect.objectContaining({ category: 'Combos', details: expect.objectContaining({ comboComponents: components }) })))
})

test('changing preparation requires reselecting a changed component and displays the persisted public contents', () => {
  const child = { ...base, id: '00000000-0000-4000-a000-000000000002', version: 2 }, combo = { ...base, details: { ...details(), comboComponents: [{ productId: child.id, version: 1, quantity: 2 }] }, comboComponents: [{ productId: child.id, version: 1, quantity: 2, name: 'Café anterior', kitchenName: 'CAFE INTERNO', selectionLabel: '2 × Shot' }] }
  const view = render(<ProductEditor product={combo} products={[child]} access={access} onClose={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Cantidad de Café sintético'), { target: { value: '3' } })
  fireEvent.submit(view.container.querySelector('form')!)
  expect(posRequest).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('vuelve a elegir su preparación')
  cleanup()
  render(<ProductSelection product={combo} onClose={vi.fn()} onAdd={vi.fn()} />)
  expect(screen.getByRole('list', { name: 'Componentes del combo' }).textContent).toBe('2 × Café anterior · 2 × Shot')
  expect(screen.queryByText('CAFE INTERNO')).toBeNull()
})
