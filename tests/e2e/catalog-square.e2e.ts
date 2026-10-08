import { test, expect, type Page } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { mockPos } from './pos-fixture'
import { enterOperations, openOwnerTask, submitPinIfPresent } from './workspace-flow'
import { emptyDetails } from '../../src/lib/product-details'
import type { Product, ProductDetails, Sale } from '../../src/lib/pos-contracts'
import type { KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'

type Backend = Awaited<ReturnType<typeof mockPos>>

async function unlock(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page)
  await enterOperations(page)
}
async function products(page: Page) { await openOwnerTask(page, 'Productos') }
async function reveal(page: Page, text: string) {
  const disclosure = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: text }) }).first()
  if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').first().click()
}
async function create(page: Page, name: string, price = '58.01') {
  await page.getByRole('button', { name: 'Agregar producto', exact: true }).click()
  await page.getByLabel('Nombre', { exact: true }).fill(name)
  await page.getByLabel('Precio final MXN', { exact: true }).fill(price)
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Guardar producto', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /^(Agregar|Editar) producto$/ })).not.toBeVisible()
}
async function seeded(backend: Backend, name: string, overrides: Partial<ProductDetails> = {}, priceCents = 5801) {
  return backend.execute<Product>({ command: 'save_product', operationId: crypto.randomUUID(), productId: crypto.randomUUID(),
    expectedVersion: null, name, category: 'Pruebas', priceCents,
    details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, ...overrides } })
}
async function add(page: Page, name: string) { await page.getByRole('button', { name: new RegExp(`^Agregar ${name},`) }).click() }
async function charge(page: Page, amount: string) {
  const cart = page.getByRole('button', { name: /^Ver cuenta/ })
  if (await cart.isVisible()) await cart.click()
  await expect(page.locator('.current-sale .sale-total')).toContainText(amount)
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  await page.getByRole('button', { name: 'Registrar pago', exact: true }).click()
}
async function receipt(backend: Backend) {
  await expect.poll(async () => (await backend.sales()).sales.length).toBe(1)
  return backend.execute<Sale>({ command: 'sale', saleId: (await backend.sales()).sales[0].id })
}

test('Square catalog metadata persists through reload and stays editable without changing the price', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await unlock(page); await products(page); await create(page, 'Bowl de prueba')
    await reveal(page, 'Nombres y códigos opcionales')
    await page.getByLabel('Nombre para el cliente', { exact: true }).fill('Bowl de temporada')
    await page.getByLabel('Nombre para cocina', { exact: true }).fill('BOWL FRÍO')
    await page.getByLabel('Tipo de producto', { exact: true }).selectOption('prepared')
    await reveal(page, 'Apariencia en el catálogo')
    await page.getByLabel('Etiqueta corta', { exact: true }).fill('BOWL')
    await page.getByRole('button', { name: 'Verde claro', exact: true }).click()
    await page.getByLabel('SKU del producto', { exact: true }).fill('BOWL-001')
    await page.getByLabel('Código de barras / GTIN', { exact: true }).fill('7501234567893')
    await reveal(page, 'Información alimentaria (opcional)')
    await page.getByLabel('Calorías por porción', { exact: true }).fill('410')
    await page.getByLabel('Preferencias alimentarias', { exact: true }).fill('Vegetariano')
    await page.getByLabel('Alérgenos (opcional)', { exact: true }).fill('Leche, nueces')
    await save(page)
    const saved = (await backend.catalog()).products[0]
    expect(saved.priceCents).toBe(5801)
    expect(saved.details).toMatchObject({ customerName: 'Bowl de temporada', kitchenName: 'BOWL FRÍO',
      itemType: 'prepared', tileLabel: 'BOWL', tileColor: '#DAEBD9', sku: 'BOWL-001', barcode: '7501234567893', calories: 410,
      dietary: 'Vegetariano', allergens: 'Leche, nueces', variablePrice: false, taxTreatment: 'vat_16', trackStock: false })
    await page.reload(); await page.getByTestId('pin-input').fill(fixturePin); await submitPinIfPresent(page)
    await products(page); await page.getByRole('button', { name: 'Editar Bowl de prueba', exact: true }).click()
    await reveal(page, 'Nombres y códigos opcionales')
    await reveal(page, 'Información alimentaria (opcional)')
    await expect(page.getByLabel('Nombre para el cliente', { exact: true })).toHaveValue('Bowl de temporada')
    await expect(page.getByLabel('Nombre para cocina', { exact: true })).toHaveValue('BOWL FRÍO')
    await expect(page.getByLabel('SKU del producto', { exact: true })).toHaveValue('BOWL-001')
    await expect(page.getByLabel('Calorías por porción', { exact: true })).toHaveValue('410')
    await page.getByLabel('Descripción', { exact: true }).fill('Receta actualizada')
    await save(page)
    expect((await backend.catalog()).products[0].details).toMatchObject({ calories: 410, kitchenName: 'BOWL FRÍO', description: 'Receta actualizada' })
    expect((await backend.catalog()).products[0].priceCents).toBe(5801)
  } finally { await backend.db.close() }
})

