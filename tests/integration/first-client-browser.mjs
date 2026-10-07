/** Manual first-client acceptance through a dedicated browser and real local Auth/Edge/Postgres.
 * Run with Node 24 from the combined preview after the accounts, free-amount,
 * receipt/external-card and shift-payment-summary changes are integrated/applied.
 * The caller starts the isolated frontend on 127.0.0.1:5175; this script starts no
 * server/container, resets nothing, and never accesses an existing browser/user.
 * Required in-memory environment: TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY,
 * TEST_SUPABASE_SERVICE_ROLE_KEY, TEST_SUPABASE_WORKDIR, TEST_EXPECTED_PROJECT_ID.
 * TEST_LOCAL_DB_CONTAINER, TEST_APP_ORIGIN and TEST_SCREENSHOT_DIRECTORY are optional.
 * The only response interception fetches the real request first, then drops its delivery.
 * Local password Auth does not accredit hosted Google or any physical payment/printing device.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { enterOperations, openOwnerTask, submitPinIfPresent } from '../e2e/workspace-flow.ts'

const origin = process.env.TEST_APP_ORIGIN ?? 'http://127.0.0.1:5175'
assert.equal(new URL(origin).origin, 'http://127.0.0.1:5175', 'Use the dedicated test frontend on port 5175')
const backendUrl = process.env.TEST_SUPABASE_URL
assert(backendUrl && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(backendUrl).hostname), 'Explicit loopback Supabase required')
const anonKey = process.env.TEST_SUPABASE_ANON_KEY
const serviceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY
assert(anonKey && serviceKey, 'Pass local keys in memory; never write a credentials file')
const workdir = process.env.TEST_SUPABASE_WORKDIR
assert(workdir && process.env.TEST_EXPECTED_PROJECT_ID, 'Identify the existing local stack before running')
const stackConfig = readFileSync(resolve(workdir, 'supabase/config.toml'), 'utf8')
const projectId = stackConfig.match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
assert.equal(projectId, process.env.TEST_EXPECTED_PROJECT_ID, 'Existing stack identity must match the caller expectation')
const apiConfig = stackConfig.split(/^\[api\]\s*$/m)[1]?.split(/^\[/m)[0]
const apiPort = apiConfig?.match(/^port\s*=\s*(\d+)/m)?.[1]
assert(apiPort, 'Identified stack must declare its local API port')
assert.equal(new URL(backendUrl).protocol, 'http:', 'Use the local HTTP API')
assert.equal(new URL(backendUrl).port, apiPort, 'API must belong to the identified stack before creating fixtures')
const container = process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${projectId}`
assert.equal(container, `supabase_db_${projectId}`, 'Database must belong to that same local stack')
assert.match(readFileSync('src/components/HomeScreen.tsx', 'utf8'), /serviceAccounts=\{accountsEnabled\}/, 'Combined preview must reflect accounts mode in Venta')
assert.match(readFileSync('src/lib/operations-contracts.ts', 'utf8'), /paymentSummary\??:/, 'Shift-payment-summary contract is required')
assert.match(readFileSync('src/lib/sale-receipt.ts', 'utf8'), /buildSaleReceipt|saleReceipt/, 'Receipt implementation is required')
const artifacts = resolve(process.env.TEST_SCREENSHOT_DIRECTORY ?? 'artifacts/qa/first-client-real')
mkdirSync(artifacts, { recursive: true })
const pin = '583927'
const businessName = `Primer cliente sintético ${randomUUID().slice(0, 8)}`
const accountName = 'Cuenta sintética de aceptación'
const productName = 'Café exacto de Córdoba'
const credentials = { email: `first-client-${randomUUID()}@example.test`, password: `local-only-${randomUUID()}-Aa9!` }
const admin = createClient(backendUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
let browser, context, page, userId, businessId, access, stage = 'setup', loss, lossDeadline
const checkoutMutations = []
const errors = []
const evidence = []

function sql(statement) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'],
    { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
function uuid(value) { assert.match(value, /^[a-f0-9-]{36}$/i); return `'${value}'::uuid` }
function body(request) { try { return request.postDataJSON() } catch { return null } }
function mutation(request) {
  return Object.fromEntries(Object.entries(request).filter(([key]) => !['operatorToken', 'deviceToken', 'deviceProof'].includes(key)))
}
function responseFor(action, predicate = () => true) {
  return page.waitForResponse(response => response.url().endsWith('/functions/v1/account') && body(response.request())?.action === action
    && predicate(body(response.request())), { timeout: 30_000 }).then(async response => {
    const reply = await response.json()
    assert(response.ok() && reply.data, `Real ${action} failed with ${reply.error?.code ?? response.status()}`)
    return reply.data
  })
}
async function clickCommand(command, control, predicate = () => true) {
  const accepted = responseFor('pos', request => request.command === command && predicate(request))
  await control.click()
  return accepted
}
async function api(command) {
  return page.evaluate(async ({ access, command }) => {
    const { accountRequest } = await import('/src/lib/account.ts')
    return accountRequest({ action: 'pos', ...access, ...command })
  }, { access, command })
}
async function unlock() {
  const input = page.getByTestId('pin-input')
  await expect(input).toBeVisible({ timeout: 30_000 })
  const accepted = responseFor('unlock', request => request.businessId === businessId)
  await input.fill(pin)
  await submitPinIfPresent(page)
  const session = await accepted
  access = { businessId, operatorToken: session.operatorToken }
  await expect(page.locator('#pos-section-title')).toBeVisible()
}
async function operation(name) {
  await enterOperations(page)
  if (name === 'Venta') return
  await page.getByRole('navigation').getByRole('button', { name: name === 'Comandas' ? /^(?:\d+ )?Comandas$/ : name, exact: name !== 'Comandas' }).filter({ visible: true }).first().click()
  await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible()
}
async function configureMode(enabled) {
  await openOwnerTask(page, 'Datos del negocio')
  const label = page.locator('label').filter({ has: page.getByRole('radio', { name: new RegExp(`^${enabled ? 'Cuentas abiertas' : 'Cobro directo'}`) }) })
  await label.click()
  const accepted = responseFor('update_business')
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click()
  assert.equal((await accepted).profile.accountsEnabled, enabled)
  await expect(page.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeDisabled()
}
async function cart() {
  const trigger = page.getByRole('button', { name: /^Ver cuenta/ })
  if (await trigger.isVisible() && await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
}
async function addProduct() {
  await operation('Venta')
  await page.getByRole('button', { name: new RegExp(`^Agregar ${productName},`) }).click()
  const selection = page.getByRole('dialog', { name: productName, exact: true })
  await selection.getByRole('radio', { name: /^Avena/ }).check()
  await selection.getByRole('button', { name: 'Agregar · $10.12', exact: true }).click()
  await cart()
}
async function paidReceipt(amount) {
  const receipt = page.getByRole('dialog', { name: 'Pago registrado', exact: true })
  await expect(receipt).toBeVisible()
  await expect(receipt.locator('.sale-total')).toContainText(amount)
  await expect(receipt.getByRole('button', { name: 'Imprimir / guardar PDF', exact: true })).toBeVisible()
  await screenshot('receipt', receipt.getByRole('button', { name: 'Imprimir / guardar PDF', exact: true }))
  await receipt.getByRole('button', { name: 'Listo', exact: true }).click()
  await expect(receipt).not.toBeVisible()
}
async function screenshot(name, control) {
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 940 })
    if (control) {
      await control.scrollIntoViewIfNeeded()
      await expect(control).toBeInViewport({ ratio: 1 })
      const bounds = await control.boundingBox()
      assert(bounds && bounds.width >= 48 && bounds.height >= 48, `${name} primary control requires 48 px`)
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} must fit viewport`)
    await page.screenshot({ path: `${artifacts}/${name}-${width}.png` })
    evidence.push(`${name}-${width}.png`)
  }
  await page.setViewportSize({ width: 390, height: 940 })
}
async function openAccount() {
  await operation('Comandas')
  await page.getByRole('group', { name: 'Comandas y cuentas', exact: true }).getByRole('button', { name: 'Cuentas', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(`^${accountName}`) }).click()
  const detail = page.getByRole('dialog', { name: accountName, exact: true })
  await expect(detail).toBeVisible()
  return detail
}
async function summaryUI(scope) {
  const summary = scope.getByRole('region', { name: 'Cobros por método del turno', exact: true })
  await expect(summary).toBeVisible()
  for (const [label, amounts] of [['Efectivo', ['$10.12', '$0.00', '$10.12']], ['Tarjeta externa', ['$20.24', '$20.24', '$0.00']], ['Transferencia', ['$10.12', '$0.00', '$10.12']], ['Total registrado', ['$40.48', '$20.24', '$20.24']]]) {
    const row = summary.locator('li').filter({ has: page.getByText(label, { exact: true }) })
    await expect(row.locator('dd')).toHaveText(amounts)
  }
  return summary
}
function summaryContract(shift) {
  assert(shift.paymentSummary, 'Actual shift response must include its payment summary')
  assert.deepEqual({ collected: shift.paymentSummary.collectedCents, refunded: shift.paymentSummary.refundedCents, net: shift.paymentSummary.netCents }, { collected: 4048, refunded: 2024, net: 2024 })
  for (const [method, amounts] of [['cash', [1012, 0, 1012]], ['card_external', [2024, 2024, 0]], ['transfer', [1012, 0, 1012]], ['card_integrated', [0, 0, 0]]]) {
    const row = shift.paymentSummary.payments.find(item => item.paymentMethod === method)
    assert(row, `Shift must include ${method}`)
    assert.deepEqual([row.collectedCents, row.refundedCents, row.netCents], amounts)
  }
  assert.equal(shift.paymentSummary.pointRefundsNotAttributed, true)
}

try {
  assert.equal((await fetch(origin)).ok, true, 'Caller must start the isolated frontend')
  const created = await admin.auth.admin.createUser({ ...credentials, email_confirm: true })
  assert(!created.error && created.data.user, 'Could not create synthetic local Auth owner')
  userId = created.data.user.id
  assert.equal(sql(`select count(*) from auth.users where id=${uuid(userId)};`), '1', 'Auth API and identified database must be the same stack')
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 390, height: 940 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await context.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  await context.route('**/functions/v1/account', async route => {
    const request = body(route.request())
    if (request?.command === 'record_checkout') checkoutMutations.push(mutation(request))
    if (loss && request?.command === 'record_checkout') {
      const pending = loss; loss = null
      try {
        const response = await route.fetch({ timeout: 30_000 })
        const reply = await response.json()
        assert(response.ok() && reply.data, 'Backend must accept record_checkout before response loss')
        await route.abort('failed')
        pending.resolve(reply.data)
      } catch {
        await route.abort('failed').catch(() => {})
        pending.reject(new Error('Response-loss verification failed before a confirmed checkout result'))
      }
    } else await route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', () => errors.push('Browser runtime error'))
  stage = 'synthetic local Auth and business bootstrap'
  await page.goto(origin)
  await page.evaluate(async ({ credentials, backendUrl, anonKey }) => {
    const { supabase, supabaseUrl, supabasePublishableKey } = await import('/src/lib/supabase.ts')
    if (new URL(supabaseUrl).origin !== new URL(backendUrl).origin || supabasePublishableKey !== anonKey) throw new Error('Isolated frontend must use the identified local stack')
    const result = await supabase.auth.signInWithPassword(credentials)
    if (result.error) throw new Error('Synthetic local password Auth failed')
  }, { credentials, backendUrl, anonKey })
  const fixture = await page.evaluate(async ({ name, pin }) => {
    const { accountRequest } = await import('/src/lib/account.ts')
    const { supabase } = await import('/src/lib/supabase.ts')
    const result = await accountRequest({ action: 'create_business', name, businessType: 'cafe', timezone: 'America/Mexico_City', pin,
      operationId: crypto.randomUUID(), profile: { branchName: 'Principal', registerName: 'Caja sintética', address: '', city: '', state: '', contactPhone: '',
        paymentMethods: ['cash', 'card_external', 'transfer'], accountsEnabled: false, defaultVatTreatment: 'vat_16' } })
    const { data } = await supabase.auth.getSession()
    localStorage.setItem(`pos-mexico-last-business:${data.session.user.id}`, result.business.id)
    return { businessId: result.business.id }
  }, { name: businessName, pin })
  businessId = fixture.businessId
  await page.reload()
  await unlock()

  stage = 'configure a real menu through the product editor'
  await openOwnerTask(page, 'Productos')
  await page.getByRole('button', { name: 'Agregar producto', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Agregar producto', exact: true })
  await editor.getByLabel('Nombre', { exact: true }).fill(productName)
  await editor.getByLabel('Precio final MXN', { exact: true }).fill('10.01')
  await editor.getByRole('button', { name: 'Añadir grupo de modificadores', exact: true }).click()
  await editor.getByLabel('Grupo 1', { exact: true }).fill('Leche')
  await editor.getByLabel('Selecciones mínimas', { exact: true }).fill('1')
  await editor.getByLabel('Opción 1 de grupo 1', { exact: true }).fill('Avena')
  await editor.getByLabel('Precio extra 1', { exact: true }).fill('0.11')
  const product = await clickCommand('save_product', editor.getByRole('button', { name: 'Guardar producto', exact: true }))
  assert.equal(product.priceCents, 1001)
  assert.equal(product.details.modifierSets[0].options[0].priceCents, 11)

  stage = 'activate and open cash, record entry and withdrawal'
  await openOwnerTask(page, 'Caja')
  await page.getByRole('checkbox', { name: 'Dispositivos actualizados y ventas pendientes conciliadas.', exact: true }).check()
  await clickCommand('activate_operations', page.getByRole('button', { name: 'Activar turnos', exact: true }))
  await page.getByLabel('Efectivo inicial', { exact: true }).fill('100.00')
  const shift = await clickCommand('open_shift', page.getByRole('button', { name: 'Abrir turno', exact: true }))
  assert.equal(shift.openingCents, 10000)
  const movement = page.locator('details.cash-movement-form')
  await movement.locator('summary').click()
  for (const [label, amount, expected] of [['Entrada', '25.00', 2500], ['Retiro', '10.00', 1000]]) {
    await movement.getByRole('button', { name: label, exact: true }).click()
    await movement.getByLabel('Importe', { exact: true }).fill(amount)
    await movement.getByLabel('Motivo', { exact: true }).fill(`${label} sintética de aceptación`)
    const updated = await clickCommand('cash_movement', movement.getByRole('button', { name: 'Guardar movimiento', exact: true }))
    assert.equal(updated.movements.at(-1).amountCents, expected)
  }
  await screenshot('cash-open', page.getByRole('button', { name: 'Iniciar cierre', exact: true }))

  stage = 'counter cash sale automatically creates the kitchen snapshot'
  await addProduct()
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  const checkout = page.getByRole('dialog', { name: 'Cobrar', exact: true })
  const cash = await clickCommand('record_checkout', checkout.getByRole('button', { name: 'Registrar pago', exact: true }))
  assert.equal(cash.attempt.totalCents, 1012)
  assert.equal(cash.order.orderKind, 'counter')
  assert.equal((await api({ command: 'kitchen' })).batches.filter(item => item.orderId === cash.order.id).length, 1)
  await paidReceipt('$10.12')

  stage = 'accounts mode corrects quantities before sending kitchen work'
  await configureMode(true)
  await addProduct()
  await page.getByLabel('Nombre de la cuenta', { exact: true }).fill(accountName)
  const saved = await clickCommand('save_order', page.getByRole('button', { name: 'Abrir cuenta', exact: true }))
  assert.equal(saved.orderKind, 'service')
  assert.equal(saved.paidCents, 0)
  assert.equal((await api({ command: 'kitchen' })).batches.filter(item => item.orderId === saved.id).length, 0)
  const account = page.getByRole('dialog', { name: accountName, exact: true })
  await account.getByRole('button', { name: 'Editar artículos', exact: true }).click()
  const orderEditor = page.getByRole('dialog', { name: 'Editar cuenta', exact: true })
  await orderEditor.getByRole('button', { name: `Añadir ${productName}`, exact: true }).click()
  await orderEditor.getByRole('button', { name: `Añadir ${productName}`, exact: true }).click()
  await orderEditor.getByRole('button', { name: `Reducir ${productName}`, exact: true }).click()
  await orderEditor.locator('details.order-editor-note summary').click()
  await orderEditor.getByLabel(`Nota de cocina para ${productName}`, { exact: true }).fill('Sin azúcar; preparación sintética')
  const corrected = await clickCommand('save_order', orderEditor.getByRole('button', { name: 'Guardar cuenta', exact: true }))
  assert.equal(corrected.totalCents, 2024)
  assert.equal(corrected.items[0].quantity, 2)
  await clickCommand('send_order', account.getByRole('button', { name: 'Enviar a cocina', exact: true }))
  await account.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await operation('Comandas')
  const sections = page.getByRole('group', { name: 'Comandas y cuentas', exact: true })
  await sections.getByRole('button', { name: 'Comandas', exact: true }).click()
  const batch = page.getByRole('region', { name: `Comanda ${accountName}`, exact: true })
  await expect(batch).toContainText(`2 × ${productName}`)
  await expect(batch).toContainText('Avena')
  await expect(batch).toContainText('Sin azúcar; preparación sintética')
  await screenshot('kitchen-queued', batch.getByRole('button', { name: 'Comenzar', exact: true }))
  await clickCommand('set_kitchen_status', batch.getByRole('button', { name: 'Comenzar', exact: true }))
  await page.getByRole('button', { name: /^En proceso/ }).click()
  const delivered = await clickCommand('set_kitchen_status', batch.getByRole('button', { name: 'Completar', exact: true }))
  assert.equal(delivered.status, 'delivered')
  assert.equal(delivered.items[0].quantity, 2)

  stage = 'confirmed external payment, committed response loss, reload and exact replay'
  const detail = await openAccount()
  await detail.getByRole('button', { name: 'Cobrar $20.24', exact: true }).click()
  await checkout.locator('label').filter({ has: page.getByRole('radio', { name: 'Tarjeta externa', exact: true }) }).click()
  await expect(checkout.getByRole('button', { name: 'Registrar pago', exact: true })).toBeDisabled()
  await checkout.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.', exact: true }).check()
  await screenshot('external-confirmed', checkout.getByRole('button', { name: 'Registrar pago', exact: true }))
  const committed = new Promise((resolve, reject) => {
    lossDeadline = setTimeout(() => { loss = null; reject(new Error('Timed out awaiting the accepted checkout before response loss')) }, 35_000)
    loss = {
      resolve: reply => { clearTimeout(lossDeadline); resolve(reply) },
      reject: error => { clearTimeout(lossDeadline); reject(error) },
    }
  })
  // Attach a rejection handler while Playwright waits for the click to finish.
  committed.catch(() => {})
  await checkout.getByRole('button', { name: 'Registrar pago', exact: true }).click()
  const external = await committed
  assert.equal(external.attempt.paymentMethod, 'card_external')
  assert.equal(external.attempt.totalCents, 2024)
  const retry = page.getByRole('button', { name: 'Reintentar solicitud guardada', exact: true }).filter({ visible: true }).first()
  await expect(retry).toBeEnabled()
  await page.reload()
  await unlock()
  const replayed = await clickCommand('record_checkout', retry)
  assert.equal(replayed.attempt.saleId, external.attempt.saleId)
  assert.deepEqual(checkoutMutations.at(-1), checkoutMutations.at(-2), 'Retry must preserve the exact financial mutation')
  await paidReceipt('$20.24')
  assert.equal(sql(`select count(*) from app_private.sales where business_id=${uuid(businessId)} and payment_method='card_external';`), '1')

  stage = 'full external refund preserves its original sale'
  const original = await api({ command: 'sale', saleId: external.attempt.saleId })
  await openOwnerTask(page, 'Ventas')
  await page.getByRole('button', { name: new RegExp(`^Ver venta ${external.attempt.saleId.slice(0, 8)},`, 'i') }).click()
  const saleDetail = page.getByRole('dialog', { name: 'Venta', exact: true })
  await saleDetail.locator('summary').filter({ hasText: 'Devolver venta completa' }).click()
  await saleDetail.getByLabel('Motivo', { exact: true }).fill('Devolución sintética completa')
  const refund = await clickCommand('prepare_reversal', saleDetail.getByRole('button', { name: 'Preparar devolución completa', exact: true }))
  assert.equal(refund.totalCents, 2024)
  assert.equal(refund.shiftId, shift.id)
  await clickCommand('start_checkout', saleDetail.getByRole('button', { name: 'Iniciar devolución', exact: true }))
  await expect(saleDetail.getByRole('button', { name: 'Registrar devolución', exact: true })).toBeDisabled()
  await saleDetail.getByRole('checkbox', { name: 'Confirmo que la devolución se realizó en la terminal externa.', exact: true }).check()
  const refunded = await clickCommand('resolve_checkout', saleDetail.getByRole('button', { name: 'Registrar devolución', exact: true }), request => request.resolution === 'complete')
  assert.equal(refunded.status, 'completed')
  assert.equal(refunded.totalCents, 2024)
  assert.deepEqual(await api({ command: 'sale', saleId: external.attempt.saleId }), original, 'Finalized original sale remains immutable')
  await screenshot('refund-completed')
  await saleDetail.getByRole('button', { name: 'Cerrar', exact: true }).click()

  stage = 'transfer sale and shift-specific totals'
  await configureMode(false)
  await addProduct()
  await page.getByRole('button', { name: 'Cobrar', exact: true }).click()
  await checkout.locator('label').filter({ has: page.getByRole('radio', { name: 'Transferencia', exact: true }) }).click()
  const transfer = await clickCommand('record_checkout', checkout.getByRole('button', { name: 'Registrar pago', exact: true }))
  assert.equal(transfer.attempt.paymentMethod, 'transfer')
  assert.equal(transfer.attempt.totalCents, 1012)
  await paidReceipt('$10.12')
  await openOwnerTask(page, 'Caja')
  summaryContract((await api({ command: 'operations' })).shift)
  await summaryUI(page)
  await screenshot('cash-method-totals', page.getByRole('button', { name: 'Iniciar cierre', exact: true }))

  stage = 'blind cash count and closed-shift totals'
  const counting = await clickCommand('begin_shift_close', page.getByRole('button', { name: 'Iniciar cierre', exact: true }))
  assert.equal(counting.status, 'closing')
  assert.equal(counting.expectedCents, null)
  assert.equal(counting.paymentSummary, undefined)
  await expect(page.getByRole('region', { name: 'Cobros por método del turno', exact: true })).toHaveCount(0)
  await expect(page.getByText('Esperado', { exact: true })).toHaveCount(0)
  await page.getByLabel('Efectivo contado', { exact: true }).fill('125.62')
  await screenshot('cash-blind-count', page.getByRole('button', { name: 'Guardar conteo y cerrar', exact: true }))
  const closed = await clickCommand('close_shift', page.getByRole('button', { name: 'Guardar conteo y cerrar', exact: true }))
  assert.equal(closed.status, 'closed')
  assert.deepEqual([closed.expectedCents, closed.countedCents, closed.differenceCents], [12512, 12562, 50])
  summaryContract(closed)
  const last = page.locator('.cash-last-shift')
  await expect(last.locator('dl.ops-totals dd')).toHaveText(['$125.12', '$125.62', '$0.50'])
  await summaryUI(last)
  await screenshot('cash-closed')
  const persisted = (await api({ command: 'shifts' })).shifts.find(item => item.id === shift.id)
  summaryContract(persisted)
  assert.equal(sql(`select count(*) from app_private.sales where business_id=${uuid(businessId)};`), '3')
  assert.equal(sql(`select count(*) from app_private.sale_reversals where business_id=${uuid(businessId)};`), '1')
  assert.equal(errors.length, 0, 'No browser runtime exceptions')
  console.log(JSON.stringify({ passed: true, workflow: 'synthetic local Auth → real Edge → PostgreSQL', modes: ['counter', 'service'],
    cashCents: 1012, externalCents: 2024, transferCents: 1012, refundedCents: 2024, expectedDrawerCents: 12512, countedCents: 12562, differenceCents: 50,
    responseLoss: 'record_checkout after server acceptance', screenshots: artifacts, evidence, limitations: ['local password Auth; no hosted Google', 'no physical payment or printing device'] }))
} catch (error) {
  if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {})
  console.error(JSON.stringify({ failed: true, stage, message: String(error.message).split('\n')[0], screenshots: artifacts }))
  process.exitCode = 1
} finally {
  clearTimeout(lossDeadline)
  if (context) await context.close()
  if (browser) await browser.close()
  if (userId) {
    // This user was created above. Recover even a lost bootstrap result, and
    // delete only businesses owned by this new synthetic identity.
    try {
      const owned = sql(`select business_id from app_private.business_memberships where user_id=${uuid(userId)} and role='owner';`).split('\n').filter(Boolean)
      for (const id of owned) {
        assert.equal(sql(`select count(*) from app_private.businesses where id=${uuid(id)} and name='${businessName.replaceAll("'", "''")}';`), '1', 'Cleanup only owns synthetic businesses from this run')
        sql(`delete from app_private.businesses where id=${uuid(id)};`)
      }
    } finally {
      const deleted = await admin.auth.admin.deleteUser(userId)
      assert(!deleted.error, 'Synthetic Auth cleanup must succeed')
    }
  }
}
