import { openOperationalMore, openOwnerTask, submitPinIfPresent } from './workspace-flow'
import { expect, test, type Page } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { fixtureCashier, fixtureDeviceId, fixturePairingCode, mockOnboarding } from './onboarding-fixture'

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient'))
})

async function unlock(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page);
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('owner management tasks fit the viewport and remain directly navigable', async ({ page }, info) => {
  await mockOnboarding(page, { existingBusiness: true, paymentMethods: ['cash', 'card_integrated'] })
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
  await unlock(page)
  await expect(page.locator('#pos-section-title')).toHaveText('Inicio')
  await noOverflow(page)
  await page.screenshot({ path: `/tmp/pos-mas-${info.project.name}-menu.png` })
  for (const task of ['Datos del negocio', 'Empleados', 'Dispositivos de caja', 'Cambiar mi PIN']) {
    await openOwnerTask(page, task)
    const titles: Record<string, string> = { 'Datos del negocio': 'Configuración', 'Dispositivos de caja': 'Dispositivos', 'Cambiar mi PIN': 'Mi acceso' }
    await expect(page.locator('#pos-section-title')).toHaveText(titles[task] ?? task)
    await noOverflow(page)
    await page.screenshot({ path: `/tmp/pos-mas-${info.project.name}-${['Datos del negocio', 'Empleados', 'Dispositivos de caja', 'Cambiar mi PIN'].indexOf(task)}.png`, fullPage: true })
    if (task === 'Datos del negocio') {
      await expect(page.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled()
      for (const y of [0, 500, 1000]) {
        await page.evaluate((top) => window.scrollTo(0, top), y)
        await page.screenshot({ path: `/tmp/pos-mas-${info.project.name}-settings-${y}.png` })
      }
    }
    if (task === 'Empleados') {
      await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Agregar empleado' })).toBeVisible()
      await noOverflow(page)
      await page.screenshot({ path: `/tmp/pos-mas-${info.project.name}-employee-new.png`, fullPage: true })
      await page.getByRole('button', { name: 'Volver a empleados' }).click()
      await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toBeFocused()
      await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}` }).click()
      await expect(page.getByRole('heading', { name: fixtureCashier.name, exact: true })).toBeVisible()
      await page.screenshot({ path: `/tmp/pos-mas-${info.project.name}-employee-detail.png`, fullPage: true })
      await page.getByRole('button', { name: 'Volver a empleados' }).click()
      await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toBeFocused()
    }
    await openOwnerTask(page, 'Inicio', { keyboard: true })
    await expect(page.locator('#pos-section-title')).toHaveText('Inicio')
  }
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 640 })
    await noOverflow(page)
  }
})

test('legacy card preferences convert only after an explicit save and remain unchanged on the next visit', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true })
  await unlock(page)
  await openOwnerTask(page, 'Datos del negocio')
  const save = page.getByRole('button', { name: 'Guardar cambios', exact: true })
  await expect(page.getByRole('checkbox', { name: 'Tarjeta', exact: true })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Tarjeta externa', exact: true })).toHaveCount(0)
  await expect(save).toBeEnabled()
  expect(calls.filter(call => call.action === 'update_business')).toHaveLength(0)
  await save.click()
  await expect(page.getByText('Cambios guardados.', { exact: true })).toBeVisible()
  const updates = calls.filter(call => call.action === 'update_business')
  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({ action: 'update_business', profile: { paymentMethods: ['cash', 'card_integrated'] } })
  await expect(save).toBeDisabled()
  await openOwnerTask(page, 'Inicio')
  await openOwnerTask(page, 'Datos del negocio')
  await expect(page.getByRole('checkbox', { name: 'Tarjeta', exact: true })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeDisabled()
  expect(calls.filter(call => call.action === 'update_business')).toHaveLength(1)
})

test('employee access and session actions stay available in More or the desktop account menu', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true, role: 'cashier' })
  await unlock(page)
  const actions = await openOperationalMore(page)
  if (await page.getByRole('region', { name: 'Más', exact: true }).isVisible()) {
    await expect(actions.getByRole('heading', { name: 'Mi acceso', exact: true })).toBeVisible()
    await expect(actions.getByRole('heading', { name: 'Sesión', exact: true })).toBeVisible()
  } else await expect(actions).toHaveAccessibleName('Opciones de cuenta')
  for (const name of ['Cambiar mi PIN', 'Cambiar negocio', 'Cerrar sesión']) await expect(actions.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Datos del negocio', exact: true })).toHaveCount(0)
  await noOverflow(page)
})

test('device removal requires confirmation and pairing explains where to use the code', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true, devices: [{ id: fixtureDeviceId, name: 'Tablet de prueba', registerName: 'Mostrador', active: true }] })
  await unlock(page)
  await openOwnerTask(page, 'Dispositivos de caja')
  await page.getByRole('button', { name: 'Desvincular Tablet de prueba' }).click()
  await expect(page.getByRole('heading', { name: '¿Desvincular Tablet de prueba?' })).toBeVisible()
  expect(calls.filter((call) => call.action === 'revoke_device')).toHaveLength(0)
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
  expect(calls.filter((call) => call.action === 'revoke_device')).toHaveLength(0)
  await page.getByRole('button', { name: 'Desvincular Tablet de prueba' }).click()
  await page.getByRole('button', { name: 'Confirmar desvinculación' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Dispositivo desvinculado.' })).toHaveText('Dispositivo desvinculado. Ya no permite entrar al negocio.')
  await expect(page.getByRole('button', { name: 'Desvincular Tablet de prueba' })).toHaveCount(0)
  expect(calls.filter((call) => call.action === 'revoke_device')).toHaveLength(1)
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await expect(page.getByLabel('Código para vincular dispositivo')).toHaveValue(fixturePairingCode)
  await expect(page.getByRole('img', { name: 'QR para vincular la caja' })).toBeVisible()
  await expect(page.getByText('Escanéalo desde la caja que vas a vincular.')).toBeVisible()
  await expect(page.getByText('Abre el enlace en la caja y asígnale un nombre.')).toBeVisible()
})