test('catalog searches product and variation codes in management and at checkout', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await seeded(backend, 'Café codificado', { sku: 'SKU-CAFÉ-1', barcode: '7501234567893', customerName: 'Café especial',
      variations: [{ id: crypto.randomUUID(), name: 'Grande', priceCents: 6202, sku: 'SKU-GRANDE-2', barcode: '7501234567886', soldOut: false }] })
    await seeded(backend, 'Pan de prueba')
    await unlock(page); await products(page)
    const search = page.getByRole('searchbox', { name: 'Buscar producto' })
    for (const code of ['sku-cafe-1', '7501234567893', 'SKU-GRANDE-2', '7501234567886', 'Café especial']) {
      await search.fill(code)
      await expect(page.getByRole('button', { name: 'Editar Café codificado', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Editar Pan de prueba', exact: true })).toHaveCount(0)
    }
    await enterOperations(page)
    await search.fill('7501234567886')
    await expect(page.getByRole('button', { name: /^Agregar Café codificado,/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Agregar Pan de prueba,/ })).toHaveCount(0)
  } finally { await backend.db.close() }
})

test('variant combinations preserve an existing price, respect the limit and sell an available selection', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await unlock(page); await products(page); await create(page, 'Café combinado')
    await page.getByRole('button', { name: 'Añadir variante', exact: true }).click()
    await page.getByLabel('Variante 1', { exact: true }).fill('Especial')
    await page.getByLabel('Precio de variante 1', { exact: true }).fill('61.02')
    await reveal(page, 'Códigos de variante 1')
    await page.getByLabel('SKU de variante 1', { exact: true }).fill('ESPECIAL-001')
    await reveal(page, 'Crear variantes con opciones')
    await page.getByLabel('Nombre de opción 1', { exact: true }).fill('Tamaño')
    await page.getByLabel('Valores de opción 1', { exact: true }).fill('Chico, Grande')
    await page.getByRole('button', { name: 'Añadir opción de variantes', exact: true }).click()
    await page.getByLabel('Nombre de opción 2', { exact: true }).fill('Temperatura')
    await page.getByLabel('Valores de opción 2', { exact: true }).fill('Caliente, Frío')
    await expect(page.getByLabel('Vista previa de combinaciones', { exact: true })).toContainText('4 combinaciones · 4 nuevas')
    await page.getByRole('button', { name: 'Añadir combinaciones', exact: true }).click()
    await expect(page.getByLabel('Precio de variante 1', { exact: true })).toHaveValue('$61.02')
    await expect(page.getByLabel('SKU de variante 1', { exact: true })).toHaveValue('ESPECIAL-001')
    await page.getByLabel('Valores de opción 1', { exact: true }).fill(Array.from({ length: 11 }, (_, index) => `Tamaño ${index + 1}`).join(', '))
    await expect(page.getByText('Las opciones generan más de 20 variantes. Reduce los valores.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Añadir combinaciones', exact: true })).toBeDisabled()
    await expect(page.getByRole('radio', { name: /^Precio abierto/ })).toBeDisabled()
    await page.getByLabel('Valores de opción 1', { exact: true }).fill('Chico, Grande')
    await page.getByLabel('Precio de variante 5', { exact: true }).fill('62.03')
    await page.locator('#product-variations .editor-option-row').nth(1).getByRole('checkbox', { name: 'Agotada', exact: true }).check()
    await save(page)
    const saved = (await backend.catalog()).products[0]
    expect(saved.details?.variations).toHaveLength(5)
    expect(saved.details?.variations[0]).toMatchObject({ name: 'Especial', priceCents: 6102, sku: 'ESPECIAL-001' })
    expect(saved.details?.variations[1]).toMatchObject({ name: 'Chico · Caliente', soldOut: true })
    await enterOperations(page); await add(page, 'Café combinado')
    await expect(page.getByRole('radio', { name: /Chico · Caliente/ })).toBeDisabled()
    await page.getByRole('radio', { name: /Grande · Frío/ }).check()
    await page.getByRole('button', { name: 'Agregar · $62.03', exact: true }).click()
    await charge(page, '$62.03')
    const sale = await receipt(backend)
    expect(sale.totalCents).toBe(6203)
    expect(sale.items[0]).toMatchObject({ selectionLabel: 'Grande · Frío', unitPriceCents: 6203 })
  } finally { await backend.db.close() }
})

