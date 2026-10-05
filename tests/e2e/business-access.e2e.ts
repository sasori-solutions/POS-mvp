import { submitPinIfPresent } from './workspace-flow'
import { openOperationalMore, openOperationalTask } from './workspace-flow'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QRCodeSVG } from 'qrcode.react'
import { expect, test } from '@playwright/test'
import { fixtureBusiness, fixturePin, fixtureAuthKey, fixtureAuthSession } from './account-fixture'
import { fixtureInvitation } from './onboarding-fixture'
import { mockOnboarding } from './onboarding-fixture'

const employment = { ...fixtureBusiness, id: 'bb1cd724-51c4-4f5c-931f-aa8729ecf73d', name: 'Café del equipo', role: 'cashier' }

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
})

test('employee entry chooses employment even when the same identity owns a business', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true, role: 'cashier' })
  await page.route('**/functions/v1/account', async route => {
    const body = route.request().postDataJSON()
    if (body.action === 'status') return route.fulfill({ json: { data: { businesses: [fixtureBusiness, employment] } } })
    if (body.action === 'unlock') return route.fulfill({ json: { data: {
      business: { ...employment, employee: { id: '84c75082-4633-4f53-8f34-a2ed0c7b2e66', name: 'Persona de prueba', role: 'cashier' } },
      operatorToken: 'a7'.repeat(32), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } } })
    return route.fallback()
  })
  await page.goto('/employee')
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
  await expect(page.getByText(employment.name, { exact: true }).filter({visible:true}).first()).toBeVisible()
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page);
  await openOperationalMore(page);
  await page.getByRole('button', { name: 'Cambiar negocio', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Mis negocios', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Como empleado', exact: true })).toBeVisible()
  await expect(page.getByRole('region',{name:'Como empleado'}).getByRole('button', { name: 'Café del equipo',exact:true })).toBeVisible()
})

test('joining exposes a working camera option without opening it automatically', async ({ page }) => {
  await mockOnboarding(page)
  await page.goto('/join')
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancelar escaneo', exact: true })).toBeVisible()
})

test('an employee sees newly created products automatically and can refresh immediately', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true, role: 'cashier' })
  let products: Record<string, unknown>[] = []
  await page.route('**/functions/v1/account', async route => {
    if (route.request().postDataJSON().action !== 'pos' || route.request().postDataJSON().command !== 'catalog') return route.fallback()
    return route.fulfill({ json: { data: { products, paymentMethods: ['cash'] } } })
  })
  await page.clock.install()
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Aún no hay productos', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Buscar producto', exact: true })).toBeVisible()
  products = [{ id: '51921edf-8e9e-4a26-b661-31dc5c231c0f', name: 'Café nuevo del dueño', category: 'Bebidas', priceCents: 4000, active: true, version: 1 }]
  await page.clock.fastForward(15_000)
  await expect(page.getByRole('button', { name: /^Agregar Café nuevo del dueño,/ })).toBeVisible()
  await openOperationalTask(page, 'Productos')
  products[0] = { ...products[0], name: 'Café actualizado por el dueño', version: 2 }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('list', { name: 'Catálogo de productos' }).getByText('Café actualizado por el dueño', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agregar producto', exact: true })).toHaveCount(0)
})

test('Google return and logout/relogin retain employee access for an account with its own business', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true, authenticated: false })
  await page.route('**/functions/v1/account', async route => {
    const body = route.request().postDataJSON()
    if (body.action === 'status') return route.fulfill({ json: { data: { businesses: [fixtureBusiness, employment] } } })
    if (body.action === 'unlock') return route.fulfill({ json: { data: {
      business: { ...employment, employee: { id: '84c75082-4633-4f53-8f34-a2ed0c7b2e66', name: 'Persona de prueba', role: 'cashier' } },
      operatorToken: 'a7'.repeat(32), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } } })
    return route.fallback()
  })
  await page.route('**/auth/v1/authorize**', route => route.fulfill({ contentType: 'text/plain', body: 'OAuth captured' }))
  let generation = 0
  await page.route('**/auth/v1/token?grant_type=pkce', route => route.fulfill({ json: fixtureAuthSession({},
    generation++ ? 'f4b9298b-02d7-46bb-8ed3-0221ac6468c0' : '4653a47d-0b0c-46b6-afc6-de40245d04ab') }))
  await page.goto('/employee')
  for (let round = 0; round < 2; round++) {
    const authorize = page.waitForRequest(request => request.url().includes('/auth/v1/authorize'))
    await page.getByRole('button', { name: 'Continuar con Google', exact: true }).click()
    await authorize
    await page.goto('/auth/callback?code=fixture-code')
    await expect(page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
    await expect(page.getByText(employment.name, { exact: true }).filter({visible:true}).first()).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0)
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page);
    const sessionActions = await openOperationalMore(page);
    await expect(page.getByRole('button', { name: 'Datos del negocio', exact: true })).toHaveCount(0)
    await sessionActions.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeEnabled()
    expect(await page.evaluate(key => localStorage.getItem(key), fixtureAuthKey)).toBeNull()
  }
})

