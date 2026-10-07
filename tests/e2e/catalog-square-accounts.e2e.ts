import { test, expect, type Page } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { mockPos } from './pos-fixture'
import { enterOperations, openOperationalTask, submitPinIfPresent } from './workspace-flow'
import { emptyDetails } from '../../src/lib/product-details'
import type { Product, ProductDetails, Sale } from '../../src/lib/pos-contracts'
import type { KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'

type Backend = Awaited<ReturnType<typeof mockPos>>
// Preview fixtures default to counter checkout; these scenarios explicitly own a service business.
const serviceFixture = { empty: true, accountsEnabled: true } satisfies NonNullable<Parameters<typeof mockPos>[1]>

async function seeded(backend: Backend, name: string, overrides: Partial<ProductDetails> = {}, priceCents = 5801) {
  return backend.execute<Product>({ command: 'save_product', operationId: crypto.randomUUID(), productId: crypto.randomUUID(),
    expectedVersion: null, name, category: 'Pruebas', priceCents,
    details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, ...overrides } })
}
async function accounts(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page)
  await enterOperations(page)
  await openOperationalTask(page, 'Comandas')
  await page.getByRole('group', { name: 'Comandas y cuentas', exact: true }).getByRole('button', { name: 'Cuentas', exact: true }).click()
}
async function openAccount(page: Page, name: string) {
  await page.getByRole('button', { name: 'Abrir cuenta', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Abrir cuenta', exact: true })
  await editor.getByLabel('Nombre de la cuenta', { exact: true }).fill(name)
  return editor
}
async function add(page: Page, name: string) { await page.getByRole('dialog', { name: /^(Abrir|Editar) cuenta$/ }).getByRole('button', { name: new RegExp(`^Agregar ${name},`) }).click() }
async function save(page: Page, backend: Backend, name: string) {
  await page.getByRole('dialog', { name: /^(Abrir|Editar) cuenta$/ }).getByRole('button', { name: 'Guardar cuenta', exact: true }).click()
  await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible()
  const orders = await backend.execute<{ orders: OperationalOrder[] }>({ command: 'orders' })
  return orders.orders.find(order => order.name === name)!
}

test('account editing exposes food details and preserves customer, kitchen and money snapshots through payment', async ({ page }, info) => {
  const backend = await mockPos(page, serviceFixture)
  try {
    const product = await seeded(backend, 'Bowl administrativo', { customerName: 'Bowl de temporada', kitchenName: 'BOWL ORIGINAL',
      description: 'Ensalada de prueba', calories: 410, dietary: 'Vegetariano', allergens: 'Leche, nueces',
      customAttributes: [{ name: 'Origen', value: 'Oaxaca' }] }, 3401)
    await accounts(page)
    const editor = await openAccount(page, 'Cuenta informada')
    await editor.getByRole('button', { name: 'Detalles de Bowl administrativo', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Bowl administrativo', exact: true })
    await expect(details).toContainText('410 kcal')
    await expect(details).toContainText('Vegetariano')
    await expect(details).toContainText('Alérgenos: Leche, nueces')
    await expect(details.getByLabel('Atributos del producto', { exact: true })).toContainText('Oaxaca')
    await details.getByRole('button', { name: 'Cerrar', exact: true }).click()
    await add(page, product.name)
    await expect(page.getByRole('dialog', { name: product.name, exact: true })).not.toBeVisible()
    await expect(editor.locator('.order-editor-subtotal dd')).toHaveText('$34.01')
    const initial = await save(page, backend, 'Cuenta informada')
    expect(initial.items[0]).toMatchObject({ name: 'Bowl de temporada', kitchenName: 'BOWL ORIGINAL', unitPriceCents: 3401 })
    await backend.execute({ command: 'save_product', operationId: crypto.randomUUID(), productId: product.id, expectedVersion: product.version,
      name: product.name, category: product.category, priceCents: 9900,
      details: { ...product.details!, customerName: 'Nuevo nombre', kitchenName: 'NUEVA COCINA' } })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.getByRole('button', { name: 'Editar artículos', exact: true }).click()
    const editing = page.getByRole('dialog', { name: 'Editar cuenta', exact: true })
    await editing.getByRole('button', { name: 'Añadir Bowl de temporada', exact: true }).click()
    await editing.locator('.order-editor-note summary').first().click()
    await editing.getByLabel('Nota de cocina para Bowl de temporada', { exact: true }).fill('Presentación separada')
    await expect(editing.locator('.order-editor-subtotal dd')).toHaveText('$68.02')
    for (const width of [320, 390, 1024]) {
      await page.setViewportSize({ width, height: 940 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const box = await editing.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(-1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
      const detailsButton = editing.getByRole('button', { name: 'Detalles de Bowl administrativo', exact: true })
      const target = await detailsButton.boundingBox()
      expect(target!.height).toBeGreaterThanOrEqual(48)
      expect(target!.width).toBeGreaterThanOrEqual(48)
      await page.screenshot({ path: `artifacts/qa/${info.project.name}-square-account-edit-${width}.png` })
    }
    const updated = await save(page, backend, 'Cuenta informada')
    expect(updated.items[0]).toMatchObject({ name: 'Bowl de temporada', kitchenName: 'BOWL ORIGINAL', quantity: 2, unitPriceCents: 3401, note: 'Presentación separada' })
    expect(updated.totalCents).toBe(6802)
    await page.getByRole('button', { name: 'Enviar a cocina', exact: true }).click()
    await expect.poll(async () => (await backend.execute<{ batches: KitchenBatch[] }>({ command: 'kitchen' })).batches.length).toBe(1)
    const batches = await backend.execute<{ batches: KitchenBatch[] }>({ command: 'kitchen' })
    expect(batches.batches[0].items[0]).toMatchObject({ name: 'BOWL ORIGINAL', quantity: 2, note: 'Presentación separada' })
    await page.getByRole('button', { name: 'Cobrar $68.02', exact: true }).click()
    await page.getByRole('button', { name: 'Registrar pago', exact: true }).click()
    await expect.poll(async () => (await backend.sales()).sales.length).toBe(1)
    const sale = await backend.execute<Sale>({ command: 'sale', saleId: (await backend.sales()).sales[0].id })
    expect(sale.totalCents).toBe(6802)
    expect(sale.items[0]).toMatchObject({ name: 'Bowl de temporada', quantity: 2, unitPriceCents: 3401, totalCents: 6802 })
  } finally { await backend.db.close() }
})

test('account catalog advertises available variant prices and open pricing and saves selected amounts exactly', async ({ page }) => {
  const backend = await mockPos(page, serviceFixture)
  try {
    const varied = await seeded(backend, 'Café con tamaños', { skipCustomization: true, variations: [
      { id: crypto.randomUUID(), name: 'Chico agotado', priceCents: 2000, sku: 'SMALL', barcode: '', soldOut: true },
      { id: crypto.randomUUID(), name: 'Mediano', priceCents: 6203, sku: 'MEDIUM', barcode: '', soldOut: false },
      { id: crypto.randomUUID(), name: 'Grande', priceCents: 7004, sku: 'LARGE', barcode: '', soldOut: false },
    ] }, 5000)
    const open = await seeded(backend, 'Servicio por importe', { variablePrice: true, itemType: 'service', skipCustomization: true }, 0)
    await accounts(page)
    const editor = await openAccount(page, 'Cuenta con opciones')
    await expect(editor.getByRole('button', { name: 'Agregar Café con tamaños, Desde $62.03', exact: true })).toBeVisible()
    await expect(editor.getByRole('button', { name: 'Agregar Servicio por importe, Precio abierto', exact: true })).toBeVisible()
    await add(page, varied.name)
    const variantSelection = page.getByRole('dialog', { name: varied.name, exact: true })
    await expect(variantSelection.getByRole('radio', { name: /Chico agotado/ })).toBeDisabled()
    await variantSelection.getByRole('radio', { name: /Grande/ }).check()
    await variantSelection.getByRole('button', { name: 'Agregar · $70.04', exact: true }).click()
    await add(page, open.name)
    const openSelection = page.getByRole('dialog', { name: open.name, exact: true })
    await openSelection.getByLabel('Precio de esta venta MXN', { exact: true }).fill('49.99')
    await openSelection.getByRole('button', { name: 'Agregar · $49.99', exact: true }).click()
    await expect(editor.locator('.order-editor-subtotal dd')).toHaveText('$120.03')
    const initial = await save(page, backend, 'Cuenta con opciones')
    expect(initial.totalCents).toBe(12003)
    expect(initial.items.map(item => item.unitPriceCents).sort((a, b) => a - b)).toEqual([4999, 7004])
    await page.getByRole('button', { name: 'Editar artículos', exact: true }).click()
    await page.getByRole('dialog', { name: 'Editar cuenta', exact: true }).getByRole('searchbox', { name: 'Buscar producto', exact: true }).fill('MEDIUM')
    await add(page, varied.name)
    await variantSelection.getByRole('radio', { name: /Mediano/ }).check()
    await variantSelection.getByRole('button', { name: 'Agregar · $62.03', exact: true }).click()
    const updated = await save(page, backend, 'Cuenta con opciones')
    expect(updated.totalCents).toBe(18206)
    expect(updated.items.map(item => item.unitPriceCents).sort((a, b) => a - b)).toEqual([4999, 6203, 7004])
  } finally { await backend.db.close() }
})

test('account quick add preserves optional customization while required extras and open prices cannot be skipped', async ({ page }) => {
  const backend = await mockPos(page, serviceFixture)
  try {
    await seeded(backend, 'Café rápido', { skipCustomization: true, modifierSets: [{ id: crypto.randomUUID(), name: 'Leche opcional', min: 0, max: 1,
      options: [{ id: crypto.randomUUID(), name: 'Avena opcional', priceCents: 11 }] }] })
    await seeded(backend, 'Café obligatorio', { skipCustomization: true, modifierSets: [{ id: crypto.randomUUID(), name: 'Leche requerida', min: 1, max: 1,
      options: [{ id: crypto.randomUUID(), name: 'Avena requerida', priceCents: 22 }] }] })
    await seeded(backend, 'Precio capturado', { variablePrice: true, skipCustomization: true }, 0)
    await accounts(page)
    const editor = await openAccount(page, 'Cuenta rápida')
    await add(page, 'Café rápido')
    await expect(page.getByRole('dialog', { name: 'Café rápido', exact: true })).not.toBeVisible()
    await expect(editor.locator('.order-editor-lines > li')).toHaveCount(1)
    await editor.getByRole('button', { name: 'Detalles de Café rápido', exact: true }).click()
    const optionalSelection = page.getByRole('dialog', { name: 'Café rápido', exact: true })
    await optionalSelection.getByRole('radio', { name: /Avena opcional/ }).check()
    await optionalSelection.getByRole('button', { name: 'Agregar · $58.12', exact: true }).click()
    await add(page, 'Café obligatorio')
    const requiredSelection = page.getByRole('dialog', { name: 'Café obligatorio', exact: true })
    await expect(requiredSelection).toBeVisible()
    await expect(requiredSelection.getByRole('button', { name: 'Agregar · $58.01', exact: true })).toBeDisabled()
    await requiredSelection.getByRole('radio', { name: /Avena requerida/ }).check()
    await requiredSelection.getByRole('button', { name: 'Agregar · $58.23', exact: true }).click()
    await add(page, 'Precio capturado')
    const openSelection = page.getByRole('dialog', { name: 'Precio capturado', exact: true })
    await expect(openSelection).toBeVisible()
    await openSelection.getByLabel('Precio de esta venta MXN', { exact: true }).fill('49.99')
    await openSelection.getByRole('button', { name: 'Agregar · $49.99', exact: true }).click()
    await expect(editor.locator('.order-editor-subtotal dd')).toHaveText('$224.35')
    const order = await save(page, backend, 'Cuenta rápida')
    expect(order.totalCents).toBe(22435)
    expect(order.items.map(item => item.unitPriceCents).sort((a, b) => a - b)).toEqual([4999, 5801, 5812, 5823])
  } finally { await backend.db.close() }
})

test('account subtotal guard uses saved prices and recovers without sending an invalid order', async ({ page }) => {
  const backend = await mockPos(page, serviceFixture)
  try {
    const product = await seeded(backend, 'Precio máximo', {}, 99_999_999)
    const original = await backend.execute<OperationalOrder>({ command: 'save_order', operationId: crypto.randomUUID(), orderId: crypto.randomUUID(), expectedRevision: null,
      name: 'Cuenta límite', orderKind: 'service', tableId: null,
      items: [{ lineId: crypto.randomUUID(), productId: product.id, quantity: 100, unitPriceCents: product.priceCents, version: product.version, note: '' }] })
    expect(original.totalCents).toBe(9_999_999_900)
    await accounts(page)
    await page.getByRole('button', { name: /Cuenta límite/ }).click()
    await page.getByRole('button', { name: 'Editar artículos', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Editar cuenta', exact: true })
    await editor.getByRole('button', { name: 'Añadir Precio máximo', exact: true }).click()
    await expect(editor.locator('.order-editor-subtotal dd')).toHaveText('$100,999,998.99')
    await expect(editor.getByRole('alert')).toContainText('El subtotal supera el límite')
    await expect(editor.getByRole('button', { name: 'Guardar cuenta', exact: true })).toBeDisabled()
    expect(backend.calls.filter(command => command.command === 'save_order')).toHaveLength(0)
    await editor.getByRole('button', { name: 'Reducir Precio máximo', exact: true }).click()
    await expect(editor.locator('.order-editor-subtotal dd')).toHaveText('$99,999,999.00')
    await expect(editor.getByRole('button', { name: 'Guardar cuenta', exact: true })).toBeEnabled()
    const saved = await save(page, backend, 'Cuenta límite')
    expect(saved.totalCents).toBe(original.totalCents)
    expect(saved.items[0].unitPriceCents).toBe(product.priceCents)
    expect(saved.items[0].quantity).toBe(100)
    expect(backend.calls.filter(command => command.command === 'save_order')).toHaveLength(1)
  } finally { await backend.db.close() }
})