test('food details are available from a tile without forcing a confirmation on every ordinary add', async ({ page }, info) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await seeded(backend, 'Bowl informado', { description: 'Ensalada de prueba', calories: 410, dietary: 'Vegetariano', allergens: 'Leche, nueces' })
    await unlock(page); await add(page, 'Bowl informado')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await page.getByRole('button', { name: 'Disponibilidad de Bowl informado', exact: true }).click()
    await page.getByRole('button', { name: 'Ver detalles y opciones', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Bowl informado', exact: true })
    await expect(details).toContainText('410')
    await expect(details).toContainText('Vegetariano')
    await expect(details).toContainText('Alérgenos: Leche, nueces')
    await page.screenshot({ path: `artifacts/qa/${info.project.name}-square-food-details.png` })
    await details.getByRole('button', { name: 'Cerrar', exact: true }).click()
    await charge(page, '$58.01')
    expect((await receipt(backend)).totalCents).toBe(5801)
  } finally { await backend.db.close() }
})

test('an open-price product stays open after editing and charges the entered exact amount', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    const open = await seeded(backend, 'Servicio abierto', { itemType: 'service', variablePrice: true, sku: 'SERV-001' }, 0)
    await unlock(page); await products(page)
    await page.getByRole('button', { name: 'Editar Servicio abierto', exact: true }).click()
    await expect(page.getByRole('radio', { name: /^Precio abierto/ })).toBeChecked()
    await page.getByLabel('Descripción', { exact: true }).fill('Servicio por importe')
    await save(page)
    expect((await backend.catalog()).products.find(product => product.id === open.id)).toMatchObject({ priceCents: 0, details: { variablePrice: true, sku: 'SERV-001' } })
    await enterOperations(page); await add(page, 'Servicio abierto')
    await page.getByLabel('Precio de esta venta MXN', { exact: true }).fill('49.99')
    await page.getByRole('button', { name: 'Agregar · $49.99', exact: true }).click()
    await charge(page, '$49.99')
    const sale = await receipt(backend)
    expect(sale.totalCents).toBe(4999)
    expect(sale.items[0]).toMatchObject({ productId: open.id, unitPriceCents: 4999, totalCents: 4999 })
  } finally { await backend.db.close() }
})

