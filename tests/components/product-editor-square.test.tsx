// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import ProductEditor from '../../src/components/ProductEditor'
import { emptyDetails } from '../../src/lib/product-details'
import { posRequest } from '../../src/lib/pos'
import type { Product, ProductDetails } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function product(details: Partial<ProductDetails> = {}): Product {
  return { id: '00000000-0000-4000-a000-000000000001', name: 'Latte sintético', category: 'Café', priceCents: 4500, active: true, version: 2, details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, ...details } }
}
function editor(value: Product | null = product(), products: Product[] = []) {
  const saved = vi.fn()
  vi.mocked(posRequest).mockResolvedValue(value ?? product())
  const view = render(<ProductEditor product={value} products={products} access={{ businessId: 'business', operatorToken: 'a'.repeat(64) }} onSaved={saved} onClose={vi.fn()} onRefresh={vi.fn()} />)
  return { ...view, saved, submit: () => fireEvent.submit(view.container.querySelector('form')!) }
}

test('editing an open-price product preserves that mode and saves canonical zero instead of demanding a fixed price', async () => {
  const view = editor(product({ variablePrice: true, sku: 'KEEP', kitchenName: 'Preparación' }))
  expect((screen.getByRole('radio', { name: /^Precio abierto/ }) as HTMLInputElement).checked).toBe(true)
  expect(screen.queryByLabelText('Precio final MXN')).toBeNull()
  view.submit()
  await waitFor(() => expect(posRequest).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ command: 'save_product', priceCents: 0, details: expect.objectContaining({ variablePrice: true, sku: 'KEEP', kitchenName: 'Preparación' }) })))
})

test('new identity and nutrition fields remain in the persisted product details', async () => {
  const view = editor()
  fireEvent.change(screen.getByLabelText('Nombre para el cliente'), { target: { value: 'Latte de la casa' } })
  fireEvent.change(screen.getByLabelText('Nombre para cocina'), { target: { value: 'LT CAL' } })
  fireEvent.change(screen.getByLabelText('Código de barras / GTIN'), { target: { value: '7501234567890' } })
  fireEvent.change(screen.getByLabelText('Calorías por porción'), { target: { value: '120' } })
  fireEvent.change(screen.getByLabelText('Preferencias alimentarias'), { target: { value: 'Vegetariano' } })
  fireEvent.change(screen.getByLabelText('Alérgenos (opcional)'), { target: { value: 'Leche' } })
  fireEvent.change(screen.getByLabelText('Etiqueta corta'), { target: { value: 'LATTE' } })
  fireEvent.click(screen.getByRole('button', { name: 'Verde claro' }))
  view.submit()
  await waitFor(() => expect(posRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ customerName: 'Latte de la casa', kitchenName: 'LT CAL', barcode: '7501234567890', calories: 120, dietary: 'Vegetariano', allergens: 'Leche', tileLabel: 'LATTE', tileColor: '#DAEBD9' }) })))
})

test('an existing digital item remains editable without silently changing its type', async () => {
  const view = editor(product({ itemType: 'digital' }))
  expect((screen.getByLabelText('Tipo de producto') as HTMLSelectElement).value).toBe('digital')
  view.submit()
  await waitFor(() => expect(posRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ itemType: 'digital' }) })))
})

test('switching to open price requires explicitly removing existing variants', () => {
  editor(product({ variations: [{ id: 'variation', name: 'Grande', priceCents: 5000, sku: '', barcode: '', soldOut: false }] }))
  expect((screen.getByRole('radio', { name: /^Precio abierto/ }) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByText('Quita las variantes para activar el precio abierto.')).toBeTruthy()
  expect((screen.getByLabelText('Variante 1') as HTMLInputElement).value).toBe('Grande')
  fireEvent.click(screen.getByRole('button', { name: 'Quitar variante 1' }))
  expect((screen.getByRole('radio', { name: /^Precio abierto/ }) as HTMLInputElement).disabled).toBe(false)
})

test('clearing a monetary option fails visibly instead of saving its former value or coercing zero', () => {
  const view = editor(product({ variations: [{ id: 'variation', name: 'Grande', priceCents: 5000, sku: '', barcode: '', soldOut: false }] }))
  fireEvent.change(screen.getByLabelText('Precio de variante 1'), { target: { value: '' } })
  view.submit()
  expect(posRequest).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('Para una opción sin costo escribe 0')
})

test('combination preview only appends after explicit confirmation and keeps existing variation state', async () => {
  const old = { id: 'existing', name: 'Chico', priceCents: 4200, sku: 'KEEP', barcode: '750123', soldOut: true }
  const view = editor(product({ variations: [old] }))
  fireEvent.change(screen.getByLabelText('Nombre de opción 1'), { target: { value: 'Tamaño' } })
  fireEvent.change(screen.getByLabelText('Valores de opción 1'), { target: { value: 'Chico, Grande' } })
  expect(screen.queryByLabelText('Variante 2')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Añadir combinaciones' }))
  expect((screen.getByLabelText('Variante 2') as HTMLInputElement).value).toBe('Grande')
  view.submit()
  await waitFor(() => expect(posRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ variations: [old, expect.objectContaining({ name: 'Grande', priceCents: 4500 })] }) })))
})

