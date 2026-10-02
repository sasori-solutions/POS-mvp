import { expect, test } from '@playwright/test'
import { fixtureAuthKey, fixtureAuthSession, fixtureBusiness, fixtureOperatorToken, fixturePin } from './account-fixture'
import { fixtureInvitation, fixtureKitchen, mockOnboarding } from './onboarding-fixture'

const accountEndpoint = 'http://127.0.0.1:54321/functions/v1/account'
const invitationKey = 'pos-mexico-pending-invitation'
const conflictMessage = 'Esta cuenta de Google ya está vinculada a otra persona de este negocio. Entra con otra cuenta o pide al dueño revisar tu acceso.'

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
})

for (const action of ['invitation_details', 'accept_invitation']) {
  test(`an account conflict during ${action} preserves the invitation and offers changing Google accounts`, async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 640 })
    const { calls } = await mockOnboarding(page, { existingBusiness: true })
    let rejected = 0
    await page.route(accountEndpoint, (route) => {
      if (route.request().postDataJSON()?.action !== action) return route.fallback()
      rejected += 1
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BUSINESS_ACCESS_DENIED' } }) })
    })
    await page.goto(`/#invite=${fixtureInvitation}`)
    if (action === 'accept_invitation') {
      await page.getByLabel('PIN', { exact: true }).fill(fixturePin)
      await page.getByLabel('Confirma tu PIN', { exact: true }).fill(fixturePin)
      await page.getByRole('button', { name: 'Unirme', exact: true }).click()
    }
    await expect(page.getByRole('alert')).toHaveText(conflictMessage)
    await expect(page.getByRole('heading', { name: 'Unirme a un negocio', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Usar otra cuenta de Google', exact: true })).toBeEnabled()
    await expect(page.getByRole('heading', { name: 'Tus negocios', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('PIN', { exact: true })).toHaveCount(0)
    expect(await page.evaluate((key) => sessionStorage.getItem(key), invitationKey)).toBe(fixtureInvitation)
    expect(rejected).toBe(1)
    expect(calls.filter((call) => call.action === 'accept_invitation')).toHaveLength(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (action === 'invitation_details') await page.screenshot({ path: `/tmp/pos-invitation-conflict-${info.project.name}.png`, fullPage: true })
  })
}

test('changing Google accounts after a conflict retries the preserved invitation with the new identity', async ({ page }) => {
  const { calls, authorizations } = await mockOnboarding(page, { existingBusiness: true })
  const nextSession = fixtureAuthSession({}, 'f4b9298b-02d7-46bb-8ed3-0221ac6468c0')
  nextSession.user = { ...nextSession.user, id: 'bf4bff11-c539-4cf8-9d1a-8d7b48e4c715', email: 'invited-person@example.test' }
  const [header, encodedPayload, signature] = nextSession.access_token.split('.')
  const payload = { ...JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()), sub: nextSession.user.id, email: nextSession.user.email }
  nextSession.access_token = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`
  const nextAuthorization = `Bearer ${nextSession.access_token}`
  const detailAuthorizations: (string | undefined)[] = []
  await page.route(accountEndpoint, (route) => {
    const action = route.request().postDataJSON()?.action
    const authorization = route.request().headers().authorization
    if (action === 'status') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { businesses: authorization === nextAuthorization ? [] : [fixtureBusiness] } }) })
    if (action === 'invitation_details') {
      detailAuthorizations.push(authorization)
      if (authorization !== nextAuthorization) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BUSINESS_ACCESS_DENIED' } }) })
    }
    return route.fallback()
  })
  await page.route('http://127.0.0.1:54321/auth/v1/authorize**', (route) => route.fulfill({ contentType: 'text/plain', body: 'OAuth captured' }))
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(nextSession) }))
  await page.goto(`/#invite=${fixtureInvitation}`)
  await expect(page.getByRole('alert')).toHaveText(conflictMessage)
  await page.getByRole('button', { name: 'Usar otra cuenta de Google', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Acepta tu invitación', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeEnabled()
  expect(await page.evaluate(({ authKey, pendingKey }) => ({ identity: localStorage.getItem(authKey), invitation: sessionStorage.getItem(pendingKey) }), { authKey: fixtureAuthKey, pendingKey: invitationKey })).toEqual({ identity: null, invitation: fixtureInvitation })
  const authorizationRequest = page.waitForRequest((request) => request.url().includes('/auth/v1/authorize'))
  await page.getByRole('button', { name: 'Continuar con Google', exact: true }).click()
  expect(new URL((await authorizationRequest).url()).searchParams.get('prompt')).toBe('select_account')
  await page.goto('/auth/callback?code=new-account-fixture-code')
  await expect(page.getByLabel('PIN', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByLabel('PIN', { exact: true }).fill(fixturePin)
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill(fixturePin)
  await page.getByRole('button', { name: 'Unirme', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible()
  expect(detailAuthorizations).toHaveLength(2)
  expect(detailAuthorizations[0]).not.toBe(nextAuthorization)
  expect(detailAuthorizations[1]).toBe(nextAuthorization)
  expect(calls.filter((call) => call.action === 'accept_invitation')).toHaveLength(1)
  expect(authorizations.find((call) => call.action === 'accept_invitation')?.authorization).toBe(nextAuthorization)
  expect(await page.evaluate((key) => sessionStorage.getItem(key), invitationKey)).toBeNull()
})

for (const scenario of ['fresh-invitation', 'accepted-replay-status-unavailable']) {
  test(scenario === 'fresh-invitation' ? 'a new invitation starts fresh access and a new PIN' : 'an accepted invitation retry stays recoverable when its device needs approval and status refresh fails', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 640 })
    await mockOnboarding(page, { authenticated: false })
    const needsApproval = scenario === 'accepted-replay-status-unavailable'
    let statusUnavailable = needsApproval
    const newPin = '731864'
    const newEmployeeId = 'a7359eb0-1e44-4fcb-9f99-abf51a109bc9'
    let failedStatusRequests = 0
    let accepted = false
    let approved = false
    let acceptanceCount = 0
    const operationIds: string[] = []
    const employeeBusiness = { ...fixtureBusiness, role: 'kitchen', employee: { id: newEmployeeId, name: 'Persona reinvitada', role: 'kitchen' } }
    const businessSummary = { id: fixtureBusiness.id, name: fixtureBusiness.name, businessType: fixtureBusiness.businessType, canRecoverPin: true, recoveryReady: true }
    await page.route(accountEndpoint, (route) => {
      const body = route.request().postDataJSON()
      const reply = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) })
      const requireApproval = () => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'DEVICE_APPROVAL_REQUIRED' } }) })
      if (body.action === 'status') {
        if (accepted && statusUnavailable) { failedStatusRequests += 1; return route.abort('failed') }
        return reply({ businesses: accepted ? [businessSummary] : [] })
      }
      if (body.action === 'invitation_details') return reply({ business: businessSummary, employee: { ...fixtureKitchen, id: newEmployeeId, name: 'Persona reinvitada', pinReady: false }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      if (body.action === 'accept_invitation') {
        expect(body).toMatchObject({ invitationCode: fixtureInvitation, pin: newPin })
        acceptanceCount += 1
        operationIds.push(body.operationId)
        accepted = true
        // The initial acceptance committed but its response was lost; a later retry can need device approval.
        if (needsApproval && acceptanceCount === 1) return route.abort('failed')
        if (needsApproval) return requireApproval()
        return reply({ business: employeeBusiness, operatorToken: fixtureOperatorToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      }
      if (body.action === 'unlock' && accepted) {
        if (needsApproval && !approved) return requireApproval()
        if (body.pin !== newPin) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'PIN_INVALID' } }) })
        return reply({ business: employeeBusiness, operatorToken: fixtureOperatorToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      }
      return route.fallback()
    })
    await page.route('http://127.0.0.1:54321/auth/v1/authorize**', (route) => route.fulfill({ contentType: 'text/plain', body: 'OAuth captured' }))
    await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtureAuthSession()) }))
    await page.goto(`/#invite=${fixtureInvitation}`)
    const authorization = page.waitForRequest((request) => request.url().includes('/auth/v1/authorize'))
    await page.getByRole('button', { name: 'Continuar con Google', exact: true }).click()
    await authorization
    await page.goto('/auth/callback?code=fresh-employee-fixture-code')
    await expect(page.getByText('Elige tu PIN personal de seis dígitos.')).toBeVisible()
    await expect(page.getByLabel('PIN actual', { exact: true })).toHaveCount(0)
    await expect(page.getByLabel('Confirma tu PIN', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (!needsApproval) await page.screenshot({ path: `/tmp/pos-invitation-fresh-${info.project.name}.png`, fullPage: true })
    await page.getByLabel('PIN', { exact: true }).fill(newPin)
    await page.getByLabel('Confirma tu PIN', { exact: true }).fill(newPin)
    await page.getByRole('button', { name: 'Unirme', exact: true }).click()
    if (needsApproval) {
      await expect(page.getByRole('alert')).toContainText('No pudimos conectar.')
      expect(await page.evaluate((key) => sessionStorage.getItem(key), invitationKey)).toBe(fixtureInvitation)
      await page.getByRole('button', { name: 'Unirme', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
      await expect(page.getByRole('alert')).toContainText('Este dispositivo no está autorizado.')
      expect(await page.evaluate((key) => sessionStorage.getItem(key), invitationKey)).toBeNull()
      if (statusUnavailable) {
        await expect.poll(() => failedStatusRequests).toBe(1)
        await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeEnabled()
        statusUnavailable = false
      }
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Unirme a un negocio', exact: true })).toHaveCount(0)
      approved = true
      await page.getByLabel('Tu PIN', { exact: true }).fill(newPin)
      await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    }
    await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible()
    expect(acceptanceCount).toBe(needsApproval ? 2 : 1)
    expect(new Set(operationIds).size).toBe(1)
    expect(await page.evaluate((key) => sessionStorage.getItem(key), invitationKey)).toBeNull()
    if (!needsApproval) {
      await page.reload()
      await page.getByLabel('Tu PIN', { exact: true }).fill(fixturePin)
      await page.getByRole('button', { name: 'Entrar', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('PIN incorrecto.')
      await page.getByLabel('Tu PIN', { exact: true }).fill(newPin)
      await page.getByRole('button', { name: 'Entrar', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible()
    }
  })
}

test('a missing device proof keeps the invitation for a safe retry', async ({ page }) => {
  await mockOnboarding(page)
  await page.route(accountEndpoint, (route) => route.request().postDataJSON()?.action === 'accept_invitation'
    ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'DEVICE_LINK_REQUIRED' } }) })
    : route.fallback())
  await page.goto(`/#invite=${fixtureInvitation}`)
  await page.getByLabel('PIN', { exact: true }).fill(fixturePin)
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill(fixturePin)
  await page.getByRole('button', { name: 'Unirme', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('No pudimos vincular este navegador.')
  await expect(page.getByRole('heading', { name: 'Unirme a un negocio', exact: true })).toBeVisible()
  expect(await page.evaluate((key) => sessionStorage.getItem(key), invitationKey)).toBe(fixtureInvitation)
})