test('customer and kitchen names are snapshotted independently and later catalog edits preserve them', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    const product = await seeded(backend, 'Latte administrativo', { customerName: 'Latte de temporada', kitchenName: 'LATTE MESA' })
    await unlock(page); await add(page, product.name); await charge(page, '$58.01')
    const sale = await receipt(backend)
    expect(sale.items[0].name).toBe('Latte de temporada')
    const orders = await backend.execute<{ orders: OperationalOrder[] }>({ command: 'orders' })
    const order = orders.orders.find(candidate => candidate.items.some(item => item.productId === product.id))!
    expect(order.items[0]).toMatchObject({ name: 'Latte de temporada', kitchenName: 'LATTE MESA' })
    const batches = await backend.execute<{ batches: KitchenBatch[] }>({ command: 'kitchen' })
    expect(batches.batches.find(batch => batch.orderId === order.id)?.items[0].name).toBe('LATTE MESA')
    await backend.execute({ command: 'save_product', operationId: crypto.randomUUID(), productId: product.id, expectedVersion: product.version,
      name: product.name, category: product.category, priceCents: 9900, details: { ...product.details!, customerName: 'Nuevo cliente', kitchenName: 'NUEVA COCINA' } })
    expect((await backend.execute<Sale>({ command: 'sale', saleId: sale.id })).items[0]).toEqual(sale.items[0])
    expect((await backend.execute<OperationalOrder>({ command: 'order', orderId: order.id })).items[0]).toEqual(order.items[0])
  } finally { await backend.db.close() }
})

test('uncertain product saves retry the same metadata and operation without duplicating the product', async ({ page }) => {
  const backend = await mockPos(page, { empty: true, productResponseLosses: 1 })
  try {
    await unlock(page); await products(page); await create(page, 'Producto recuperable')
    await reveal(page, 'Nombres y códigos opcionales')
    await page.getByLabel('SKU del producto', { exact: true }).fill('RETRY-001')
    await page.getByLabel('Nombre para el cliente', { exact: true }).fill('Nombre recuperable')
    await page.getByRole('button', { name: 'Guardar producto', exact: true }).click()
    const retry = page.getByRole('button', { name: 'Reintentar guardado', exact: true })
    await expect(retry).toBeEnabled()
    await expect(page.getByLabel('SKU del producto', { exact: true })).toBeDisabled()
    await retry.click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    const requests = backend.calls.filter(command => command.command === 'save_product')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
    const catalog = (await backend.catalog()).products
    expect(catalog).toHaveLength(1)
    expect(catalog[0].details).toMatchObject({ sku: 'RETRY-001', customerName: 'Nombre recuperable' })
  } finally { await backend.db.close() }
})

test('a product can reuse a catalog image without uploading or changing the source image', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await unlock(page); await products(page); await create(page, 'Foto original')
    await page.getByLabel('Imagen del producto', { exact: true }).setInputFiles('public/icons/icon-192.png')
    await expect(page.getByRole('img', { name: 'Imagen del producto', exact: true })).toBeVisible()
    await save(page)
    const original = (await backend.catalog()).products[0]
    const uploadCount = backend.calls.filter(command => command.command === 'upload_product_image').length
    await create(page, 'Foto compartida')
    await page.getByLabel('Usar imagen de otro producto', { exact: true }).selectOption(original.id)
    await save(page)
    const copied = (await backend.catalog()).products.find(product => product.name === 'Foto compartida')!
    expect(copied.details?.imageId).toBe(original.details?.imageId)
    expect(copied.image).toEqual(original.image)
    expect(backend.calls.filter(command => command.command === 'upload_product_image')).toHaveLength(uploadCount)
  } finally { await backend.db.close() }
})

