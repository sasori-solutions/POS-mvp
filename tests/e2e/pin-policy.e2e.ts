import { expect, test, type Page } from '@playwright/test'
import { fixtureAuthSession, fixtureBusiness, fixturePin } from './account-fixture'
import { fixtureCashier, fixtureInvitation, fixturePinSetup, mockOnboarding } from './onboarding-fixture'

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient'))
})

test('the owner authorizes employee access without choosing or seeing their PIN', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true })
  await owner(page)
  await page.getByRole('button', { name: 'Empleados', exact: true }).click()
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0)
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Empleado autorizado')
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  await expect(page.getByLabel('Enlace de invitación')).toBeVisible()
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Empleado autorizado', pin: null, inviteWithGoogle: true })
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0)
})

test('employee PIN recovery produces an authorization code instead of an owner PIN editor', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true })
  await owner(page)
  await page.getByRole('button', { name: 'Empleados', exact: true }).click()
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cambiar mi PIN', exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Crear código para restablecer PIN', exact: true }).click()
  await expect(page.getByLabel('Código para PIN')).toBeVisible()
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0)
  expect(calls.find((call) => call.action === 'create_pin_setup')).toMatchObject({ employeeId: fixtureCashier.id })
})

test('changing an unlocked personal PIN asks for the current PIN and does not redirect to Google', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true })
  await owner(page)
  await page.getByRole('button', { name: 'Cambiar mi PIN', exact: true }).click()
  await expect(page.getByLabel('PIN actual', { exact: true })).toBeVisible()
  await page.getByLabel('PIN actual', { exact: true }).fill(fixturePin)
  await page.getByTestId('pin-input').fill('028462')
  await page.getByTestId('pin-confirm-input').fill('028462')
  await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Más', exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('PIN actualizado.')
  expect(calls.find((call) => call.action === 'change_pin')).toMatchObject({ businessId: fixtureBusiness.id, currentPin: fixturePin, pin: '028462' })
  expect(calls.filter((call) => call.action === 'reset_pin')).toHaveLength(0)
})

async function owner(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.getByRole('button', { name: 'Más', exact: true }).click()
}

test('Más keeps every action aligned and separated, including PIN settings', async ({ page }, testInfo) => {
  await mockOnboarding(page, { existingBusiness: true })
  await owner(page)
  const actions = await page.locator('.pos-more').getByRole('button').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect()
    return { label: button.textContent, left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom, height: rect.height }
  }))
  expect(actions.length).toBeGreaterThan(4)
  for (const [index, action] of actions.entries()) {
    expect(action.height, action.label ?? '').toBeGreaterThanOrEqual(48)
    expect(Math.abs(action.left - actions[0].left), action.label ?? '').toBeLessThan(1)
    expect(Math.abs(action.width - actions[0].width), action.label ?? '').toBeLessThan(1)
    if (index > 0) expect(action.top - actions[index - 1].bottom, action.label ?? '').toBeGreaterThanOrEqual(0)
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const logout = await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).boundingBox()
  const navigation = await page.getByRole('navigation', { name: 'Navegación principal' }).boundingBox()
  expect(logout!.y + logout!.height).toBeLessThanOrEqual(navigation!.y - 12)
  await page.screenshot({ path: `/tmp/pos-mexico-${testInfo.project.name}-more-pin-layout.png` })
})

async function replaceIdentity(page: Page) {
  const replacement = fixtureAuthSession({}, '63b1c26d-4b3a-4f92-8ef1-890950c33827')
  await page.evaluate(async (identity) => {
    const modulePath = '/src/lib/supabase.ts'
    const { supabase } = await import(modulePath)
    await supabase.auth.setSession(identity)
  }, replacement)
}

test('a new Google session for the same user cancels a pending PIN change', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  let release: (() => void) | undefined
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON().action === 'change_pin') await new Promise<void>((resolve) => { release = resolve })
    await route.fallback()
  })
  try {
    await owner(page)
    await page.getByRole('button', { name: 'Cambiar mi PIN', exact: true }).click()
    await page.getByLabel('PIN actual', { exact: true }).fill(fixturePin)
    await page.getByTestId('pin-input').fill('028462')
    await page.getByTestId('pin-confirm-input').fill('028462')
    await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click()
    await expect.poll(() => Boolean(release)).toBe(true)
    await replaceIdentity(page)
    await expect(page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
    const revoked = page.waitForResponse((response) => response.url().includes('/functions/v1/account') && response.request().postDataJSON()?.action === 'lock')
    release?.()
    await revoked
    await expect(page.getByRole('heading', { name: 'Venta', exact: true })).not.toBeVisible()
  } finally { release?.() }
})

