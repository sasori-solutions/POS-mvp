import { test, expect, type Page } from '@playwright/test'
import { fixtureBusiness, fixtureOperatorToken, fixturePin } from './account-fixture'
import { pendingSaleKey } from '../../src/lib/pending-sale'
import { mockPos } from './pos-fixture'

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

test('catalog creates/edits/searches/filters/deactivates and restores a product', async ({ page }) => {
  const backend = await mockPos(page, { empty: true })
  try {
    await unlock(page)
    await expect(page.getByRole('heading', { name: 'Aún no hay productos' })).toBeVisible()
    await page.getByRole('button', { name: 'Ver productos', exact: true }).click()
    await page.getByRole('button', { name: 'Agregar producto' }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('Café frío')
    await page.getByLabel('Precio MXN', { exact: true }).fill('10.001')
    await page.getByRole('button', { name: 'Guardar producto' }).click()
    await expect(page.getByRole('alert')).toContainText('2 decimales')
    await page.getByLabel('Precio MXN', { exact: true }).fill('10,01')
    await page.getByLabel('Categoría (opcional)').fill('Fríos')
    await page.getByRole('button', { name: 'Guardar producto' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.locator('.product-list')).toContainText('$10.01')
    await page.getByRole('searchbox', { name: 'Buscar producto' }).fill('CAFE')
    await expect(page.getByRole('button', { name: 'Editar Café frío' })).toBeVisible()
    await page.getByRole('button', { name: 'Fríos', exact: true }).click()
    await page.getByRole('button', { name: 'Editar Café frío' }).click()
    await page.getByLabel('Precio MXN', { exact: true }).fill('12.34')
    await page.getByRole('button', { name: 'Guardar producto' }).click()
    await expect(page.locator('.product-list')).toContainText('$12.34')
    await page.getByRole('button', { name: 'Desactivar Café frío' }).click()
    await expect(page.getByRole('dialog')).toContainText('Las ventas anteriores se conservan')
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await page.getByRole('button', { name: 'Desactivar Café frío' }).click()
    await page.getByRole('button', { name: 'Desactivar', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Sin productos para esta búsqueda' })).toBeVisible()
    await page.getByLabel('Mostrar').selectOption('inactive')
    await page.getByRole('button', { name: 'Activar Café frío' }).click()
    await expect.poll(async () => (await backend.catalog()).products[0].active).toBe(true)
    await page.getByLabel('Mostrar').selectOption('active')
    await expect(page.getByRole('button', { name: 'Editar Café frío' })).toBeVisible()
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
    await page.getByRole('button', { name: 'Actualizar venta' }).click()
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
    await page.getByRole('button', { name: 'Actualizar catálogo' }).click()
    await expect(page.getByRole('button', { name: 'Cobrar $106.00' })).toBeDisabled()
    await page.getByRole('button', { name: 'Actualizar venta' }).click()
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
    await page.getByLabel('Precio MXN', { exact: true }).fill('0.10')
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
  } finally { await backend.db.close() }
})
