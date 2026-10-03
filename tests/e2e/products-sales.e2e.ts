import { test, expect, type Page } from '@playwright/test'
import { fixtureBusiness, fixtureOperatorToken, fixturePin } from './account-fixture'
import { pendingSaleKey } from '../../src/lib/pending-sale'
import { mockPos } from './pos-fixture'
import type { Product, Sale } from '../../src/lib/pos-contracts'

async function unlock(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible()
}
async function navigate(page: Page, name: string) { await page.getByRole('navigation').getByRole('button', { name, exact: true }).click() }
async function openCart(page: Page) {
  const button = page.getByRole('button', { name: /^Ver cuenta/ })
  if (await button.isVisible()) await button.click()
}
async function add(page: Page, name: string) { await page.getByRole('button', { name: new RegExp(`^Agregar ${name},`) }).click() }
async function actions(page: Page, name: string) { await page.getByLabel(`Acciones de ${name}`, { exact: true }).click() }

test('reopening a product for sale waits for confirmation without flashing a saving dialog', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    const latte = (await backend.catalog()).products.find(product => product.name === 'Latte')!
    await backend.execute({ command: 'set_product_active', operationId: crypto.randomUUID(), productId: latte.id, expectedVersion: latte.version, active: false })
    await unlock(page); await navigate(page, 'Productos')
    await page.getByLabel('Mostrar').selectOption('inactive')
    await actions(page, 'Latte')
    await page.getByRole('button', { name: 'Activar Latte' }).click()
    await expect(page.getByRole('dialog', { name: 'Activar producto' })).toBeVisible()
    expect((await backend.catalog()).products.find(product => product.id === latte.id)?.active).toBe(false)
    await page.getByRole('button', { name: 'Activar', exact: true }).click()
    await expect.poll(async () => (await backend.catalog()).products.find(product => product.id === latte.id)?.active).toBe(true)
  } finally { await backend.db.close() }
})

for (const destination of ['Venta', 'Productos']) test(`${destination} refresh preserves layout and search without flashing loading text`, async ({ page }) => {
  const backend = await mockPos(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  try {
    await unlock(page)
    if (destination === 'Productos') await navigate(page, destination)
    const search = page.getByRole('searchbox', { name: 'Buscar producto' })
    await search.fill('Latte')
    const item = destination === 'Venta' ? page.getByRole('button', { name: /^Agregar Latte,/ }) : page.getByRole('button', { name: 'Editar Latte' })
    await expect(item).toBeVisible()
    const before = await item.boundingBox()
    await page.route('**/functions/v1/account', async route => {
      if (route.request().postDataJSON()?.command === 'catalog') await pending
      await route.fallback()
    })
    const request = page.waitForRequest(request => request.postDataJSON()?.command === 'catalog')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await request
    await expect(page.getByText('Cargando productos…', { exact: true })).not.toBeVisible({ timeout: 500 })
    expect((await item.boundingBox())?.y).toBe(before?.y)
    await expect(search).toHaveValue('Latte')
    await expect(search).toBeFocused()
    release()
    await expect(item).toBeVisible()
  } finally { release(); await page.unroute('**/functions/v1/account'); await backend.db.close() }
})

test('tablet keeps the total and charge action visible with a long account', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await page.setViewportSize({ width: 1024, height: 940 })
    await unlock(page)
    for (const name of ['Latte', 'Americano', 'Capuchino', 'Té negro', 'Sándwich', 'Croissant', 'Espresso', 'Chocolate', 'Panqué']) await add(page, name)
    const charge = page.getByRole('button', { name: 'Cobrar $490.00' })
    await expect(charge).toBeInViewport({ ratio: 1 })
    await expect(page.locator('.current-sale .sale-total')).toBeInViewport({ ratio: 1 })
  } finally { await backend.db.close() }
})

test('checkout keeps the reviewed amount until the operator returns to editing', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await page.setViewportSize({ width: 1024, height: 940 })
    await unlock(page); await add(page, 'Latte')
    await page.getByRole('button', { name: 'Cobrar $58.00' }).click()
    const croissant = page.getByRole('button', { name: /^Agregar Croissant,/ })
    await expect(croissant).toBeDisabled()
    await expect(page.locator('.current-sale .sale-total')).toContainText('$58.00')
    await page.getByRole('button', { name: 'Editar venta', exact: true }).click()
    await croissant.click()
    await expect(page.getByRole('button', { name: 'Cobrar $106.00' })).toBeEnabled()
  } finally { await backend.db.close() }
})

