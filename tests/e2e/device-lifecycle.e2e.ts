import { submitPinIfPresent } from './workspace-flow'
import { expect, test, type Page } from '@playwright/test'
import { fixtureAuthKey, fixtureBusiness, fixturePin } from './account-fixture'
import { fixtureCashier, fixtureCashierPin, fixtureDeviceToken, fixturePairingCode, mockOnboarding } from './onboarding-fixture'

const accountUrl = 'http://127.0.0.1:54321/functions/v1/account'
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient')
  })
})

test('a pairing link is consumed before pairing and never forwarded as Google identity', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: true, existingBusiness: true })
  await page.goto(`/employee#pair=${fixturePairingCode}`)
  await expect(page.getByRole('heading', { name: 'Vincular caja compartida', exact: true })).toBeVisible()
  await expect(page.getByLabel('Código para vincular dispositivo', { exact: true })).toHaveValue(fixturePairingCode)
  await expect(page).not.toHaveURL(/#pair=/)
  await expect(page).toHaveURL('http://127.0.0.1:5174/register')
  expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull()
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Caja vinculada por enlace')
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible()
  expect(fixture.calls.filter((call) => !call.action.startsWith('device_'))).toEqual([])
  expect(fixture.authorizations.filter((call) => call.action.startsWith('device_')).every((call) => !call.authorization)).toBe(true)
})

test('revocation discovered on reload clears the device credential and leaves pairing usable', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: false })
  await pair(page)
  fixture.revokeDevice()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Vincular caja compartida', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText(/revocado|vincular/i)
  await expect(page.getByRole('button', { name: 'Vincular dispositivo', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => localStorage.getItem('pos-mexico-device'))).toBeNull()
})

test('a cross-tab lock cancels a pending PIN response and revokes its late operator', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: false })
  await pair(page)
  let release: (() => void) | undefined
  const lateToken = 'f4'.repeat(32)
  await page.route(accountUrl, async (route) => {
    if (route.request().postDataJSON()?.action !== 'device_unlock') return route.fallback()
    await new Promise<void>((resolve) => { release = resolve })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      business: { ...fixtureBusiness, role: 'cashier', employee: { id: fixtureCashier.id, name: fixtureCashier.name, role: 'cashier' }, profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: [] } },
      operatorToken: lateToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } }) })
  })
  try {
    await selectCashier(page)
    await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin)
    await submitPinIfPresent(page);
    await expect.poll(() => typeof release).toBe('function')
    await broadcast(page, 'lock')
    await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible()
    await expect(page.getByRole('button', { name: fixtureCashier.name, exact: true })).toBeDisabled()
    release?.()
    await expect.poll(() => fixture.calls.some((call) => call.action === 'device_lock' && call.operatorToken === lateToken)).toBe(true)
    await expect(page.getByRole('button', { name: fixtureCashier.name, exact: true })).toBeEnabled()
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).not.toBeVisible()
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(lateToken)
  } finally { release?.() }
})

test('a received lock cannot release another pending lock and enable entry early', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: false })
  await pair(page)
  await selectCashier(page)
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin)
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible()
  let release: (() => void) | undefined
  await page.route(accountUrl, async (route) => {
    if (route.request().postDataJSON()?.action !== 'device_lock') return route.fallback()
    await new Promise<void>((resolve) => { release = resolve })
    await route.fallback()
  })
  try {
    await page.getByRole('button', { name: 'Bloquear', exact: true }).click()
    await expect.poll(() => typeof release).toBe('function')
    await broadcast(page, 'lock')
    await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible()
    await expect(page.getByRole('button', { name: fixtureCashier.name, exact: true })).toBeDisabled()
    release?.()
    await expect(page.getByRole('button', { name: fixtureCashier.name, exact: true })).toBeEnabled()
    expect(fixture.calls.filter((call) => call.action === 'device_unlock')).toHaveLength(1)
  } finally { release?.() }
})

