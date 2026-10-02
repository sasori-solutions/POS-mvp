import { expect, test } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { fixtureCashier, fixtureDeviceToken, mockOnboarding } from './onboarding-fixture'
const token = 'a7'.repeat(32)

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
})

test('forgotten PIN offers one email action, no code or Google, and gives resend feedback', async ({ page }, info) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true, recoveryReady: false })
  await page.goto('/')
  await page.getByRole('button', { name: 'Olvidé mi PIN', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recupera tu PIN' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Google|código/i })).toHaveCount(0)
  await expect(page.locator('input')).toHaveCount(0)
  await page.screenshot({ path: `/tmp/pos-pin-email-${info.project.name}-request.png`, fullPage: true })
  await page.getByRole('button', { name: 'Enviar enlace al correo' }).click()
  await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Reenviar en/ })).toBeDisabled()
  expect(calls.filter(c => c.action === 'request_pin_email')).toHaveLength(1)
  expect(calls.some(c => ['reset_pin','create_recovery_code'].includes(c.action))).toBe(false)
  await page.screenshot({ path: `/tmp/pos-pin-email-${info.project.name}-sent.png`, fullPage: true })
  await page.getByRole('button', { name: 'Volver al PIN' }).click()
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible()
})

test('sending failure stays recoverable and does not claim a sent email', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  await page.route('**/functions/v1/account', async route => {
    if (route.request().postDataJSON().action === 'request_pin_email') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'EMAIL_UNAVAILABLE' } }) })
    else await route.fallback()
  })
  await page.goto('/'); await page.getByRole('button', { name: 'Olvidé mi PIN' }).click()
  await page.getByRole('button', { name: 'Enviar enlace al correo' }).click()
  await expect(page.getByRole('alert')).toContainText('No pudimos enviar')
  await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Enviar enlace al correo' })).toBeEnabled()
})

test('email link confirms the new PIN without authentication and keeps its token out of storage', async ({ page }, info) => {
  const { calls, authorizations } = await mockOnboarding(page, { authenticated: false })
  await page.goto(`/recover-pin#recovery=${token}`)
  await expect(page.getByRole('heading', { name: 'Crea un nuevo PIN' })).toBeVisible()
  expect(page.url()).toMatch(/\/recover-pin$/)
  expect(await page.evaluate(value => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value), token)).toBe(false)
  await page.getByLabel('Nuevo PIN', { exact: true }).fill('024680')
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill('999999')
  await page.getByRole('button', { name: 'Guardar nuevo PIN' }).click()
  await expect(page.getByRole('alert')).toContainText('mismo PIN')
  expect(calls.filter(c => c.action === 'confirm_pin_email')).toHaveLength(0)
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill('024680')
  await page.screenshot({ path: `/tmp/pos-pin-email-${info.project.name}-form.png`, fullPage: true })
  await page.getByRole('button', { name: 'Guardar nuevo PIN' }).click()
  await expect(page.getByRole('heading', { name: 'PIN actualizado' })).toBeVisible()
  expect(authorizations.filter(c => c.action.includes('pin_email')).every(c => !c.authorization)).toBe(true)
  expect(calls.filter(c => c.action === 'confirm_pin_email')).toHaveLength(1)
  await page.screenshot({ path: `/tmp/pos-pin-email-${info.project.name}-done.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Necesitas un nuevo enlace' })).toBeVisible()
})

test('expired or reused links cannot reach a new PIN form', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  await page.route('**/functions/v1/account', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RECOVERY_INVALID' } }) }))
  await page.goto(`/recover-pin#recovery=${token}`)
  await expect(page.getByRole('heading', { name: 'Necesitas un nuevo enlace' })).toBeVisible()
  await expect(page.locator('input')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Google|código/ })).toHaveCount(0)
})

test('a lost confirmation response retries the same operation without exposing a code', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { authenticated: false })
  const attempts: Record<string, unknown>[] = []
  let first = true
  await page.route('**/functions/v1/account', async route => {
    if (route.request().postDataJSON().action === 'confirm_pin_email') { attempts.push(route.request().postDataJSON()); if (first) { first = false; await route.abort(); return } }
    await route.fallback()
  })
  await page.goto(`/recover-pin#recovery=${token}`)
  await page.getByLabel('Nuevo PIN', { exact: true }).fill('024680'); await page.getByLabel('Confirma tu PIN').fill('024680')
  await page.getByRole('button', { name: 'Guardar nuevo PIN' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Guardar nuevo PIN' }).click()
  await expect(page.getByRole('heading', { name: 'PIN actualizado' })).toBeVisible()
  expect(calls.filter(c => c.action === 'confirm_pin_email')).toHaveLength(1)
  expect(attempts).toHaveLength(2)
  expect(attempts[0].operationId).toBe(attempts[1].operationId)
})

test('linked employees can request email recovery from their personal account', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true, role: 'cashier' })
  await page.goto('/'); await page.getByRole('button', { name: 'Olvidé mi PIN' }).click()
  await page.getByRole('button', { name: 'Enviar enlace al correo' }).click()
  await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible()
  expect(calls.some(c => c.action==='request_pin_email')).toBe(true)
})

test('paired registers request email for the selected employee without personal identity', async ({ page }) => {
  const { calls, authorizations } = await mockOnboarding(page, { authenticated: false })
  await page.goto('/employee')
  await page.getByLabel('Código para vincular dispositivo').fill('b2'.repeat(32)); await page.getByLabel('Nombre del dispositivo').fill('Caja sintética')
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await page.getByRole('button', { name: new RegExp(fixtureCashier.name) }).click()
  await page.getByRole('button', { name: 'Olvidé mi PIN' }).click()
  await page.getByRole('button', { name: 'Enviar enlace al correo' }).click()
  await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible()
  expect(calls.find(c => c.action==='device_request_pin_email')).toMatchObject({ deviceToken: fixtureDeviceToken, employeeId: fixtureCashier.id })
  expect(authorizations.find(c => c.action==='device_request_pin_email')?.authorization).toBeUndefined()
})

test('Más has no recovery-code setup and a known PIN still changes with the current PIN', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  await page.goto('/'); await page.getByTestId('pin-input').fill(fixturePin); await page.getByRole('button', { name: 'Entrar', exact:true }).click()
  await page.getByRole('button', { name: 'Más', exact:true }).click()
  await expect(page.getByRole('button', { name: 'Código de recuperación' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cambiar mi PIN', exact:true }).click()
  await expect(page.getByLabel('PIN actual', { exact: true })).toBeVisible()
})
