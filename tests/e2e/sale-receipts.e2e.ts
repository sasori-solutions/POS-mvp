import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { fixtureBusiness, fixturePin } from './account-fixture'
import { mockPos } from './pos-fixture'
import { enterOperations, openOwnerTask, submitPinIfPresent } from './workspace-flow'
import { emptyDetails } from '../../src/lib/product-details'
import type { PosCommand, Product, ProductDetails, Sale } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'

test.use({ timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce' })
type Backend = Awaited<ReturnType<typeof mockPos>>
type ReceiptWindow = Window & { receiptPrints: string[] }
const printLabel = 'Imprimir / guardar PDF'
const artifacts = 'artifacts/qa/receipts'

async function unlock(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page)
  await enterOperations(page)
}

/** Replace only the isolated iframe's print destination. Auth/HTTP uses the SQL fixture. */
async function capturePrint(page: Page) {
  await page.addInitScript(() => {
    ;(window as ReceiptWindow).receiptPrints = []
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof HTMLIFrameElement) || !node.dataset.saleReceipt) continue
        node.addEventListener('load', () => {
          if (node.contentWindow) node.contentWindow.print = () => { (window as ReceiptWindow).receiptPrints.push(node.srcdoc) }
        }, { capture: true })
      }
    }).observe(document, { childList: true, subtree: true })
  })
}

async function printReceipt(page: Page) {
  const before = await page.evaluate(() => (window as ReceiptWindow).receiptPrints.length)
  await page.getByRole('button', { name: printLabel, exact: true }).filter({ visible: true }).click()
  await expect.poll(() => page.evaluate(() => (window as ReceiptWindow).receiptPrints.length)).toBe(before + 1)
  const frame = page.locator('iframe[data-sale-receipt]').last()
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-modals')
  await expect(frame).toHaveAttribute('aria-hidden', 'true')
  const html = (await frame.getAttribute('srcdoc'))!
  expect(html).toBe(await page.evaluate(() => (window as ReceiptWindow).receiptPrints.at(-1)))
  return { html, document: frame.contentFrame() }
}

async function history(page: Page) {
  const receiptDialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: printLabel, exact: true }) })
  if (await receiptDialog.isVisible()) await receiptDialog.getByRole('button', { name: 'Cerrar', exact: true }).click()
  const direct = page.getByRole('button', { name: 'Historial', exact: true }).filter({ visible: true }).first()
  if (await direct.isVisible()) await direct.click()
  else await openOwnerTask(page, 'Ventas')
  await page.getByRole('button', { name: /^Ver venta/ }).first().click()
  return page.getByRole('dialog', { name: 'Venta', exact: true })
}

async function seeded(backend: Backend, name: string, priceCents = 5801, details: Partial<ProductDetails> = {}) {
  return backend.execute<Product>({ command: 'save_product', operationId: crypto.randomUUID(), productId: crypto.randomUUID(),
    expectedVersion: null, name, category: 'Café', priceCents,
    details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600, ...details } })
}
async function acceptedSale(backend: Backend) {
  await expect.poll(async () => (await backend.sales()).sales.length).toBe(1)
  return backend.execute<Sale>({ command: 'sale', saleId: (await backend.sales()).sales[0].id })
}
async function charge(page: Page) {
  const cart = page.getByRole('button', { name: /^Ver cuenta/ })
  if (await cart.isVisible() && await cart.getAttribute('aria-expanded') !== 'true') await cart.click()
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  return page.getByRole('dialog', { name: 'Cobrar', exact: true })
}
async function reachable(button: Locator) {
  await button.scrollIntoViewIfNeeded()
  await expect(button).toBeInViewport({ ratio: 1 })
  const box = (await button.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(48)
  expect(box.height).toBeGreaterThanOrEqual(48)
  expect(await button.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
  })).toBe(true)
}
async function finalized(backend: Backend, products: Product[], partial?: number) {
  const order = await backend.execute<OperationalOrder>({ command: 'save_order', operationId: crypto.randomUUID(),
    orderId: crypto.randomUUID(), expectedRevision: null, name: 'Mostrador', orderKind: 'counter', tableId: null,
    items: products.map(product => ({ lineId: crypto.randomUUID(), productId: product.id, quantity: partial ? 2 : 1, unitPriceCents: product.priceCents, version: product.version, note: '' })) })
  const quote = await backend.execute<CheckoutAttempt>({ command: 'prepare_checkout', operationId: crypto.randomUUID(), orderId: order.id,
    expectedRevision: order.revision, items: partial ? [] : order.items.map(line => ({ lineId: line.lineId, quantity: line.quantity })),
    ...(partial ? { amountsCents: [partial, order.totalCents - partial] } : {}), paymentMethod: 'cash' })
  await backend.execute({ command: 'record_checkout', operationId: crypto.randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })
  return acceptedSale(backend)
}

