import { test, expect, type Page } from '@playwright/test'
import type { BusinessDayReport, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'
import type { Sale } from '../../src/lib/pos-contracts'
import { fixturePin } from './account-fixture'
import { mockPos } from './pos-fixture'
import { mockPoint } from './point-fixture'
import { enterOperations, openOwnerTask, submitPinIfPresent } from './workspace-flow'

async function unlock(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page)
  await enterOperations(page)
}
async function openCart(page: Page) {
  const button = page.getByRole('button', { name: /^Ver cuenta/ })
  if (await button.isVisible()) await button.click()
}
async function addAmount(page: Page, value: string, name?: string) {
  await page.getByRole('button', { name: 'Importe para la venta', exact: true }).click()
  await page.getByLabel('Importe', { exact: true }).fill(value)
  if (name) {
    await page.getByRole('button', { name: 'Añadir concepto' }).click()
    await page.getByLabel('Concepto (opcional)').fill(name)
  }
  await page.getByRole('button', { name: /^Añadir \$/ }).click()
}
async function chargeCash(page: Page, total: string) {
  await openCart(page)
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  const checkout = page.getByRole('dialog', { name: 'Cobrar', exact: true })
  await expect(checkout.locator('.checkout-amount')).toContainText(total)
  await expect(checkout.getByRole('button', { name: 'Registrar pago', exact: true })).toBeEnabled()
  await checkout.getByRole('button', { name: 'Registrar pago', exact: true }).click()
  await expect(checkout).not.toBeVisible()
}
async function showReceipt(page: Page) {
  await page.getByRole('button', { name: 'Historial', exact: true }).filter({ visible: true }).first().click()
  await page.getByRole('button', { name: /^Ver venta/ }).click()
  return page.locator('.sale-detail')
}
async function assertLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
}
async function assertActionUnobscured(button: ReturnType<Page['getByRole']>) {
  await expect(button).toBeInViewport({ ratio: 1 })
  await expect.poll(() => button.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const topmost = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    return Boolean(topmost && element.contains(topmost))
  })).toBe(true)
}
const businessDate = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(value))

test('free amount checkout works with an empty catalog, preserves exact receipt and fits calculator viewports', async ({ page }, info) => {
  const backend = await mockPos(page, { empty: true })
  const originalViewport = page.viewportSize()!
  try {
    await unlock(page)
    await page.getByRole('button', { name: 'Importe para la venta', exact: true }).click()
    const keypad = page.getByRole('group', { name: 'Teclado de importe' })
    for (const key of ['2', '5', 'Punto decimal', '3', '0']) await keypad.getByRole('button', { name: key, exact: true }).click()
    await expect(page.getByRole('button', { name: 'Añadir $25.30', exact: true })).toBeEnabled()
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1024, height: 940 }]) {
      await page.setViewportSize(viewport)
      const add = page.getByRole('button', { name: 'Añadir $25.30', exact: true })
      await assertActionUnobscured(add)
      await assertActionUnobscured(keypad.getByRole('button', { name: '0', exact: true }))
      await assertActionUnobscured(keypad.getByRole('button', { name: 'Punto decimal', exact: true }))
      await assertLayout(page)
      const bounds = await add.boundingBox()
      const navigation = page.getByRole('navigation', { name: 'Navegación principal' }).filter({ visible: true })
      if (!await page.getByRole('dialog').count() && await navigation.count()) expect(bounds!.y + bounds!.height).toBeLessThanOrEqual((await navigation.boundingBox())!.y)
      const cartStrip = page.locator('.mobile-cart-action').filter({ visible: true })
      if (!await page.getByRole('dialog').count() && await cartStrip.count()) expect(bounds!.y + bounds!.height).toBeLessThanOrEqual((await cartStrip.boundingBox())!.y)
      await page.screenshot({ path: `artifacts/qa/importe/${info.project.name}-${viewport.width}-calculator.png` })
    }
    await page.setViewportSize(originalViewport)
    await page.getByRole('button', { name: 'Añadir concepto' }).click()
    await page.getByLabel('Concepto (opcional)').fill('Trabajo sintético')
    await page.getByRole('button', { name: 'Añadir $25.30', exact: true }).click()
    await chargeCash(page, '$25.30')
    const sales = (await backend.sales()).sales
    expect(sales).toHaveLength(1)
    const receipt = await backend.execute<Sale>({ command: 'sale', saleId: sales[0].id })
    expect(receipt).toMatchObject({ totalCents: 2530, items: [{ productId: null, kind: 'amount', name: 'Trabajo sintético', quantity: 1, unitPriceCents: 2530, totalCents: 2530 }] })
    expect((await backend.catalog()).products).toHaveLength(0)
    expect((await backend.execute<{ batches: KitchenBatch[] }>({ command: 'kitchen' })).batches).toHaveLength(0)
    await expect(await showReceipt(page)).toContainText('Trabajo sintético')
    await expect(page.locator('.sale-detail')).toContainText('Importe libre')
    await expect(page.locator('.sale-detail')).toContainText('$25.30')
  } finally { await backend.db.close() }
})