test('catalog creates/edits/searches/filters/deactivates and restores a product', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await unlock(page)
    await expect(page.getByRole('heading', { name: 'Aún no hay productos' })).toBeVisible()
    await page.getByRole('button', { name: 'Ver productos', exact: true }).click()
    await page.getByRole('button', { name: 'Agregar producto' }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('Café frío')
    await page.getByLabel('Precio final MXN', { exact: true }).fill('1234.56')
    await expect(page.getByLabel('Precio final MXN', { exact: true })).toHaveValue('$1,234.56')
    await page.getByLabel('Precio final MXN', { exact: true }).fill('10.01')
    await page.getByLabel('Categoría (opcional)').fill('Fríos')
    await page.getByRole('button', { name: 'Guardar producto' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.locator('.product-list')).toContainText('$10.01')
    await page.getByRole('searchbox', { name: 'Buscar producto' }).fill('CAFE')
    await expect(page.getByRole('button', { name: 'Editar Café frío' })).toBeVisible()
    await page.getByRole('button', { name: 'Fríos', exact: true }).click()
    await page.getByRole('button', { name: 'Editar Café frío' }).click()
    await page.getByLabel('Precio final MXN', { exact: true }).fill('12.34')
    await page.getByRole('button', { name: 'Guardar producto' }).click()
    await expect(page.locator('.product-list')).toContainText('$12.34')
    await actions(page, 'Café frío')
    await page.getByRole('button', { name: 'Desactivar Café frío' }).click()
    await expect(page.getByRole('dialog')).toContainText('Las ventas anteriores se conservan')
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await actions(page, 'Café frío')
    await page.getByRole('button', { name: 'Desactivar Café frío' }).click()
    await page.getByRole('button', { name: 'Desactivar', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Sin productos para esta búsqueda' })).toBeVisible()
    await page.getByLabel('Mostrar').selectOption('inactive')
    await actions(page, 'Café frío')
    await page.getByRole('button', { name: 'Activar Café frío' }).click()
    await page.getByRole('button', { name: 'Activar', exact: true }).click()
    await expect.poll(async () => (await backend.catalog()).products[0].active).toBe(true)
    await page.getByLabel('Mostrar').selectOption('active')
    await expect(page.getByRole('button', { name: 'Editar Café frío' })).toBeVisible()
  } finally { await backend.db.close() }
})

test('product actions cancel and confirm deletion, preserve receipts and remove it from Venta', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    const latte = (await backend.catalog()).products.find(p => p.name === 'Latte')!
    const receipt = await backend.execute<Sale>({ command: 'complete_sale', operationId: crypto.randomUUID(), paymentMethod: 'cash', totalCents: latte.priceCents, items: [{ productId: latte.id, quantity: 1, unitPriceCents: latte.priceCents, version: latte.version }] })
    await unlock(page); await navigate(page, 'Productos')
    await actions(page, 'Latte')
    await page.getByRole('button', { name: 'Eliminar Latte', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Eliminar producto' })
    await expect(dialog).toContainText('Las ventas anteriores se conservan')
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused()
    expect(backend.calls.filter(c => c.command === 'delete_product')).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(page.getByLabel('Acciones de Latte', { exact: true })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Editar Latte', exact: true })).toBeVisible()
    await actions(page, 'Latte')
    await page.getByRole('button', { name: 'Eliminar Latte', exact: true }).click()
    await dialog.getByRole('button', { name: 'Eliminar producto', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('status')).toHaveText('Producto eliminado.')
    await expect(page.getByRole('searchbox')).toBeFocused()
    expect((await backend.catalog()).products.some(p => p.id === latte.id)).toBe(false)
    await page.getByLabel('Mostrar').selectOption('all')
    await expect(page.getByRole('button', { name: 'Editar Latte', exact: true })).toHaveCount(0)
    await navigate(page, 'Venta')
    await expect(page.getByRole('button', { name: /^Agregar Latte,/ })).toHaveCount(0)
    expect(await backend.execute({ command: 'sale', saleId: receipt.id })).toEqual(receipt)
  } finally { await backend.db.close() }
})

test('lost deletion response retries the same operation and blocks repeated taps', async ({ page }) => {
  const backend = await mockPos(page, { deletionResponseLosses: 1, delayDeletionMs: 200 })
  try {
    await unlock(page); await navigate(page, 'Productos'); await actions(page, 'Latte')
    await page.getByRole('button', { name: 'Eliminar Latte', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Eliminar producto' })
    await dialog.getByRole('button', { name: 'Eliminar producto', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Eliminando…' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Reintentar eliminación' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Editar Latte', exact: true })).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Reintentar eliminación' }).click()
    await expect(dialog).not.toBeVisible()
    const commands = backend.calls.filter(c => c.command === 'delete_product')
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    await expect(page.getByRole('button', { name: 'Editar Latte', exact: true })).toHaveCount(0)
  } finally { await backend.db.close() }
})

test('stale deletion refreshes the product without deleting a newer edit', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await unlock(page); await navigate(page, 'Productos'); await actions(page, 'Latte')
    await page.getByRole('button', { name: 'Eliminar Latte', exact: true }).click()
    const latte = (await backend.catalog()).products.find(p => p.name === 'Latte')!
    await backend.execute({ command: 'save_product', operationId: crypto.randomUUID(), productId: latte.id, expectedVersion: latte.version, name: 'Latte nuevo', category: latte.category, priceCents: 6000 })
    const dialog = page.getByRole('dialog', { name: 'Eliminar producto' })
    await dialog.getByRole('button', { name: 'Eliminar producto', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('El producto cambió')
    await dialog.getByRole('button', { name: 'Actualizar productos' }).click()
    await expect(page.getByRole('button', { name: 'Editar Latte nuevo', exact: true })).toBeVisible()
    expect((await backend.catalog()).products.some(p => p.id === latte.id)).toBe(true)
    await actions(page, 'Latte nuevo')
    await page.getByLabel('Acciones de Latte nuevo', { exact: true }).press('Escape')
    await expect(page.getByRole('button', { name: 'Eliminar Latte nuevo' })).not.toBeVisible()
  } finally { await backend.db.close() }
})

test('product actions stay above navigation on phone and tablet', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await unlock(page); await navigate(page, 'Productos')
    for (const width of [320, 390, 768, 1024]) {
      await page.setViewportSize({ width, height: 844 })
      await actions(page, 'Latte')
      const button = page.getByRole('button', { name: 'Eliminar Latte', exact: true })
      await expect(button).toBeInViewport({ ratio: 1 })
      const box = await button.boundingBox()
      const navigation = await page.getByRole('navigation').boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(48)
      expect(box!.y + box!.height).toBeLessThanOrEqual(navigation!.y)
      await page.getByLabel('Acciones de Latte', { exact: true }).press('Escape')
      await expect(button).not.toBeVisible()
    }
  } finally { await backend.db.close() }
})

for (const method of ['Efectivo', 'Tarjeta', 'Transferencia']) test(`sale registers ${method}, quantities, exact total and historical detail`, async ({ page }, info) => {
  const backend = await mockPos(page)
  try {
    await unlock(page)
    await add(page, 'Latte'); await add(page, 'Latte'); await add(page, 'Croissant')
    await openCart(page)
    await expect(page.getByLabel('Cantidad de Latte')).toHaveText('2')
    await page.getByRole('button', { name: 'Disminuir Latte' }).click()
    await page.getByRole('button', { name: 'Aumentar Latte' }).click()
    await page.getByRole('button', { name: 'Quitar Croissant' }).click()
    await page.getByRole('button', { name: 'Cobrar $116.00' }).click()
    await page.getByRole('radio', { name: method, exact: true }).check()
    if (method === 'Tarjeta') await expect(page.getByText('Cobra en tu terminal y registra el pago.')).toBeVisible()
    if (method === 'Transferencia') await expect(page.getByText(/Verifica que recibiste la transferencia/)).toBeVisible()
    await page.getByRole('button', { name: method === 'Efectivo' ? 'Confirmar venta' : 'Registrar pago', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Venta registrada' })).toBeVisible()
    await expect(page.locator('.sale-detail')).toContainText('2 × $58.00')
    await expect(page.locator('.sale-detail')).toContainText('$116.00')
    expect((await backend.sales()).sales).toHaveLength(1)
    const request = backend.calls.find(command => command.command === 'complete_sale')
    expect(JSON.stringify(request)).not.toMatch(/pan|cvv|cardNumber/i)
    await page.getByRole('button', { name: 'Ver ventas', exact: true }).click()
    await page.getByRole('button', { name: /^Ver venta/ }).click()
    await expect(page.getByRole('dialog')).toContainText(method)
    await page.screenshot({ path: `artifacts/qa/${info.project.name}-${method}-detail.png`, fullPage: true })
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click()
    await navigate(page, 'Venta')
    await page.getByRole('button', { name: 'Nueva venta' }).click()
    if (await page.getByRole('button', { name: 'Venta actual', exact: true }).isVisible()) await expect(page.getByRole('button', { name: 'Venta actual', exact: true })).toBeDisabled()
    else await expect(page.getByRole('button', { name: 'Cobrar $0.00' })).toBeDisabled()
  } finally { await backend.db.close() }
})

test('lost sale response survives reload/PIN and replays one immutable operation', async ({ page }) => {
  const backend = await mockPos(page, { saleResponseLosses: 1 })
  try {
    await unlock(page); await add(page, 'Latte'); await openCart(page)
    await page.getByRole('button', { name: 'Cobrar $58.00' }).click()
    await page.getByRole('button', { name: 'Confirmar venta' }).click()
    await expect(page.getByRole('button', { name: 'Reintentar registro' })).toBeEnabled()
    await expect(page.getByText(/sin volver a cobrar/).first()).toBeVisible()
    const persisted = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))
    expect(persisted).not.toContain(fixtureOperatorToken)
    expect(persisted).not.toContain(fixturePin)
    await page.reload()
    await page.getByTestId('pin-input').fill(fixturePin)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await page.getByRole('button', { name: 'Reintentar registro' }).click()
    await expect(page.getByRole('heading', { name: 'Venta registrada' })).toBeVisible()
    const attempts = backend.calls.filter(command => command.command === 'complete_sale')
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect((await backend.sales()).sales).toHaveLength(1)
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pos-mexico-pending-sale')))).toEqual([])
  } finally { await backend.db.close() }
})

test('rapid double submission sends one command and blocks editing while saving', async ({ page }) => {
  const backend = await mockPos(page, { delaySaleMs: 500 })
  try {
    await unlock(page); await add(page, 'Latte'); await openCart(page)
    await page.getByRole('button', { name: 'Cobrar $58.00' }).click()
    await page.getByRole('button', { name: 'Confirmar venta' }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    await expect(page.getByRole('button', { name: 'Registrando…' })).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'Venta registrada' })).toBeVisible()
    expect(backend.calls.filter(command => command.command === 'complete_sale')).toHaveLength(1)
    expect((await backend.sales()).sales).toHaveLength(1)
  } finally { await backend.db.close() }
})

test('two tabs preserve and retry the same pending sale without overwriting it', async ({ page, context }) => {
  const backend = await mockPos(page, { saleResponseLosses: 1, delaySaleMs: 250 })
  const other = await context.newPage()
  try {
    await backend.attach(other)
    await unlock(page); await unlock(other)
    await add(page, 'Latte'); await openCart(page)
    await page.getByRole('button', { name: 'Cobrar $58.00' }).click()
    await add(other, 'Croissant'); await openCart(other)
    await other.getByRole('button', { name: 'Cobrar $48.00' }).click()
    await page.getByRole('button', { name: 'Confirmar venta' }).click()
    await expect(other.getByRole('button', { name: 'Reintentar registro' })).toBeEnabled()
    await expect(other.locator('.sale-total')).toContainText('$58.00')
    await expect(page.getByRole('button', { name: 'Reintentar registro' })).toBeEnabled()
    await other.getByRole('button', { name: 'Reintentar registro' }).click()
    await expect(other.getByRole('heading', { name: 'Venta registrada' })).toBeVisible()
    await page.getByRole('button', { name: 'Reintentar registro' }).click()
    await expect(page.getByRole('heading', { name: 'Venta registrada' })).toBeVisible()
    const attempts = backend.calls.filter(command => command.command === 'complete_sale')
    expect(attempts).toHaveLength(3)
    expect(attempts[1]).toEqual(attempts[0]); expect(attempts[2]).toEqual(attempts[0])
    expect((await backend.sales()).sales).toHaveLength(1)
  } finally { await other.close(); await backend.db.close() }
})

test('full browser storage stops the sale request and lets the operator retry safely', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await unlock(page); await add(page, 'Latte'); await openCart(page)
    await page.getByRole('button', { name: 'Cobrar $58.00' }).click()
    await page.evaluate(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('pos-mexico-pending-sale')) throw new DOMException('Full', 'QuotaExceededError'); original.call(this, key, value) }
    })
    await page.getByRole('button', { name: 'Confirmar venta' }).click()
    await expect(page.getByRole('alert')).toContainText('No pudimos conservar')
    expect(backend.calls.filter(command => command.command === 'complete_sale')).toHaveLength(0)
    expect((await backend.sales()).sales).toHaveLength(0)
    await page.reload(); await page.getByTestId('pin-input').fill(fixturePin); await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await add(page, 'Latte'); await openCart(page)
    await page.getByRole('button', { name: 'Cobrar $58.00' }).click()
    await page.getByRole('button', { name: 'Confirmar venta' }).click()
    await expect(page.getByRole('heading', { name: 'Venta registrada' })).toBeVisible()
    expect((await backend.sales()).sales).toHaveLength(1)
  } finally { await backend.db.close() }
})