test('confirmed checkout and recovered history print the original names, extras, money and business timezone', async ({ page }, info) => {
  const backend = await mockPos(page, { empty: true, accountsEnabled: false })
  await capturePrint(page)
  try {
    const product = await seeded(backend, 'Café de temporada', 5801, {
      variations: [{ id: crypto.randomUUID(), name: 'Grande de Córdoba', priceCents: 6202, sku: '', barcode: '', soldOut: false }],
      modifierSets: [{ id: crypto.randomUUID(), name: 'Leche', min: 1, max: 1, options: [{ id: crypto.randomUUID(), name: 'Avena', priceCents: 11 }] }],
    })
    await unlock(page)
    await expect(page.getByRole('button', { name: printLabel, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /^Agregar Café de temporada,/ }).click()
    const selection = page.getByRole('dialog', { name: product.name, exact: true })
    await selection.getByRole('radio', { name: /Grande de Córdoba/ }).check()
    await selection.getByRole('radio', { name: /Avena/ }).check()
    await selection.getByRole('button', { name: 'Agregar · $62.13', exact: true }).click()
    const cart = page.getByRole('button', { name: /^Ver cuenta/ })
    if (await cart.isVisible() && await cart.getAttribute('aria-expanded') !== 'true') await cart.click()
    await page.getByRole('button', { name: 'Aumentar Café de temporada', exact: true }).click()
    const checkout = await charge(page)
    await checkout.getByRole('button', { name: 'Registrar pago', exact: true }).click()
    const sale = await acceptedSale(backend)
    expect(sale.totalCents).toBe(12426)
    await expect(page.getByRole('button', { name: printLabel, exact: true }).filter({ visible: true })).toBeVisible()
    const printed = await printReceipt(page)
    const expectedDate = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: sale.timezone }).format(new Date(sale.createdAt))
    await expect(printed.document.locator('header')).toContainText(expectedDate)
    await expect(printed.document.locator('tbody')).toContainText('Café de temporada')
    await expect(printed.document.locator('tbody')).toContainText('Grande de Córdoba, Avena')
    await expect(printed.document.locator('tbody')).toContainText('2 × $62.13')
    await expect(printed.document.locator('.total dd')).toHaveText('$124.26')
    await expect(printed.document.locator('dl')).toContainText('Método de pagoEfectivo')
    await expect(printed.document.locator('h1')).toHaveText(fixtureBusiness.name)
    await expect(printed.document.locator('footer')).toContainText('No es CFDI')
    await backend.execute({ command: 'save_product', operationId: crypto.randomUUID(), productId: product.id,
      expectedVersion: product.version, name: 'Nombre cambiado', category: product.category, priceCents: 9900, details: emptyDetails() })
    await page.reload()
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page)
    await enterOperations(page)
    const detail = await history(page)
    for (const width of [320, 390, 1024]) {
      await page.setViewportSize({ width, height: 940 })
      await reachable(detail.getByRole('button', { name: printLabel, exact: true }))
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `${artifacts}/${info.project.name}-history-${width}.png` })
    }
    const restored = await printReceipt(page)
    expect(restored.html).toBe(printed.html)
    expect((await backend.sales()).sales).toHaveLength(1)
  } finally { await backend.db.close() }
})