test('quick add skips optional extras while required options and open prices still require a choice', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await seeded(backend, 'Café obligatorio', { skipCustomization: true, modifierSets: [{ id: crypto.randomUUID(), name: 'Leche obligatoria', min: 1, max: 1,
      options: [{ id: crypto.randomUUID(), name: 'Avena obligatoria', priceCents: 11 }] }] })
    await seeded(backend, 'Servicio con importe', { skipCustomization: true, variablePrice: true, itemType: 'service' }, 0)
    await unlock(page); await products(page); await create(page, 'Café directo')
    await page.getByRole('button', { name: 'Añadir grupo de modificadores', exact: true }).click()
    await page.getByLabel('Grupo 1', { exact: true }).fill('Leche opcional')
    await page.getByLabel('Opción 1 de grupo 1', { exact: true }).fill('Avena opcional')
    await page.getByLabel('Precio extra 1', { exact: true }).fill('0.11')
    await page.getByRole('checkbox', { name: /^Agregar directo cuando sea posible/ }).check()
    await save(page)
    expect((await backend.catalog()).products.find(product => product.name === 'Café directo')?.details?.skipCustomization).toBe(true)
    await enterOperations(page); await add(page, 'Café directo')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await page.getByRole('button', { name: 'Disponibilidad de Café directo', exact: true }).click()
    await page.getByRole('button', { name: 'Ver detalles y opciones', exact: true }).click()
    await page.getByRole('radio', { name: /Avena opcional/ }).check()
    await page.getByRole('button', { name: 'Agregar · $58.12', exact: true }).click()
    await add(page, 'Café obligatorio')
    await expect(page.getByRole('dialog', { name: 'Café obligatorio', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Agregar · $58.01', exact: true })).toBeDisabled()
    await page.getByRole('radio', { name: /Avena obligatoria/ }).check()
    await page.getByRole('button', { name: 'Agregar · $58.12', exact: true }).click()
    await add(page, 'Servicio con importe')
    await expect(page.getByRole('dialog', { name: 'Servicio con importe', exact: true })).toBeVisible()
    await page.getByLabel('Precio de esta venta MXN', { exact: true }).fill('49.99')
    await page.getByRole('button', { name: 'Agregar · $49.99', exact: true }).click()
    await charge(page, '$224.24')
    const sale = await receipt(backend)
    expect(sale.totalCents).toBe(22424)
    expect(sale.items.map(item => item.unitPriceCents).sort((a, b) => a - b)).toEqual([4999, 5801, 5812, 5812])
  } finally { await backend.db.close() }
})

test('copied modifier groups remain independent of their source and work in the paid selection', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    const source = await seeded(backend, 'Plantilla de extras', { modifierSets: [{ id: crypto.randomUUID(), name: 'Leche de plantilla', min: 1, max: 2,
      options: [{ id: crypto.randomUUID(), name: 'Avena copiada', priceCents: 11 }, { id: crypto.randomUUID(), name: 'Leche entera', priceCents: 0 }] }] })
    await unlock(page); await products(page); await create(page, 'Café con extras copiados')
    await page.getByRole('button', { name: 'Añadir grupo de modificadores', exact: true }).click()
    await page.getByLabel('Grupo 1', { exact: true }).fill('Empaque')
    await page.getByLabel('Opción 1 de grupo 1', { exact: true }).fill('Para llevar')
    await page.getByLabel('Copiar extras de otro producto', { exact: true }).selectOption(source.id)
    await page.getByRole('button', { name: 'Añadir grupos copiados', exact: true }).click()
    await expect(page.getByLabel('Grupo 1', { exact: true })).toHaveValue('Empaque')
    await expect(page.getByLabel('Grupo 2', { exact: true })).toHaveValue('Leche de plantilla')
    await page.getByLabel('Precio extra 1', { exact: true }).nth(1).fill('0.22')
    await save(page)
    const copied = (await backend.catalog()).products.find(product => product.name === 'Café con extras copiados')!
    expect(copied.details?.modifierSets).toHaveLength(2)
    expect(copied.details?.modifierSets[1].id).not.toBe(source.details?.modifierSets[0].id)
    expect(copied.details?.modifierSets[1].options[0].id).not.toBe(source.details?.modifierSets[0].options[0].id)
    expect((await backend.catalog()).products.find(product => product.id === source.id)?.details?.modifierSets).toEqual(source.details?.modifierSets)
    await enterOperations(page); await add(page, 'Café con extras copiados')
    await expect(page.getByRole('button', { name: 'Agregar · $58.01', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: /Avena copiada/ }).check()
    await page.getByRole('button', { name: 'Agregar · $58.23', exact: true }).click()
    await charge(page, '$58.23')
    expect((await receipt(backend)).items[0]).toMatchObject({ selectionLabel: 'Avena copiada', unitPriceCents: 5823 })
  } finally { await backend.db.close() }
})