test('employee entry with only an owned business offers a choice instead of silently entering it', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true })
  await page.goto('/employee')
  await expect(page.getByRole('heading', { name: 'Tus negocios', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mis negocios', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Unirme a un negocio', exact: true })).toBeVisible()
})

const invitationQr = `data:image/svg+xml;base64,${Buffer.from(renderToStaticMarkup(createElement(QRCodeSVG, {
  value: `http://127.0.0.1:5174/#invite=${fixtureInvitation}`, size: 512, marginSize: 4,
})).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')).toString('base64')}`

test('camera decodes a real invitation QR locally and releases the stream', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  await page.addInitScript(source => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const image = new Image(); image.src = source; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
      canvas.getContext('2d')!.drawImage(image, 0, 0)
      const stream = canvas.captureStream(10)
      const frames = setInterval(() => canvas.getContext('2d')!.drawImage(image, 0, 0), 100)
      stream.getTracks()[0].addEventListener('ended', () => clearInterval(frames))
      Object.defineProperty(window, 'testCamera', { configurable: true, value: stream })
      return stream
    } })
  }, invitationQr)
  await page.goto('/employee')
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Acepta tu invitación', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as typeof window & { testCamera: MediaStream }).testCamera.getTracks().every(track => track.readyState === 'ended'))).toBe(true)
  expect(await page.evaluate(() => sessionStorage.getItem('pos-mexico-pending-invitation'))).toBe(fixtureInvitation)
})

test('denied camera access keeps link entry usable and cancellation restores focus', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    value: async () => { throw new DOMException('Denied', 'NotAllowedError') },
  }))
  await page.goto('/employee')
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Permite el acceso a la cámara')
  await page.getByRole('button', { name: 'Cancelar escaneo', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeFocused()
  await page.getByLabel('Enlace de invitación').fill(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`)
  await page.getByRole('button', { name: 'Abrir invitación', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Acepta tu invitación', exact: true })).toBeVisible()
})

test('cancelling before camera permission completes stops the late stream', async ({ page }) => {
  await mockOnboarding(page, { authenticated: false })
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: () => new Promise<MediaStream>(resolve => {
      Object.defineProperty(window, 'grantTestCamera', { value: () => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
        const stream = canvas.captureStream()
        Object.defineProperty(window, 'testCamera', { value: stream })
        resolve(stream)
      } })
    }) })
  })
  await page.goto('/employee')
  expect(await page.evaluate(() => 'grantTestCamera' in window)).toBe(false)
  await page.getByRole('button', { name: 'Escanear QR', exact: true }).click()
  await expect.poll(() => page.evaluate(() => 'grantTestCamera' in window)).toBe(true)
  await page.getByRole('button', { name: 'Cancelar escaneo', exact: true }).click()
  await page.evaluate(() => (window as typeof window & { grantTestCamera: () => void }).grantTestCamera())
  await expect.poll(() => page.evaluate(() => (window as typeof window & { testCamera: MediaStream }).testCamera.getTracks().every(track => track.readyState === 'ended'))).toBe(true)
  await expect(page.getByRole('button', { name: 'Escanear QR', exact: true })).toBeFocused()
  await expect(page.getByRole('region', { name: 'Escanear invitación' })).toHaveCount(0)
})