test('a PIN-ready employee linking Google verifies the current PIN without choosing another', async ({ page }) => {
  await mockOnboarding(page, { invitations: [{ id: '78941fc2-cc3f-4e4b-988a-d033ee8f464b', employeeId: fixtureCashier.id, name: fixtureCashier.name, role: 'cashier', active: true, status: 'pending', acceptedAt: null, revokedAt: null, revokeReason: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] })
  await page.goto('/join')
  await page.getByLabel('Enlace de invitación', { exact: true }).fill(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`)
  await page.getByRole('button', { name: 'Abrir invitación', exact: true }).click()
  await expect(page.getByLabel('PIN actual', { exact: true })).toBeVisible()
  await expect(page.getByTestId('pin-confirm-input')).not.toBeVisible()
})

test('a paired register lets the employee choose a PIN after validating an owner code', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: false })
  await page.goto('/register')
  await page.getByLabel('Código para vincular dispositivo').fill('b2'.repeat(32))
  await page.getByLabel('Nombre del dispositivo').fill('Caja de autorización')
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await page.getByRole('button', { name: 'Crear o restablecer mi PIN', exact: true }).click()
  await page.getByLabel('Código de autorización').fill(fixturePinSetup)
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Elige tu PIN', exact: true })).toBeVisible()
  await page.getByLabel('Nuevo PIN', { exact: true }).fill('028462')
  await page.getByLabel('Confirmar nuevo PIN', { exact: true }).fill('028462')
  await page.getByRole('button', { name: 'Guardar mi PIN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible()
  expect(fixture.authorizations.filter((call) => call.action.startsWith('device_')).every((call) => !call.authorization)).toBe(true)
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
  expect(stored).not.toContain(fixturePinSetup)
  expect(stored).not.toContain('028462')
})

for (const role of ['owner', 'cashier'] as const) {
  test(`locking an unlocked ${role} preserves the correct recovery route`, async ({ page }) => {
    await mockOnboarding(page, { existingBusiness: true, role })
    await owner(page)
    await page.getByRole('button', { name: 'Bloquear', exact: true }).click()
    await page.getByRole('button', { name: 'Olvidé mi PIN', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Recupera tu PIN', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Volver a verificar con Google', exact: true })).toHaveCount(0)
  })
}

test('the PIN change cooldown stops another attempt and explains when to retry', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true })
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action !== 'change_pin') return route.fallback()
    await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PIN_LOCKED', message: 'Espera antes de intentar.', retryAfterSeconds: 900 } }) })
  })
  await owner(page)
  await page.getByRole('button', { name: 'Cambiar mi PIN', exact: true }).click()
  await page.getByLabel('PIN actual', { exact: true }).fill(fixturePin)
  await page.getByTestId('pin-input').fill('028462')
  await page.getByTestId('pin-confirm-input').fill('028462')
  await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('15 min')
  await expect(page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true })).toBeDisabled()
  expect(calls.filter((call) => call.action === 'reset_pin')).toHaveLength(0)
})

test('a PIN authorization code disappears when it expires in the open employee detail', async ({ page }) => {
  await page.clock.install()
  await mockOnboarding(page, { existingBusiness: true })
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action !== 'create_pin_setup') return route.fallback()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { setupCode: fixturePinSetup, setupId: 'e11c31b4-1182-459a-886a-b5f93cd2f426', expiresAt: new Date(Date.now() + 30_000).toISOString() } }) })
  })
  await owner(page)
  await page.getByRole('button', { name: 'Empleados', exact: true }).click()
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click()
  await page.getByRole('button', { name: 'Crear código para restablecer PIN', exact: true }).click()
  await expect(page.getByLabel('Código para PIN', { exact: true })).toBeVisible()
  await page.clock.runFor(31_000)
  await expect(page.getByLabel('Código para PIN', { exact: true })).not.toBeVisible()
})

test('a shared register lock cancels PIN setup and revokes its late operator response', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { authenticated: false })
  let release: (() => void) | undefined
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action === 'device_set_employee_pin') await new Promise<void>((resolve) => { release = resolve })
    await route.fallback()
  })
  try {
    await page.goto('/register')
    await page.getByLabel('Código para vincular dispositivo').fill('b2'.repeat(32))
    await page.getByLabel('Nombre del dispositivo').fill('Caja de autorización')
    await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
    await page.getByRole('button', { name: 'Crear o restablecer mi PIN', exact: true }).click()
    await page.getByLabel('Código de autorización').fill(fixturePinSetup)
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    await page.getByLabel('Nuevo PIN', { exact: true }).fill('028462')
    await page.getByLabel('Confirmar nuevo PIN', { exact: true }).fill('028462')
    await page.getByRole('button', { name: 'Guardar mi PIN', exact: true }).click()
    await expect.poll(() => Boolean(release)).toBe(true)
    await page.evaluate(() => { const channel = new BroadcastChannel('pos-mexico-device-session'); channel.postMessage('lock'); setTimeout(() => channel.close(), 50) })
    await expect(page.getByRole('heading', { name: 'Elige tu nombre', exact: true })).toBeVisible()
    const revoked = page.waitForResponse((response) => response.url().includes('/functions/v1/account') && response.request().postDataJSON()?.action === 'device_lock')
    release?.()
    await revoked
    expect(calls.filter((call) => call.action === 'device_lock')).toHaveLength(1)
    await expect(page.getByRole('heading', { name: 'Venta', exact: true })).not.toBeVisible()
    await expect(page.getByLabel('Código de autorización')).not.toBeVisible()
  } finally { release?.() }
})
