import { expect, test, type Page } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { fixtureInvitation, mockOnboarding } from './onboarding-fixture'

async function openCreation(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.getByRole('button', { name: 'Más', exact: true }).click()
  await page.getByRole('button', { name: 'Empleados', exact: true }).click()
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
})

test('role choices show included and restricted sections and work by keyboard', async ({ page }, info) => {
  await mockOnboarding(page, { existingBusiness: true })
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
  await openCreation(page)
  const included = page.getByRole('region', { name: 'Puede abrir', exact: true })
  const restricted = page.getByRole('region', { name: 'Sin acceso', exact: true })
  await expect(included.getByRole('listitem')).toHaveText(['Venta', 'Comandas', 'Productos'])
  await expect(restricted.getByRole('listitem')).toHaveText(['Ventas', 'Datos del negocio', 'Empleados y dispositivos'])
  await page.getByRole('radio', { name: 'Cajero', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: 'Cocina', exact: true })).toBeChecked()
  await expect(included.getByRole('listitem')).toHaveText(['Comandas'])
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('radio', { name: 'Encargado', exact: true })).toBeChecked()
  await expect(included.getByRole('listitem')).toHaveText(['Venta', 'Comandas', 'Ventas', 'Productos'])
  await expect(restricted.getByRole('listitem')).toHaveText(['Datos del negocio', 'Empleados y dispositivos'])
  await page.getByRole('radio', { name: 'Cajero', exact: true }).check()
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Ana de prueba')
  await page.screenshot({ path: `/tmp/pos-employee-${info.project.name}-form.png`, fullPage: true })
  for (const y of [0, 350, 700]) {
    await page.evaluate((top) => window.scrollTo(0, top), y)
    await page.screenshot({ path: `/tmp/pos-employee-${info.project.name}-form-${y}.png` })
  }
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    for (const label of await page.locator('.employee-role-choices label').all()) {
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(48)
    }
  }
})

test('creation leads to sharing one invitation and copy failure leaves a selectable link', async ({ page }, info) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true })
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Clipboard denied')) } }))
  await openCreation(page)
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Ana de prueba')
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Invitación lista', exact: true })).toBeFocused()
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Crear código para PIN', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Enlace de invitación')).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`)
  await page.screenshot({ path: `/tmp/pos-employee-${info.project.name}-invitation.png`, fullPage: true })
  await page.getByRole('button', { name: 'Copiar enlace', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('No pudimos copiar el enlace. Selecciónalo y cópialo del campo.')
  await page.getByLabel('Enlace de invitación').focus()
  expect(await page.getByLabel('Enlace de invitación').evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBeGreaterThan(64)
  expect(calls.filter((call) => call.action === 'create_employee')).toHaveLength(1)
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Ana de prueba', role: 'cashier', inviteWithGoogle: true, pin: null })
  await page.getByRole('button', { name: 'Listo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Administrar Ana de prueba', exact: true })).toHaveCount(1)
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(fixtureInvitation)
})