test('reusing a saved tenant image references it without reuploading image data', async () => {
  const imageId = '00000000-0000-4000-a000-000000000010'
  const source = { ...product({ imageId }), id: 'other', image: 'data:image/jpeg;base64,c3ludGhldGlj' }
  const view = editor(product(), [source])
  fireEvent.change(screen.getByLabelText('Usar imagen de otro producto'), { target: { value: 'other' } })
  view.submit()
  await waitFor(() => expect(posRequest).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ command: 'save_product', details: expect.objectContaining({ imageId }) })))
})

test('a response-loss retry retains the accepted payload and operation instead of creating a new save', async () => {
  const view = editor(product({ variablePrice: true }))
  vi.mocked(posRequest).mockRejectedValueOnce(new Error('Respuesta perdida')).mockResolvedValueOnce(product({ variablePrice: true }))
  view.submit()
  await screen.findByText('Respuesta perdida')
  const first = vi.mocked(posRequest).mock.calls[0][1]
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }))
  await waitFor(() => expect(posRequest).toHaveBeenCalledTimes(2))
  expect(vi.mocked(posRequest).mock.calls[1][1]).toEqual(first)
  expect(view.saved).toHaveBeenCalledTimes(1)
})

test('custom attributes and direct-add preference persist only when selected', async () => {
  const view = editor()
  fireEvent.click(screen.getByRole('button', { name: 'Añadir atributo' }))
  fireEvent.change(screen.getByLabelText('Nombre de atributo 1'), { target: { value: ' Origen ' } })
  fireEvent.change(screen.getByLabelText('Valor de atributo 1'), { target: { value: ' Oaxaca ' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /^Agregar directo cuando sea posible/ }))
  view.submit()
  await waitFor(() => expect(posRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: expect.objectContaining({ skipCustomization: true, customAttributes: [{ name: 'Origen', value: 'Oaxaca' }] }) })))
})

test('duplicate custom attribute names are rejected without a backend mutation', () => {
  const view = editor(product({ customAttributes: [{ name: 'Origen', value: 'Oaxaca' }, { name: ' origen ', value: 'Chiapas' }] }))
  view.submit()
  expect(posRequest).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('nombres diferentes')
})

test('copied modifier groups retain settings and prices but receive independent identities', async () => {
  const source = product({ modifierSets: [{ id: 'source-group', name: 'Leche', min: 0, max: 1, options: [{ id: 'source-option', name: 'Avena', priceCents: 1200 }] }] })
  source.id = 'other'
  const view = editor(product(), [source])
  fireEvent.change(screen.getByLabelText('Copiar extras de otro producto'), { target: { value: 'other' } })
  fireEvent.click(screen.getByRole('button', { name: 'Añadir grupos copiados' }))
  view.submit()
  await waitFor(() => expect(posRequest).toHaveBeenCalledTimes(1))
  const command = vi.mocked(posRequest).mock.calls[0][1]
  if (command.command !== 'save_product') throw new Error('Expected save_product')
  const copied = command.details!.modifierSets[0]
  expect(copied).toMatchObject({ name: 'Leche', min: 0, max: 1, options: [expect.objectContaining({ name: 'Avena', priceCents: 1200 })] })
  expect(copied.id).not.toBe('source-group')
  expect(copied.options[0].id).not.toBe('source-option')
})

test('partial legacy metadata in another catalog product does not break the editor', () => {
  const legacy = { ...product(), id: 'legacy-product', details: { taxTreatment: 'vat_16', taxBps: 1600 } as ProductDetails }
  editor(product(), [legacy])
  expect(screen.getByRole('dialog', { name: 'Editar producto' })).toBeTruthy()
  expect((screen.getByLabelText('Nombre') as HTMLInputElement).value).toBe('Latte sintético')
  expect(screen.queryByLabelText('Copiar extras de otro producto')).toBeNull()
  expect(screen.getByRole('button', { name: 'Guardar producto' })).toBeTruthy()
})
