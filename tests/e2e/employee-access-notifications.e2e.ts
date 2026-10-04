import { submitPinIfPresent } from './workspace-flow'
import { expect, test } from '@playwright/test'
import { fixtureBusiness, fixturePin } from './account-fixture'
import { fixtureInvitation, mockOnboarding } from './onboarding-fixture'
import type { OwnerNotification } from '../../src/lib/contracts'

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
})

test('employee entry accepts the owner link and never asks for a register code', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  await page.goto('/login')
  await page.getByRole('button', { name: 'Entrar como empleado', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Acceso de empleado', exact: true })).toBeVisible()
  await expect(page.getByText('Código de conexión', { exact: true })).toHaveCount(0)
  await page.getByLabel('Enlace de invitación').fill(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`)
  await page.getByRole('button', { name: 'Abrir invitación', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Acepta tu invitación', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
  expect(await page.evaluate(() => sessionStorage.getItem('pos-mexico-pending-invitation'))).toBe(fixtureInvitation)
})

test('employee entry rejects invitation links from another origin', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  await page.goto('/employee')
  await page.getByLabel('Enlace de invitación').fill(`https://example.com/#invite=${fixtureInvitation}`)
  await page.getByRole('button', { name: 'Abrir invitación', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Pega el enlace de invitación de POS México')
  expect(await page.evaluate(() => sessionStorage.getItem('pos-mexico-pending-invitation'))).toBeNull()
})

test('blocked employee stays outside the business and can retry after owner approval', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true, role: 'cashier' })
  let approved = false
  const requests: Record<string, unknown>[] = []
  await page.route('**/functions/v1/account', async route => {
    const body = route.request().postDataJSON()
    if (body.action !== 'unlock') return route.fallback()
    requests.push(body)
    if (approved) return route.fallback()
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'DEVICE_APPROVAL_REQUIRED', message: 'Owner approval required.' } }) })
  })
  await page.goto('/')
  await page.getByLabel('Nombre de este dispositivo').fill('Teléfono nuevo')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page);
  await expect(page.getByRole('alert')).toContainText('Este dispositivo no está autorizado')
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0)
  await expect(page.getByTestId('pin-input')).toHaveValue('')
  expect(requests[0]).toHaveProperty('deviceProof.signature')
  expect(requests[0]).toHaveProperty('deviceName', 'Teléfono nuevo')
  approved = true
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Notificaciones/ })).toHaveCount(0)
})