test('a recovered unaccepted sale preserves its draft when the server rejects changed prices', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await unlock(page)
    const latte = (await backend.catalog()).products.find(product => product.name === 'Latte')!
    const pending = { command: 'complete_sale', operationId: crypto.randomUUID(), paymentMethod: 'cash', totalCents: 5800,
      items: [{ productId: latte.id, quantity: 1, unitPriceCents: latte.priceCents, version: latte.version }] }
    // The account fixture predates employee projection and uses Home's legacy owner scope.
    await page.evaluate(({ key, command }) => localStorage.setItem(key, JSON.stringify(command)), { key: pendingSaleKey(fixtureBusiness.id, 'owner'), command: pending })
    await backend.execute({ command: 'save_product', operationId: crypto.randomUUID(), productId: latte.id, expectedVersion: latte.version, name: latte.name, category: latte.category, priceCents: 6001 })
    await page.reload(); await page.getByTestId('pin-input').fill(fixturePin); await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await page.getByRole('button', { name: 'Reintentar registro' }).click()
    await expect(page.getByText(/La venta no se registró/)).toBeVisible()
    await expect(page.getByLabel('Cantidad de Latte')).toHaveText('1')
    await expect(page.getByRole('button', { name: 'Cobrar $60.01' })).toBeEnabled()
    expect((await backend.sales()).sales).toHaveLength(0)
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pos-mexico-pending-sale')))).toEqual([])
  } finally { await backend.db.close() }
})