test('a cross-tab forget cancels PIN entry and prevents a late response restoring access', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: false })
  await pair(page)
  let release: (() => void) | undefined
  const lateToken = 'e5'.repeat(32)
  await page.route(accountUrl, async (route) => {
    if (route.request().postDataJSON()?.action !== 'device_unlock') return route.fallback()
    await new Promise<void>((resolve) => { release = resolve })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      business: { ...fixtureBusiness, role: 'cashier' }, operatorToken: lateToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } }) })
  })
  try {
    await selectCashier(page)
    await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin)
    await submitPinIfPresent(page);
    await expect.poll(() => typeof release).toBe('function')
    await broadcast(page, 'forget')
    await expect(page.getByRole('heading', { name: 'Vincular caja compartida', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Vinculando…', exact: true })).toBeDisabled()
    release?.()
    await expect.poll(() => fixture.calls.some((call) => call.action === 'device_lock' && call.operatorToken === lateToken)).toBe(true)
    await expect(page.getByRole('button', { name: 'Vincular dispositivo', exact: true })).toBeEnabled()
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).not.toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('pos-mexico-device'))).toBeNull()
  } finally { release?.() }
})

test('disabled storage is detected before a one-use pairing code is consumed', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: false })
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key === 'pos-mexico-device-storage-probe') throw new DOMException('Storage denied', 'QuotaExceededError')
      return write.call(this, key, value)
    }
  })
  await page.goto(`/employee#pair=${fixturePairingCode}`)
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Caja sin almacenamiento')
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/almacenamiento|guardar/i)
  await expect(page.getByLabel('Código para vincular dispositivo', { exact: true })).toHaveValue(fixturePairingCode)
  expect(fixture.calls.filter((call) => call.action === 'device_pair')).toHaveLength(0)
  expect(await page.evaluate(() => localStorage.getItem('pos-mexico-device'))).toBeNull()
})

test('a lost pairing response reuses its operation id on retry', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  const attempts: Record<string, unknown>[] = []
  await page.route(accountUrl, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    if (body.action !== 'device_pair') return route.fallback()
    attempts.push(body)
    if (attempts.length === 1) return route.abort('failed')
    return route.fallback()
  })
  await page.goto(`/employee#pair=${fixturePairingCode}`)
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Caja de reintento')
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible()
  expect(attempts).toHaveLength(2)
  expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId)
  expect(await page.evaluate(() => localStorage.getItem('pos-mexico-device'))).toBe(fixtureDeviceToken)
})

test('returning to the same employee preserves a server PIN cooldown', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  await pair(page)
  let attempts = 0
  await page.route(accountUrl, async (route) => {
    if (route.request().postDataJSON()?.action !== 'device_unlock') return route.fallback()
    attempts += 1
    await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: {
      code: 'PIN_LOCKED', message: 'Espera antes de volver a intentar.', retryAfterSeconds: 2,
    } }) })
  })
  await selectCashier(page)
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixturePin)
  await submitPinIfPresent(page);
  await expect(page.getByTestId('pin-input')).toBeDisabled()
  await page.getByRole('button', { name: 'Cambiar empleado', exact: true }).click()
  await selectCashier(page)
  await expect(page.getByTestId('pin-input')).toBeDisabled()
  expect(attempts).toBe(1)
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeEnabled({ timeout: 5000 })
})

async function pair(page: Page) {
  await page.goto(`/employee#pair=${fixturePairingCode}`)
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Caja para pruebas de sesión')
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible()
}

async function selectCashier(page: Page) {
  await page.getByRole('button', { name: fixtureCashier.name, exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible()
}

async function broadcast(page: Page, type: 'lock' | 'forget') {
  await page.evaluate(async (message) => {
    const channel = new BroadcastChannel('pos-mexico-device-session')
    channel.postMessage(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    channel.close()
  }, type)
}
