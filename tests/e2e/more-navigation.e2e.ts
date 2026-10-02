import { expect, test, type Page } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { fixtureCashier, fixtureDeviceId, fixturePairingCode, mockOnboarding } from './onboarding-fixture'

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient'))
})

async function openMore(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.getByRole('button', { name: 'Más', exact: true }).click()
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('More and its subpages have readable task groups and fit the viewport', async ({ page }, info) => {
  await mockOnboarding(page, { existingBusiness: true })
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
  await openMore(page)
  await expect(page.getByRole('heading', { name: 'Negocio', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mi acceso', exact: true })).toBeVisible()
  await noOverflow(page)
  await page.screenshot({ path: `/tmp/pos-mas-${info.project.name}-menu.png` })
  for (const task of ['Datos del negocio', 'Empleados', 'Dispositivos de caja', 'Cambiar mi PIN']) {
    await page.getByRole('button', { name: task, exact: true }).click()
    await expect(page.getByRole('heading', { name: task, exact: true })).toBeVisible()
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
      await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}` }).click()
      await expect(page.getByRole('heading', { name: 'Invitación' })).toBeVisible()
      await page.screenshot({ path: `/tmp/pos-mas-${info.project.name}-employee-detail.png`, fullPage: true })
      await page.getByRole('button', { name: 'Volver a empleados' }).click()
    }
    await page.getByRole('button', { name: 'Volver a Más', exact: true }).click()
    await expect(page.getByRole('button', { name: task, exact: true })).toBeFocused()
  }
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 640 })
    await noOverflow(page)
  }
})

test('device removal requires confirmation and pairing explains where to use the code', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true, devices: [{ id: fixtureDeviceId, name: 'Tablet de prueba', registerName: 'Mostrador', active: true }] })
  await openMore(page)
  await page.getByRole('button', { name: 'Dispositivos de caja', exact: true }).click()
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
  await expect(page.getByText('Abre el enlace o escanea el QR en el dispositivo de caja.')).toBeVisible()
})