test('stale cart cannot charge until the operator reviews prices and availability', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await unlock(page); await add(page, 'Latte'); await add(page, 'Croissant')
    const products = (await backend.catalog()).products
    const latte = products.find(product => product.name === 'Latte')!
    const croissant = products.find(product => product.name === 'Croissant')!
    await backend.execute({ command: 'save_product', operationId: crypto.randomUUID(), productId: latte.id, expectedVersion: latte.version, name: latte.name, category: latte.category, priceCents: 6001 })
    await backend.execute({ command: 'set_product_active', operationId: crypto.randomUUID(), productId: croissant.id, expectedVersion: croissant.version, active: false })
    await openCart(page)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('.current-sale').getByText(/El catálogo cambió/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cobrar $60.01' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Quitar Croissant' })).not.toBeVisible()
  } finally { await backend.db.close() }
})

test('catalog and product persistence failures show retries without fake empty states or duplicates', async ({ page }) => {
  const backend = await mockPos(page, { catalogFailures: 1, productResponseLosses: 1, empty: true })
  try {
    await unlock(page)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Aún no hay productos' })).not.toBeVisible()
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click()
    await page.getByRole('button', { name: 'Ver productos' }).click()
    await page.getByRole('button', { name: 'Agregar producto' }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('Producto sintético')
    await page.getByLabel('Precio final MXN', { exact: true }).fill('0.10')
    await page.getByRole('button', { name: 'Guardar producto' }).click()
    await page.getByRole('button', { name: 'Reintentar guardado' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    expect((await backend.catalog()).products).toHaveLength(1)
    const attempts = backend.calls.filter(command => command.command === 'save_product')
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0])
  } finally { await backend.db.close() }
})

test('phone/tablet layout and draft survive navigation without horizontal overflow', async ({ page }, info) => {
  const backend = await mockPos(page)
  try {
    await unlock(page); await add(page, 'Latte')
    await navigate(page, 'Productos'); await navigate(page, 'Venta')
    await openCart(page)
    await expect(page.getByLabel('Cantidad de Latte')).toHaveText('1')
    const mobileBack = page.getByRole('button', { name: 'Volver al catálogo' })
    if (await mobileBack.isVisible()) await mobileBack.click()
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 940 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `artifacts/qa/${info.project.name}-venta-${width}.png`, fullPage: true })
    }
    for (const width of [320, 390, 1024]) {
      await page.setViewportSize({ width, height: 940 })
      await navigate(page, 'Productos')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `artifacts/qa/${info.project.name}-productos-${width}.png`, fullPage: true })
      await page.getByRole('button', { name: 'Editar Latte' }).click()
      await expect(page.getByRole('dialog')).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: `artifacts/qa/${info.project.name}-editar-${width}.png` })
      await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
      await navigate(page, 'Más')
      await page.screenshot({ path: `artifacts/qa/${info.project.name}-mas-${width}.png`, fullPage: true })
      await navigate(page, 'Venta')
    }
  } finally { await backend.db.close() }
})