for (const decision of ['approve', 'reject'] as const) {
  test(`owner ${decision}s a device request, persists read state and sees the unread badge`, async ({ page }, info) => {
    await mockOnboarding(page, { existingBusiness: true })
    const notices: OwnerNotification[] = [{ id: '54bd1b7e-ab26-4dca-a4ee-63988c136c78', type: 'employee_device_requested', employeeId: '0797aa93-8117-491d-b153-db8001d92224', employeeName: 'Empleado de prueba', deviceName: 'Teléfono nuevo', createdAt: new Date().toISOString(), readAt: null, status: 'pending' }]
    const calls: Record<string, unknown>[] = []
    await page.route('**/functions/v1/account', async route => {
      const body = route.request().postDataJSON()
      if (!['notifications', 'mark_notification_read', 'review_employee_device'].includes(body.action)) return route.fallback()
      calls.push(body)
      let data: unknown
      if (body.action === 'notifications') data = { notifications: notices, unreadCount: notices.filter(item => !item.readAt).length }
      else if (body.action === 'mark_notification_read') { notices[0].readAt = new Date().toISOString(); data = { read: true } }
      else { notices[0].readAt = new Date().toISOString(); notices[0].status = body.decision === 'approve' ? 'approved' : 'rejected'; data = { reviewed: true } }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) })
    })
    await page.goto('/')
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page);
    await page.getByRole('button', { name: 'Notificaciones, 1 sin leer', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Solicitud de otro dispositivo' })).toBeVisible()
    await expect(page.getByText('Sin leer', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Marcar como leída', exact: true }).click()
    await expect(page.getByText('Sin leer', { exact: true })).toHaveCount(0)
    if (decision === 'approve') {
      await page.getByRole('button', { name: 'Autorizar cambio', exact: true }).click()
      await expect(page.getByText(/se cerrarán las sesiones anteriores/)).toBeVisible()
      expect(calls.filter(call => call.action === 'review_employee_device')).toHaveLength(0)
      await page.getByRole('button', { name: 'Reemplazar dispositivo', exact: true }).click()
    } else await page.getByRole('button', { name: 'Rechazar', exact: true }).click()
    await expect(page.getByRole('status')).toContainText(decision === 'approve' ? 'Cambio autorizado' : 'Solicitud rechazada')
    expect(calls.find(call => call.action === 'review_employee_device')).toMatchObject({ businessId: fixtureBusiness.id, decision, notificationId: notices[0].id })
    await expect(page.getByRole('button', { name: 'Autorizar cambio', exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (info.project.name === 'mobile') {
      expect((await page.getByRole('heading', { name: 'Notificaciones', exact: true }).boundingBox())!.x).toBeGreaterThanOrEqual(24)
      expect((await page.locator('.notification-card').boundingBox())!.x).toBeGreaterThanOrEqual(24)
    }
    await page.screenshot({ path: `/tmp/pos-notifications-${decision}-${info.project.name}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Volver a Más', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Notificaciones', exact: true })).toBeVisible()
  })
}

test('a delayed inbox refresh cannot restore a pending device request after approval', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  const notice: OwnerNotification = { id: '54bd1b7e-ab26-4dca-a4ee-63988c136c78', type: 'employee_device_requested', employeeId: '0797aa93-8117-491d-b153-db8001d92224', employeeName: 'Empleado de prueba', deviceName: 'Teléfono nuevo', createdAt: new Date().toISOString(), readAt: null, status: 'pending' }
  let reviewPending = false
  let releaseReview: (() => void) | undefined
  const delayedReads: (() => void)[] = []
  await page.route('**/functions/v1/account', async route => {
    const body = route.request().postDataJSON()
    if (body.action === 'review_employee_device') {
      reviewPending = true
      await new Promise<void>(resolve => { releaseReview = resolve })
      reviewPending = false
      notice.status = 'approved'
      notice.readAt = new Date().toISOString()
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { reviewed: true } }) })
    }
    if (body.action !== 'notifications') return route.fallback()
    const data = { notifications: [structuredClone(notice)], unreadCount: notice.readAt ? 0 : 1 }
    if (reviewPending) await new Promise<void>(resolve => { delayedReads.push(resolve) })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) })
  })
  try {
    await page.goto('/')
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page);
    await page.getByRole('button', { name: 'Notificaciones, 1 sin leer', exact: true }).click()
    await page.getByRole('button', { name: 'Autorizar cambio', exact: true }).click()
    await page.getByRole('button', { name: 'Reemplazar dispositivo', exact: true }).click()
    await expect.poll(() => Boolean(releaseReview)).toBe(true)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(() => delayedReads.length).toBeGreaterThan(0)
    releaseReview!()
    await expect(page.getByRole('status')).toContainText('Cambio autorizado')
    for (const release of delayedReads) release()
    await expect(page.getByText('Autorizado', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Autorizar cambio', exact: true })).toHaveCount(0)
  } finally {
    releaseReview?.()
    for (const release of delayedReads) release()
  }
})

test('device decision controls wait for an inbox refresh and work when it completes', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  const notice: OwnerNotification = { id: '54bd1b7e-ab26-4dca-a4ee-63988c136c78', type: 'employee_device_requested', employeeId: '0797aa93-8117-491d-b153-db8001d92224', employeeName: 'Empleado de prueba', deviceName: 'Teléfono nuevo', createdAt: new Date().toISOString(), readAt: null, status: 'pending' }
  let holdRefresh = false
  let releaseRefresh: (() => void) | undefined
  await page.route('**/functions/v1/account', async route => {
    const body = route.request().postDataJSON()
    if (body.action === 'review_employee_device') {
      notice.status = 'rejected'; notice.readAt = new Date().toISOString()
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { reviewed: true } }) })
    }
    if (body.action !== 'notifications') return route.fallback()
    if (holdRefresh) await new Promise<void>(resolve => { releaseRefresh = resolve })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { notifications: [notice], unreadCount: notice.readAt ? 0 : 1 } }) })
  })
  try {
    await page.goto('/')
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page);
    await page.getByRole('button', { name: 'Notificaciones, 1 sin leer', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Rechazar', exact: true })).toBeEnabled()
    holdRefresh = true
    await page.getByRole('button', { name: 'Actualizar notificaciones', exact: true }).click()
    await expect.poll(() => Boolean(releaseRefresh)).toBe(true)
    await expect(page.getByRole('button', { name: 'Autorizar cambio', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Rechazar', exact: true })).toBeDisabled()
    holdRefresh = false; releaseRefresh!()
    await page.getByRole('button', { name: 'Rechazar', exact: true }).click()
    await expect(page.getByText('Rechazado', { exact: true })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('Solicitud rechazada')
  } finally { releaseRefresh?.() }
})
