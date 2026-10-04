import { submitPinIfPresent } from './workspace-flow'
import { openOwnerTask } from './workspace-flow'
import { expect, test, type Page } from '@playwright/test'
import jsQR from 'jsqr'
import { fixturePin } from './account-fixture'
import { fixtureInvitation, fixturePairingCode, mockOnboarding } from './onboarding-fixture'

async function openCreation(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page);
  await openOwnerTask(page, 'Empleados')
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
}

async function readQr(page: Page, name: string) {
  const pixels = await page.getByRole('img', { name }).evaluate(async (svg) => {
    const image = new Image()
    const source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }))
    try {
      image.src = source
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 384
      canvas.height = 384
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      return { data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height }
    } finally { URL.revokeObjectURL(source) }
  })
  return jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
})

test('grouped permissions start empty and work by keyboard with prerequisites', async ({ page }, info) => {
  await mockOnboarding(page, { existingBusiness: true })
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
  await openCreation(page)
  const permissions = page.getByRole('group', { name: 'Permisos', exact: true })
  await expect(permissions.getByRole('checkbox')).toHaveCount(19)
  await expect(permissions.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(page.getByRole('radio')).toHaveCount(0)
  for (const name of ['Catálogo', 'Ventas', 'Órdenes', 'Comandas', 'Caja', 'Reportes']) {
    await expect(permissions.getByRole('group', { name, exact: true })).toBeVisible()
  }
  await expect(permissions.getByText('Administrar empleados y el negocio corresponde al dueño.', { exact: false })).toBeVisible()
  const catalogRead = permissions.getByRole('checkbox', { name: 'Consultar productos', exact: true })
  const catalogManage = permissions.getByRole('checkbox', { name: 'Crear y editar productos', exact: true })
  const collectSales = permissions.getByRole('checkbox', { name: 'Cobrar ventas', exact: true })
  await collectSales.focus()
  await page.keyboard.press('Space')
  await expect(collectSales).toBeChecked()
  await expect(catalogRead).toBeChecked()
  await catalogRead.focus()
  await page.keyboard.press('Space')
  await expect(catalogRead).not.toBeChecked()
  await expect(collectSales).not.toBeChecked()
  await page.keyboard.press('Tab')
  await expect(catalogManage).toBeFocused()
  await page.keyboard.press('Space')
  await expect(catalogManage).toBeChecked()
  await expect(catalogRead).toBeChecked()
  await permissions.getByRole('checkbox', { name: 'Actualizar preparación', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(permissions.getByRole('checkbox', { name: 'Consultar comandas', exact: true })).toBeChecked()
  await expect(permissions.getByRole('checkbox', { checked: true })).toHaveCount(4)
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Ana de prueba')
  await page.screenshot({ path: `/tmp/pos-employee-${info.project.name}-form.png`, fullPage: true })
  for (const y of [0, 350, 700]) {
    await page.evaluate((top) => window.scrollTo(0, top), y)
    await page.screenshot({ path: `/tmp/pos-employee-${info.project.name}-form-${y}.png` })
  }
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    for (const label of await page.locator('.employee-permission-fields label').all()) {
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(48)
    }
  }
})

test('creation leads to sharing one invitation and copy failure leaves a selectable link', async ({ page }, info) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true })
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Clipboard denied')) } }))
  await openCreation(page)
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Ana de prueba')
  await page.getByRole('checkbox', { name: 'Actualizar preparación', exact: true }).check()
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
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Ana de prueba', role: 'cashier', permissions: ['kitchen.read', 'kitchen.operate'], inviteWithGoogle: true, pin: null })
  await page.getByRole('button', { name: 'Listo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Administrar Ana de prueba', exact: true })).toHaveCount(1)
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(fixtureInvitation)
})

test('the invitation QR decodes to the same link and disappears once cancelled', async ({ page }, info) => {
  await mockOnboarding(page, { existingBusiness: true })
  await openCreation(page)
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Ana de prueba')
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  const qr = page.getByRole('img', { name: 'QR de la invitación' })
  await expect(qr).toBeVisible()
  const decoded = await readQr(page, 'QR de la invitación')
  expect(decoded).toBe(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`)
  await expect(page.getByLabel('Enlace de invitación')).toHaveValue(decoded!)
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 320, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.screenshot({ path: `/tmp/pos-employee-${info.project.name}-invitation-qr.png`, fullPage: true })
  await page.getByRole('button', { name: 'Administrar empleado', exact: true }).click()
  await page.getByRole('button', { name: 'Cancelar invitación', exact: true }).click()
  await expect(qr).toHaveCount(0)
  await expect(page.getByLabel('Enlace de invitación')).toHaveCount(0)
  await expect(page.getByText('Invitación cancelada', { exact: true })).toBeVisible()
})

test('native sharing uses the invitation link and cancelling keeps the invitation usable', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  await page.addInitScript(() => {
    let attempts = 0
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      attempts += 1
      if (attempts === 1) throw new DOMException('Cancelled', 'AbortError')
      ;(window as typeof window & { sharedInvitation?: ShareData }).sharedInvitation = data
    } })
  })
  await openCreation(page)
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Ana de prueba')
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  await page.getByRole('button', { name: 'Compartir enlace', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'QR de la invitación' })).toBeVisible()
  await page.getByRole('button', { name: 'Compartir enlace', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Enlace compartido.')
  expect(await page.evaluate(() => (window as typeof window & { sharedInvitation?: ShareData }).sharedInvitation?.url)).toBe(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`)
})

test('shared-register QR opens pairing and stops being shown when it expires', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  await page.clock.install()
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action !== 'create_pairing_code') return route.fallback()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { pairingCode: fixturePairingCode, expiresAt: new Date(Date.now() + 60_000).toISOString() } }) })
  })
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page);
  await openOwnerTask(page, 'Dispositivos de caja')
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await expect(page.getByRole('img', { name: 'QR para vincular la caja' })).toBeVisible()
  expect(await readQr(page, 'QR para vincular la caja')).toBe(`http://127.0.0.1:5174/register#pair=${fixturePairingCode}`)
  await page.clock.fastForward(61_000)
  await expect(page.getByRole('img', { name: 'QR para vincular la caja' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Copiar enlace', exact: true })).toHaveCount(0)
})