test('mixed product and free amounts persist concepts, aggregate reports and prepare only catalog items', async ({ page }) => {
  const backend = await mockPos(page)
  try {
    await unlock(page)
    await page.getByRole('button', { name: /^Agregar Latte,/ }).click()
    await addAmount(page, '10.01', 'Servicio sintético')
    await addAmount(page, '5.02', 'Otro concepto sintético')
    await chargeCash(page, '$73.03')
    const sales = (await backend.sales()).sales
    expect(sales).toHaveLength(1)
    const receipt = await backend.execute<Sale>({ command: 'sale', saleId: sales[0].id })
    expect(receipt.items.filter(item => item.kind === 'amount').map(item => ({ name: item.name, totalCents: item.totalCents })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Otro concepto sintético', totalCents: 502 }, { name: 'Servicio sintético', totalCents: 1001 },
    ])
    const batches = (await backend.execute<{ batches: KitchenBatch[] }>({ command: 'kitchen' })).batches
    expect(batches).toHaveLength(1)
    expect(batches[0].items.map(item => ({ name: item.name, quantity: item.quantity }))).toEqual([{ name: 'Latte', quantity: 1 }])
    const report = await backend.execute<BusinessDayReport>({ command: 'report', date: businessDate(receipt.createdAt) })
    expect(report).toMatchObject({ salesCents: 7303, netCents: 7303, saleCount: 1 })
    expect(report.products.filter(item => item.productId === null)).toMatchObject([{ kind: 'amount', name: 'Importe libre', quantity: 2, salesCents: 1503, netCents: 1503 }])
    await expect(await showReceipt(page)).toContainText('Otro concepto sintético')
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click()
    await openOwnerTask(page, 'Reportes')
    await page.getByRole('tab', { name: 'Productos', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toContainText('Importe libre')
    await expect(page.getByRole('tabpanel')).toContainText('$15.03')
  } finally { await backend.db.close() }
})

test('editable service accounts can add and correct free amounts without changing sent products or inventing kitchen work', async ({ page }, info) => {
  const backend = await mockPos(page, { accountsEnabled: true })
  const name = 'Cuenta sintética con importe'
  try {
    await unlock(page)
    await page.getByRole('navigation').getByRole('button', { name: /^(?:\d+ )?Comandas$/ }).filter({ visible: true }).first().click()
    await page.getByRole('button', { name: 'Cuentas', exact: true }).click()
    await page.getByRole('button', { name: 'Abrir cuenta', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Abrir cuenta', exact: true })
    await editor.getByLabel('Nombre de la cuenta').fill(name)
    await editor.getByRole('region', { name: 'Añadir productos' }).getByRole('button', { name: /^Agregar Latte,/ }).click()
    await editor.getByRole('button', { name: 'Añadir importe libre', exact: true }).click()
    await editor.getByLabel('Importe', { exact: true }).fill('10.01')
    await editor.getByRole('button', { name: 'Añadir concepto' }).click()
    await editor.getByLabel('Concepto (opcional)').fill('Concepto inicial')
    await editor.getByRole('button', { name: 'Añadir $10.01', exact: true }).click()
    await editor.getByRole('button', { name: 'Guardar cuenta', exact: true }).click()
    const account = page.getByRole('dialog', { name, exact: true })
    await account.getByRole('button', { name: 'Enviar a cocina', exact: true }).click()
    await expect(account.getByRole('button', { name: 'Enviar a cocina', exact: true })).toHaveCount(0)
    await account.getByRole('button', { name: 'Editar artículos', exact: true }).click()
    const edit = page.getByRole('dialog', { name: 'Editar cuenta', exact: true })
    await edit.getByText('Editar importe', { exact: true }).click()
    await edit.getByLabel('Concepto (opcional)').fill('Concepto corregido')
    await edit.getByLabel('Importe unitario').fill('12.34')
    await edit.getByRole('button', { name: 'Añadir Concepto corregido', exact: true }).click()
    await assertLayout(page)
    await page.screenshot({ path: `artifacts/qa/importe/${info.project.name}-account-editor.png` })
    await edit.getByRole('button', { name: 'Guardar cuenta', exact: true }).click()
    await expect(account.getByText('2 × Concepto corregido')).toBeVisible()
    await expect(account.getByRole('button', { name: 'Enviar a cocina', exact: true })).toHaveCount(0)
    await assertLayout(page)
    await page.screenshot({ path: `artifacts/qa/importe/${info.project.name}-account-detail.png` })
    const commands = backend.calls.filter(command => command.command === 'save_order')
    const saved = commands[commands.length - 1]
    if (saved.command !== 'save_order') throw new Error('Expected a saved order')
    const order = await backend.execute<OperationalOrder>({ command: 'order', orderId: saved.orderId })
    expect(order).toMatchObject({ balanceCents: 8268, paidCents: 0 })
    expect(order.items.find(item => item.kind === 'amount')).toMatchObject({ productId: null, name: 'Concepto corregido', quantity: 2, unitPriceCents: 1234, sentQuantity: 0 })
    await account.getByRole('button', { name: 'Cobrar $82.68', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Registrar pago', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Registrar pago', exact: true }).click()
    await expect.poll(async () => (await backend.sales()).sales.length).toBe(1)
    const batches = (await backend.execute<{ batches: KitchenBatch[] }>({ command: 'kitchen' })).batches
    expect(batches).toHaveLength(1)
    expect(batches[0].items).toHaveLength(1)
    expect(batches[0].items[0]).toMatchObject({ name: 'Latte', quantity: 1 })
  } finally { await backend.db.close() }
})

test('Point approves a free amount with nullable product references without creating preparation', async ({ page }) => {
  const backend = await mockPoint(page)
  try {
    await unlock(page)
    await addAmount(page, '120.05', 'Servicio Point sintético')
    await openCart(page)
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
    await page.locator('label').filter({ has: page.getByRole('radio', { name: 'Tarjeta Mercado Pago', exact: true }) }).click()
    await expect(page.getByRole('button', { name: /^Enviar a terminal/ })).toBeEnabled()
    await page.getByRole('button', { name: /^Enviar a terminal/ }).click()
    await expect(page.getByRole('heading', { name: 'Pago aprobado' })).toBeVisible()
    expect(backend.remoteCharges()).toBe(1)
    const items = await backend.db.query<{ product_id: string | null; line_kind: string; name: string; total_cents: number }>('select product_id,line_kind,name,total_cents::integer from app_private.sale_items')
    expect(items.rows).toEqual([{ product_id: null, line_kind: 'amount', name: 'Servicio Point sintético', total_cents: 12005 }])
    const batches = await backend.db.query<{ count: string }>('select count(*)::text as count from app_private.kitchen_batches')
    expect(batches.rows[0].count).toBe('0')
  } finally { await backend.db.close() }
})