test('a lost external-card registration recovers once and prints its accepted method without another collection', async ({ page }) => {
  const backend = await mockPos(page, { accountsEnabled: false, saleResponseLosses: 1 })
  await capturePrint(page)
  try {
    await unlock(page)
    await page.getByRole('button', { name: /^Agregar Latte,/ }).click()
    const checkout = await charge(page)
    await checkout.locator('label').filter({ has: page.getByRole('radio', { name: 'Tarjeta externa', exact: true }) }).click()
    await expect(checkout.getByRole('button', { name: 'Registrar pago', exact: true })).toBeDisabled()
    await checkout.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.', exact: true }).check()
    await checkout.getByRole('button', { name: 'Registrar pago', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Reintentar solicitud guardada', exact: true }).filter({ visible: true }).first()).toBeEnabled()
    await expect(page.getByRole('button', { name: printLabel, exact: true }).filter({ visible: true })).toHaveCount(0)
    await page.reload()
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page)
    await page.getByRole('button', { name: 'Reintentar solicitud guardada', exact: true }).filter({ visible: true }).first().click()
    await expect.poll(() => backend.calls.filter(command => command.command === 'record_checkout').length).toBe(2)
    await expect(page.getByRole('dialog', { name: 'Pago registrado', exact: true })).toBeVisible()
    const sale = await acceptedSale(backend)
    expect(sale.paymentMethod).toBe('card_external')
    const calls = backend.calls.filter(command => command.command === 'record_checkout')
    const mutation = (command: PosCommand) => Object.fromEntries(Object.entries(command).filter(([key]) => !['operatorToken', 'deviceToken', 'deviceProof'].includes(key)))
    expect(mutation(calls[1])).toEqual(mutation(calls[0]))
    await history(page)
    const printed = await printReceipt(page)
    await expect(printed.document.locator('dl')).toContainText('Método de pagoTarjeta externa')
    await expect(printed.document.locator('.total dd')).toHaveText('$58.00')
    await expect(printed.document.locator('body')).not.toContainText('Mercado Pago Point')
  } finally { await backend.db.close() }
})

test('a monetary partial receipt prints allocated money without claiming complete product units', async ({ page }) => {
  const backend = await mockPos(page, { empty: true, accountsEnabled: false })
  await capturePrint(page)
  try {
    const sale = await finalized(backend, [await seeded(backend, 'Café dividido', 5801)], 3401)
    expect(sale).toMatchObject({ totalCents: 3401, itemCount: 0, items: [{ quantity: 0, allocatedGrossCents: 3401 }] })
    await unlock(page)
    const detail = await history(page)
    await expect(detail).toContainText('Parte de cuenta')
    const printed = await printReceipt(page)
    await expect(printed.document.locator('tbody')).toContainText('Parte de cuenta')
    await expect(printed.document.locator('tbody')).not.toContainText('0 ×')
    await expect(printed.document.locator('tbody')).not.toContainText('2 ×')
    await expect(printed.document.locator('.total dd')).toHaveText('$34.01')
  } finally { await backend.db.close() }
})

test('forty accepted Unicode lines stay escaped and paginate in a real A4 receipt PDF', async ({ page, context }, info) => {
  const backend = await mockPos(page, { empty: true, accountsEnabled: false })
  await capturePrint(page)
  try {
    const products: Product[] = []
    for (let index = 1; index <= 40; index++) products.push(await seeded(backend,
      index === 1 ? 'Café <img src=x onerror=alert(1)>' : `Concepto ${index}: café de Córdoba, piñón y preparación artesanal`, 5801))
    const sale = await finalized(backend, products)
    expect(sale.totalCents).toBe(232040)
    await unlock(page)
    await history(page)
    const printed = await printReceipt(page)
    await expect(printed.document.locator('tbody tr')).toHaveCount(40)
    await expect(printed.document.locator('tbody tr').first()).toContainText('Café <img src=x onerror=alert(1)>')
    await expect(printed.document.locator('script, img, svg, [onerror], [onload]')).toHaveCount(0)
    await expect(printed.document.locator('tbody tr').filter({ hasText: 'Concepto 40:' })).toHaveCount(1)
    await expect(printed.document.locator('.total dd')).toHaveText('$2,320.40')
    expect(printed.html).not.toContain('pos-section-title')
    const isolated = await context.newPage()
    try {
      await isolated.route('**/__isolated_receipt', route => route.fulfill({ contentType: 'text/html', body: printed.html }))
      await isolated.goto('http://127.0.0.1:5174/__isolated_receipt')
      await isolated.evaluate(() => document.fonts.ready)
      await expect(isolated.locator('tbody tr')).toHaveCount(40)
      mkdirSync(artifacts, { recursive: true })
      writeFileSync(`${artifacts}/${info.project.name}-40-lines.html`, printed.html)
      const pdf = await isolated.pdf({ path: `${artifacts}/${info.project.name}-40-lines-a4.pdf`, format: 'A4', printBackground: true })
      expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)!.length).toBeGreaterThanOrEqual(2)
      await isolated.screenshot({ path: `${artifacts}/${info.project.name}-40-lines-document.png`, fullPage: true })
    } finally { await isolated.close() }
  } finally { await backend.db.close() }
})

test('integrated free-amount checkout prints the accepted concept and amount without a catalog product', async ({ page }) => {
  test.skip(!existsSync('supabase/migrations/20261005180000_free_amount_lines.sql'), 'The free-amount feature is delivered in the combined preview branch.')
  const backend = await mockPos(page, { empty: true, accountsEnabled: false })
  await capturePrint(page)
  try {
    const order = await backend.execute<OperationalOrder>({ command: 'save_order', operationId: crypto.randomUUID(),
      orderId: crypto.randomUUID(), expectedRevision: null, name: 'Mostrador', orderKind: 'counter', tableId: null,
      items: [{ lineId: crypto.randomUUID(), kind: 'amount', name: 'Servicio <b>de cortesía</b> 🍵', quantity: 1, unitPriceCents: 2530, note: '' }] } as PosCommand)
    const quote = await backend.execute<CheckoutAttempt>({ command: 'prepare_checkout', operationId: crypto.randomUUID(), orderId: order.id,
      expectedRevision: order.revision, items: order.items.map(line => ({ lineId: line.lineId, quantity: line.quantity })), paymentMethod: 'cash' })
    await backend.execute({ command: 'record_checkout', operationId: crypto.randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true })
    const sale = await acceptedSale(backend)
    expect(sale.items[0]).toMatchObject({ productId: null, kind: 'amount', name: 'Servicio <b>de cortesía</b> 🍵', totalCents: 2530 })
    await unlock(page)
    await history(page)
    const printed = await printReceipt(page)
    await expect(printed.document.locator('tbody')).toContainText('Servicio <b>de cortesía</b> 🍵')
    await expect(printed.document.locator('tbody')).toContainText('Importe libre')
    await expect(printed.document.locator('tbody b')).toHaveCount(0)
    await expect(printed.document.locator('.total dd')).toHaveText('$25.30')
  } finally { await backend.db.close() }
})