test('custom attributes reject duplicate names, persist across reload and display entered text safely', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await unlock(page); await products(page); await create(page, 'Café con atributos')
    await reveal(page, 'Atributos personalizados')
    await page.getByRole('button', { name: 'Añadir atributo', exact: true }).click()
    await page.getByLabel('Nombre de atributo 1', { exact: true }).fill('Origen')
    await page.getByLabel('Valor de atributo 1', { exact: true }).fill('Etiopía <b>sin procesar</b>')
    await page.getByRole('button', { name: 'Añadir atributo', exact: true }).click()
    await page.getByLabel('Nombre de atributo 2', { exact: true }).fill('origen')
    await page.getByLabel('Valor de atributo 2', { exact: true }).fill('Filtrado')
    await page.getByRole('button', { name: 'Guardar producto', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('nombres diferentes')
    expect((await backend.catalog()).products).toHaveLength(0)
    await page.getByLabel('Nombre de atributo 2', { exact: true }).fill('Preparación')
    await save(page)
    expect((await backend.catalog()).products[0].details?.customAttributes).toEqual([
      { name: 'Origen', value: 'Etiopía <b>sin procesar</b>' }, { name: 'Preparación', value: 'Filtrado' },
    ])
    await page.reload(); await page.getByTestId('pin-input').fill(fixturePin); await submitPinIfPresent(page)
    await products(page); await page.getByRole('button', { name: 'Editar Café con atributos', exact: true }).click()
    await reveal(page, 'Atributos personalizados')
    await expect(page.getByLabel('Nombre de atributo 1', { exact: true })).toHaveValue('Origen')
    await expect(page.getByLabel('Valor de atributo 1', { exact: true })).toHaveValue('Etiopía <b>sin procesar</b>')
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await enterOperations(page); await add(page, 'Café con atributos')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await page.getByRole('button', { name: 'Disponibilidad de Café con atributos', exact: true }).click()
    await page.getByRole('button', { name: 'Ver detalles y opciones', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Café con atributos', exact: true })
    await expect(details.getByLabel('Atributos del producto', { exact: true })).toContainText('Etiopía <b>sin procesar</b>')
    await expect(details.locator('b').filter({ hasText: 'sin procesar' })).toHaveCount(0)
    await expect(details.getByLabel('Atributos del producto', { exact: true })).toContainText('PreparaciónFiltrado')
  } finally { await backend.db.close() }
})

test('expanded editor fits narrow phones and desktop with reachable save and touch actions', async ({ page }, info) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await unlock(page); await products(page); await create(page, 'Producto adaptable')
    await reveal(page, 'Nombres y códigos opcionales')
    await reveal(page, 'Apariencia en el catálogo')
    for (const width of [320, 390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 940 })
      const dialog = page.getByRole('dialog', { name: 'Agregar producto', exact: true })
      const box = await dialog.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(-1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      const saveButton = dialog.getByRole('button', { name: 'Guardar producto', exact: true })
      await expect(saveButton).toBeInViewport({ ratio: 1 })
      const buttonBox = await saveButton.boundingBox()
      expect(buttonBox!.height).toBeGreaterThanOrEqual(48)
      expect(buttonBox!.width).toBeGreaterThanOrEqual(48)
      await page.getByLabel('Código de barras / GTIN', { exact: true }).scrollIntoViewIfNeeded()
      for (const button of await dialog.locator('button:visible, nav a:visible').all()) {
        const touch = await button.boundingBox()
        expect(touch!.height).toBeGreaterThanOrEqual(48)
        expect(touch!.width).toBeGreaterThanOrEqual(48)
      }
      await page.screenshot({ path: `artifacts/qa/${info.project.name}-square-editor-${width}.png` })
    }
    await save(page)
    expect((await backend.catalog()).products).toHaveLength(1)
  } finally { await backend.db.close() }
})