test('expanded product editor persists a photo, variants and extras with manual availability, then recovers a selected sale', async ({ page },info) => {
  const backend = await mockPos(page,{empty:true,saleResponseLosses:1})
  try {
    await unlock(page); await navigate(page,'Productos')
    await page.getByRole('button',{name:'Agregar producto',exact:true}).click()
    await page.getByLabel('Nombre',{exact:true}).fill('Latte sintético')
    await page.getByLabel('Precio final MXN',{exact:true}).fill('58.01')
    await page.getByLabel('Descripción',{exact:true}).fill('Café de prueba con leche')
    await page.getByLabel('Imagen del producto',{exact:true}).setInputFiles('public/icons/icon-192.png')
    await expect(page.getByRole('img',{name:'Imagen del producto',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Añadir variante',exact:true}).click()
    await page.getByLabel('Variante 1',{exact:true}).fill('Chico')
    await page.getByRole('button',{name:'Añadir variante',exact:true}).click()
    await page.getByLabel('Variante 2',{exact:true}).fill('Grande')
    await page.getByLabel('Precio de variante 2',{exact:true}).fill('62.02')
    await page.getByRole('button',{name:'Añadir grupo de modificadores',exact:true}).click()
    await page.getByLabel('Grupo 1',{exact:true}).fill('Leche')
    await page.getByLabel('Opción 1 de grupo 1',{exact:true}).fill('Avena')
    await page.getByLabel('Precio extra 1',{exact:true}).fill('0.11')
    await page.getByLabel('Selecciones mínimas',{exact:true}).fill('1')
    await expect(page.getByLabel('Controlar existencias',{exact:false})).toHaveCount(0)
    await expect(page.getByLabel('Existencias actuales',{exact:true})).toHaveCount(0)
    await page.getByLabel('Mostrar en favoritos',{exact:true}).check()
    await page.getByLabel('IVA del producto',{exact:true}).selectOption('vat_16')
    await page.screenshot({path:`artifacts/qa/${info.project.name}-expanded-editor.png`,fullPage:true})
    await page.getByRole('button',{name:'Guardar producto',exact:true}).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    const product = (await backend.catalog()).products[0]
    expect(product.image).toMatch(/^data:image\/jpeg;base64,/)
    expect(product.details?.variations).toHaveLength(2)
    expect(product.details?.trackStock).toBe(false)
    await navigate(page,'Venta')
    await expect(page.getByRole('button',{name:'Actualizar catálogo',exact:true})).toHaveCount(0)
    await page.getByRole('button',{name:'Favoritos',exact:true}).click()
    await add(page,'Latte sintético')
    await page.getByRole('radio',{name:/Grande/}).check()
    await page.getByRole('radio',{name:/Avena/}).check()
    await page.getByRole('button',{name:'Agregar · $62.13',exact:true}).click()
    await openCart(page)
    await page.getByRole('button',{name:'Cobrar $62.13',exact:true}).click()
    await page.getByRole('button',{name:'Confirmar venta',exact:true}).click()
    await expect(page.getByRole('button',{name:'Reintentar registro',exact:true})).toBeEnabled()
    await page.reload(); await page.getByTestId('pin-input').fill(fixturePin); await page.getByRole('button',{name:'Entrar',exact:true}).click()
    await page.getByRole('button',{name:'Reintentar registro',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Venta registrada',exact:true})).toBeVisible()
    await expect(page.locator('.sale-detail')).toContainText('Grande, Avena')
    expect((await backend.catalog()).products[0].details?.trackStock).toBe(false)
    expect((await backend.catalog()).products[0].version).toBe(product.version)
    expect((await backend.sales()).sales).toHaveLength(1)
    const attempts=backend.calls.filter(c=>c.command==='complete_sale')
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0])
  } finally {await backend.db.close()}
})

test('sold out is a direct checkout action and persists after catalog reload', async ({page},info) => {
  const backend=await mockPos(page)
  try {
    await unlock(page)
    await page.getByRole('button',{name:'Disponibilidad de Latte',exact:true}).click()
    await page.getByRole('button',{name:'Marcar agotado',exact:true}).click()
    await expect(page.getByRole('button',{name:/^Agregar Latte,/})).toBeDisabled()
    await page.screenshot({path:`artifacts/qa/${info.project.name}-square-sale.png`,fullPage:true})
    await page.reload(); await page.getByTestId('pin-input').fill(fixturePin); await page.getByRole('button',{name:'Entrar',exact:true}).click()
    await expect(page.getByRole('button',{name:/^Agregar Latte,/})).toBeDisabled()
    await page.getByRole('button',{name:'Disponibilidad de Latte',exact:true}).click()
    await page.getByRole('button',{name:'Marcar disponible',exact:true}).click()
    await expect(page.getByRole('button',{name:/^Agregar Latte,/})).toBeEnabled()
  } finally {await backend.db.close()}
})

test('MVP mobile product fields persist distinct Mexican IVA treatments and keep the advertised total', async ({page},info) => {
  const backend=await mockPos(page,{empty:true})
  try {
    await unlock(page); await navigate(page,'Productos')
    const cases=[['Café preparado','vat_16','116',1600],['Producto tasa cero','vat_0','25',0],['Producto exento','exempt','30',0],['Café frontera','border_8','108',800]] as const
    for(const [name,treatment,price,taxBps] of cases){
      await page.getByRole('button',{name:'Agregar producto',exact:true}).click()
      await page.getByLabel('Nombre',{exact:true}).fill(name)
      await page.getByLabel('Precio final MXN',{exact:true}).fill(price)
      await expect(page.getByLabel('IVA del producto',{exact:true})).toHaveValue('vat_16')
      for(const label of ['Tipo de producto','Costo por unidad (opcional)','Nombre para el cliente','Nombre para cocina','Calorías (opcional)','Preferencias alimentarias','SKU','Código de barras / GTIN','Etiqueta de la cuadrícula'])
        await expect(page.getByLabel(label,{exact:true})).toHaveCount(0)
      await expect(page.getByRole('button',{name:'Crear variantes',exact:true})).toHaveCount(0)
      await page.getByLabel('IVA del producto',{exact:true}).selectOption(treatment)
      if(treatment==='vat_16') await expect(page.getByRole('definition')).toHaveText(['$100.00','$16.00','$116.00'])
      if(treatment==='border_8'){
        await page.getByRole('button',{name:'Guardar producto',exact:true}).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await page.getByLabel('El negocio aplica el estímulo fronterizo del IVA para esta operación.',{exact:true}).check()
        await expect(page.getByRole('definition')).toHaveText(['$100.00','$8.00','$108.00'])
      }
      if(treatment==='vat_16') {
        await page.locator('#product-pricing').scrollIntoViewIfNeeded()
        await page.screenshot({path:`artifacts/qa/${info.project.name}-mvp-iva-editor.png`})
      }
      await page.getByRole('button',{name:'Guardar producto',exact:true}).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      const saved=(await backend.catalog()).products.find(product=>product.name===name)!
      expect(saved.details).toMatchObject({taxTreatment:treatment,taxBps})
    }
    await navigate(page,'Venta')
    for(const [name] of cases) await add(page,name)
    await openCart(page)
    const totals=page.locator('.current-sale .sale-totals')
    await expect(totals).toContainText('Subtotal sin IVA')
    await expect(totals).toContainText('$255.00')
    await expect(totals).toContainText('IVA tasa 0 %')
    await expect(totals).toContainText('Exento de IVA')
    await expect(totals).toContainText('$279.00')
    await page.getByRole('button',{name:'Cobrar $279.00',exact:true}).click()
    await page.getByRole('button',{name:'Confirmar venta',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Venta registrada',exact:true})).toBeVisible()
    await expect(page.locator('.sale-detail')).toContainText('Subtotal sin IVA')
    await page.screenshot({path:`artifacts/qa/${info.project.name}-mvp-iva-sale.png`})
    const records=(await backend.sales()).sales
    expect(records).toHaveLength(1)
    const receipt=await backend.execute<Sale>({command:'sale',saleId:records[0].id})
    expect(receipt.items.reduce((sum,item)=>sum+(item.taxCents??0),0)).toBe(2400)
    expect(receipt.totalCents).toBe(27900)
  } finally {await backend.db.close()}
})

test('old unclassified IVA and variable-price products need an explicit choice before editing', async ({page}) => {
  const backend=await mockPos(page,{empty:true})
  try {
    const {emptyDetails}=await import('../../src/lib/product-details')
    const old=await backend.execute<Product>({command:'save_product',operationId:crypto.randomUUID(),productId:crypto.randomUUID(),expectedVersion:null,name:'Anterior',category:'',priceCents:0,details:{...emptyDetails(),variablePrice:true,sku:'KEEP',kitchenName:'Etiqueta anterior'}})
    await unlock(page); await navigate(page,'Productos')
    await page.getByRole('button',{name:'Editar Anterior',exact:true}).click()
    await expect(page.getByLabel('Precio final MXN',{exact:true})).toHaveValue('')
    await expect(page.getByLabel('IVA del producto',{exact:true})).toHaveValue('')
    await page.getByRole('button',{name:'Guardar producto',exact:true}).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByLabel('Precio final MXN',{exact:true}).fill('58')
    await page.getByLabel('Alérgenos (opcional)',{exact:true}).fill('Leche')
    await page.getByLabel('IVA del producto',{exact:true}).selectOption('vat_16')
    await page.getByRole('button',{name:'Guardar producto',exact:true}).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    const saved=(await backend.catalog()).products.find(product=>product.id===old.id)!
    expect(saved.priceCents).toBe(5800)
    expect(saved.details).toMatchObject({variablePrice:false,taxTreatment:'vat_16',taxBps:1600,sku:'KEEP',kitchenName:'Etiqueta anterior'})
    await navigate(page,'Venta'); await add(page,'Anterior')
    await expect(page.getByRole('dialog')).toContainText('Alérgenos: Leche')
    await page.getByRole('button',{name:'Agregar · $58.00',exact:true}).click()
  } finally {await backend.db.close()}
})

test('catalog keeps two phone columns, readable selections and touch targets across breakpoints', async ({ page }, info) => {
  const backend = await mockPos(page)
  try {
    await unlock(page)
    await add(page, 'Latte')
    for (const width of [320, 390, 600, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 940 })
      const columns = await page.locator('.touch-catalog').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)
      expect(columns).toBe(width < 960 ? 2 : width < 1200 ? 3 : 4)
      for (const button of await page.locator('.tile-menu, .catalog-category, .pos-nav-item').all()) {
        const box = await button.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(48)
        expect(box?.width).toBeGreaterThanOrEqual(48)
      }
      const notifications = await page.getByRole('button', { name: /^Notificaciones/ }).boundingBox()
      const lock = await page.getByRole('button', { name: 'Bloquear', exact: true }).boundingBox()
      expect(notifications).not.toBeNull()
      expect(lock).not.toBeNull()
      expect(lock!.x - (notifications!.x + notifications!.width)).toBeGreaterThanOrEqual(0)
      expect(lock!.x - (notifications!.x + notifications!.width)).toBeLessThanOrEqual(20)
      const selected = page.getByRole('navigation').getByRole('button', { name: 'Venta', exact: true })
      const contrast = await selected.evaluate(element => {
        const style = getComputedStyle(element)
        const luminance = (value: string) => {
          const [r, g, b] = value.match(/\d+/g)!.slice(0, 3).map(v => { const n = Number(v) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 })
          return .2126 * r + .7152 * g + .0722 * b
        }
        let surface: Element | null = element
        let background = 'rgb(255, 255, 255)'
        while (surface) {
          const color = getComputedStyle(surface).backgroundColor
          if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break }
          surface = surface.parentElement
        }
        const a = luminance(style.color), b = luminance(background)
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      })
      expect(contrast).toBeGreaterThanOrEqual(4.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `artifacts/qa/${info.project.name}-tailwind-venta-${width}.png` })
    }
  } finally { await backend.db.close() }
})
