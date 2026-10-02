/** Real browser IndexedDB/WebCrypto -> account client -> Edge -> Postgres smoke.
 * Synthetic loopback Auth only; no API response mocks. Run after serving account
 * with http://127.0.0.1:5176 in ALLOWED_ORIGINS. Optional TEST_SUPABASE_* variables
 * select an isolated stack; TEST_LOCAL_DB_CONTAINER must match that stack.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import jsQR from 'jsqr'

const config = process.env.TEST_SUPABASE_URL ? {
  API_URL: process.env.TEST_SUPABASE_URL,
  ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY,
  SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY,
} : JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.API_URL).hostname), 'Loopback Supabase required')
assert(config.ANON_KEY && config.SERVICE_ROLE_KEY, 'Local credentials required')
const projectId = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
const databaseContainer = process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${projectId}`
const origin = 'http://127.0.0.1:5176'
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options)
const userIds = []
const businessIds = []
let browser, server
let stage = 'prepare'

function sql(statement) {
  return execFileSync('docker', ['exec', '-i', databaseContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function uuid(value) {
  assert.match(value, /^[a-f0-9-]{36}$/i)
  return `'${value}'::uuid`
}

async function identity() {
  const credentials = { email: `device-browser-${randomUUID()}@example.test`, password: `local-only-${randomUUID()}-Aa9!` }
  const created = await admin.auth.admin.createUser({ ...credentials, email_confirm: true })
  if (created.error) throw new Error('Synthetic Auth creation failed')
  userIds.push(created.data.user.id)
  return { credentials, token: await signIn(credentials) }
}

async function signIn(credentials) {
  const client = createClient(config.API_URL, config.ANON_KEY, options)
  const result = await client.auth.signInWithPassword(credentials)
  if (result.error) throw new Error('Synthetic local Auth login failed')
  return result.data.session.access_token
}

async function request(page, token, body) {
  return page.evaluate(async ({ token, body }) => {
    const { accountRequest } = await import('/src/lib/account.ts')
    try { return { data: await accountRequest(body, token) } }
    catch (error) { return { error: { code: error.code, message: error.message } } }
  }, { token, body })
}

function data(reply) {
  assert(reply.data, `Expected data, received ${reply.error?.code ?? 'an empty response'}`)
  return reply.data
}

async function pageWithDevice() {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const page = await context.newPage()
  const proofs = []
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().endsWith('/functions/v1/account')) return
    const body = request.postDataJSON()
    proofs.push({ action: body.action, publicKey: body.deviceProof?.publicKey, nonce: body.deviceProof?.nonce })
  })
  await page.goto(origin)
  await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeVisible()
  return { context, page, proofs }
}

function accountResponse(page, action) {
  return page.waitForResponse(response => response.url().endsWith('/functions/v1/account') && response.request().method() === 'POST'
    && response.request().postDataJSON()?.action === action).then(response => response.json())
}

async function signInApp(page, credentials) {
  await page.evaluate(async credentials => {
    const { supabase } = await import('/src/lib/supabase.ts')
    const result = await supabase.auth.signInWithPassword(credentials)
    if (result.error) throw new Error('Synthetic local App sign-in failed')
  }, credentials)
}

async function openOwnerTeam(page) {
  await page.getByLabel('Tu PIN', { exact: true }).fill('583927')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await page.getByRole('button', { name: 'Más', exact: true }).click()
  await page.getByRole('button', { name: 'Empleados', exact: true }).click()
}

async function deleteThroughApp(page, name, employeeId) {
  await page.getByRole('button', { name: `Administrar ${name}`, exact: true }).click()
  await page.getByRole('button', { name: 'Eliminar empleado', exact: true }).click()
  const response = accountResponse(page, 'delete_employee')
  await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click()
  assert.equal(data(await response).id, employeeId, 'Deletion must target the retained employee')
  await expect(page.getByRole('button', { name: `Administrar ${name}`, exact: true })).toHaveCount(0)
}

async function invitationFromQr(page, name, role) {
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
  await page.getByLabel('Nombre del empleado', { exact: true }).fill(name)
  await page.getByRole('radio', { name: role, exact: true }).check()
  const response = accountResponse(page, 'create_employee')
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  const person = data(await response)
  const pixels = await page.getByRole('img', { name: 'QR de la invitación', exact: true }).evaluate(async svg => {
    const image = new Image()
    const source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }))
    try {
      image.src = source
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = 384; canvas.height = 384
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      return { data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height }
    } finally { URL.revokeObjectURL(source) }
  })
  const link = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data
  assert(link && link === await page.getByLabel('Enlace de invitación', { exact: true }).inputValue(), 'The rendered QR must encode the displayed invitation link')
  assert(new URL(link).origin === origin, 'The invitation must stay on the isolated App origin')
  return { person, link }
}

async function assertConsumedInvitation(page) {
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pos-mexico-pending-invitation')), null, 'A consumed invitation must be removed before reload')
}

try {
  const [owner, employee] = await Promise.all([identity(), identity()])
  const secondToken = await signIn(employee.credentials)
  server = spawn('./node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5176', '--strictPort'], {
    env: { ...process.env, VITE_SUPABASE_URL: config.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: config.ANON_KEY }, stdio: 'ignore',
  })
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null) throw new Error('Dedicated Vite could not start')
    try { if ((await fetch(origin)).ok) { ready = true; break } } catch { /* Startup only. */ }
    await pause(250)
  }
  assert(ready, 'Dedicated Vite must be ready')
  browser = await chromium.launch({ headless: true })
  const ownerBrowser = await pageWithDevice()
  const first = await pageWithDevice()
  const second = await pageWithDevice()

  stage = 'create synthetic business and employee through browser client'
  const business = data(await request(ownerBrowser.page, owner.token, { action: 'create_business', name: 'Device browser smoke', businessType: 'cafe', timezone: 'America/Mexico_City', pin: '583927', operationId: randomUUID() }))
  businessIds.push(business.business.id)
  const ownerArgs = { businessId: business.business.id, operatorToken: business.operatorToken }
  const person = data(await request(ownerBrowser.page, owner.token, { action: 'create_employee', ...ownerArgs, name: 'Empleado browser smoke', role: 'cashier', pin: null, inviteWithGoogle: true, operationId: randomUUID() }))

  stage = 'browser accepts invitation with its persisted private key'
  const accepted = data(await request(first.page, employee.token, { action: 'accept_invitation', invitationCode: person.invitation.invitationCode, pin: '024680', operationId: randomUUID(), deviceName: 'Navegador inicial' }))
  assert.equal(accepted.business.employee.id, person.id)
  assert(first.proofs.find(item => item.action === 'accept_invitation')?.publicKey, 'Browser must include its actual device proof')
  const firstPublicKey = first.proofs.at(-1).publicKey
  const unlock = { action: 'unlock', businessId: business.business.id, pin: '024680', deviceName: 'Navegador inicial' }
  await first.page.reload()
  const reloaded = data(await request(first.page, employee.token, unlock))
  assert.equal(first.proofs.at(-1).publicKey, firstPublicKey, 'Reload must retain the device identity')

  stage = 'a second browser is blocked and creates an owner notification'
  const denied = await request(second.page, secondToken, { ...unlock, deviceName: 'Navegador nuevo' })
  assert.equal(denied.error?.code, 'DEVICE_APPROVAL_REQUIRED')
  assert.notEqual(second.proofs.at(-1).publicKey, firstPublicKey, 'Separate browser storage must produce a separate key')
  let inbox = data(await request(ownerBrowser.page, owner.token, { action: 'notifications', ...ownerArgs }))
  const pending = inbox.notifications.find(item => item.type === 'employee_device_requested')
  assert.equal(pending?.status, 'pending')
  assert.equal(pending?.employeeId, person.id)
  assert.equal(inbox.notifications.filter(item => item.type === 'employee_device_linked').length, 1)

  stage = 'owner approval replaces device access and revokes the previous session'
  assert.deepEqual(data(await request(ownerBrowser.page, owner.token, { action: 'review_employee_device', ...ownerArgs, notificationId: pending.id, decision: 'approve' })), { reviewed: true })
  const old = await request(first.page, employee.token, { action: 'context', businessId: business.business.id, operatorToken: reloaded.operatorToken })
  assert.equal(old.error?.code, 'SESSION_INVALID')
  const current = data(await request(second.page, secondToken, { ...unlock, deviceName: 'Navegador nuevo' }))
  const currentContext = data(await request(second.page, secondToken, { action: 'context', businessId: business.business.id, operatorToken: current.operatorToken }))
  assert.equal(currentContext.business.employee.id, person.id)
  inbox = data(await request(ownerBrowser.page, owner.token, { action: 'notifications', ...ownerArgs }))
  assert.equal(inbox.notifications.find(item => item.id === pending.id).status, 'approved')
  assert.equal(new Set(first.proofs.map(item => item.nonce)).size, first.proofs.length, 'Every browser request needs a fresh signed nonce')
  assert.equal(sql(`select count(*) from app_private.employee_personal_devices where business_id=${uuid(business.business.id)} and employee_id=${uuid(person.id)};`), '1')
  for (const testBrowser of [first, second]) {
    const stored = await testBrowser.page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    for (const secret of [employee.token, secondToken, accepted.operatorToken, reloaded.operatorToken, current.operatorToken]) assert(!stored.includes(secret), 'Browser proof storage must not retain operator/Auth tokens')
  }

  stage = 'actual App restores a deleted employee through a fresh QR on the linked browser'
  // Only now populate normal App Auth storage through the real SDK; previous proof-only storage checks remain intact.
  await signInApp(ownerBrowser.page, owner.credentials)
  await openOwnerTeam(ownerBrowser.page)
  await deleteThroughApp(ownerBrowser.page, 'Empleado browser smoke', person.id)
  const linkedInvitation = await invitationFromQr(ownerBrowser.page, 'Empleado reincorporado', 'Cocina')
  assert.notEqual(linkedInvitation.person.id, person.id, 'The owner creates a new invitation placeholder')
  await second.page.goto(linkedInvitation.link)
  await expect(second.page.getByRole('heading', { name: 'Acepta tu invitación', exact: true })).toBeVisible()
  await signInApp(second.page, employee.credentials)
  await expect(second.page.getByText('Ya tenías acceso a este negocio. Ingresa tu PIN actual para volver a entrar.')).toBeVisible()
  await expect(second.page.getByLabel('Confirma tu PIN', { exact: true })).toHaveCount(0)
  await second.page.screenshot({ path: '/tmp/pos-real-rejoin-linked-pin.png', fullPage: true })
  const sameBrowserAcceptance = accountResponse(second.page, 'accept_invitation')
  await second.page.getByLabel('PIN actual', { exact: true }).fill('024680')
  await second.page.getByRole('button', { name: 'Unirme', exact: true }).click()
  const rejoined = data(await sameBrowserAcceptance)
  assert.equal(rejoined.business.employee.id, person.id, 'Rejoining must retain the original employee identity')
  assert.equal(rejoined.business.employee.role, 'kitchen')
  await expect(second.page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible()
  await assertConsumedInvitation(second.page)
  assert.equal(sql(`select count(*) from app_private.employees where business_id=${uuid(business.business.id)} and user_id is not null and role<>'owner';`), '1')
  assert.equal(sql(`select merged_into_employee_id=${uuid(person.id)} from app_private.employees where id=${uuid(linkedInvitation.person.id)};`), 't')

  stage = 'actual App consumes a new QR on another browser and keeps the pending approval recoverable'
  await ownerBrowser.page.reload()
  await openOwnerTeam(ownerBrowser.page)
  await deleteThroughApp(ownerBrowser.page, 'Empleado reincorporado', person.id)
  const movedInvitation = await invitationFromQr(ownerBrowser.page, 'Empleado en otro equipo', 'Cocina')
  const third = await pageWithDevice()
  await third.page.setViewportSize({ width: 390, height: 844 })
  await third.page.goto(movedInvitation.link)
  await expect(third.page.getByRole('heading', { name: 'Acepta tu invitación', exact: true })).toBeVisible()
  await signInApp(third.page, employee.credentials)
  await expect(third.page.getByLabel('PIN actual', { exact: true })).toBeVisible()
  const movedAcceptance = accountResponse(third.page, 'accept_invitation')
  await third.page.getByLabel('Nombre de este dispositivo', { exact: true }).fill('Equipo nuevo de prueba')
  await third.page.getByLabel('PIN actual', { exact: true }).fill('024680')
  await third.page.getByRole('button', { name: 'Unirme', exact: true }).click()
  assert.equal((await movedAcceptance).error?.code, 'DEVICE_APPROVAL_REQUIRED')
  await expect(third.page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
  await expect(third.page.getByRole('alert')).toContainText('Este dispositivo no está autorizado.')
  await assertConsumedInvitation(third.page)
  assert.equal(sql(`select employee_id=${uuid(person.id)} and accepted_employee_id=${uuid(person.id)} and accepted_at is not null from app_private.business_invitations where id=${uuid(movedInvitation.person.invitation.invitationId)};`), 't')
  await third.page.screenshot({ path: '/tmp/pos-real-rejoin-pending-approval.png', fullPage: true })
  await third.page.reload()
  await expect(third.page.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
  await expect(third.page.getByRole('heading', { name: 'Unirme a un negocio', exact: true })).toHaveCount(0)

  stage = 'owner approves the returning employee in the real App notification inbox'
  await ownerBrowser.page.reload()
  await ownerBrowser.page.getByLabel('Tu PIN', { exact: true }).fill('583927')
  await ownerBrowser.page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await ownerBrowser.page.getByRole('button', { name: /Notificaciones/ }).click()
  const notice = ownerBrowser.page.getByRole('listitem').filter({ hasText: 'Equipo nuevo de prueba' })
  await expect(notice).toContainText('Empleado en otro equipo')
  const review = accountResponse(ownerBrowser.page, 'review_employee_device')
  await notice.getByRole('button', { name: 'Autorizar cambio', exact: true }).click()
  await notice.getByRole('button', { name: 'Reemplazar dispositivo', exact: true }).click()
  assert.deepEqual(data(await review), { reviewed: true })
  await expect(notice).toContainText('Autorizado')
  const finalUnlock = accountResponse(third.page, 'unlock')
  await third.page.getByLabel('Tu PIN', { exact: true }).fill('024680')
  await third.page.getByRole('button', { name: 'Entrar', exact: true }).click()
  const finalSession = data(await finalUnlock)
  assert.equal(finalSession.business.employee.id, person.id, 'Device approval must keep the original employee identity')
  await expect(third.page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible()
  await third.page.screenshot({ path: '/tmp/pos-real-rejoin-approved-home.png', fullPage: true })
  await assertConsumedInvitation(third.page)
  console.log('PASS: real browser signing and device enforcement; actual App deletion, fresh QR decoding, same-browser rejoining, different-browser rejoining, pending-approval reload, owner inbox approval and PIN entry retain the original employee identity.')
} catch (error) {
  console.error(`FAIL at ${stage}: ${error.message.replace(/[a-f0-9]{64}/gi, '[redacted]')}`)
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      console.error(JSON.stringify({ headings: await page.getByRole('heading').allTextContents(), alerts: await page.getByRole('alert').allTextContents() }))
    }
  }
  process.exitCode = 1
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
  for (const userId of userIds) {
    const removed = await admin.auth.admin.deleteUser(userId)
    if (removed.error) { console.error('Synthetic Auth cleanup failed'); process.exitCode = 1 }
  }
  if (businessIds.length) {
    sql(`delete from app_private.businesses where id in (${businessIds.map(uuid).join(',')});`)
    assert.equal(sql(`select count(*) from app_private.businesses where id in (${businessIds.map(uuid).join(',')});`), '0')
  }
  console.log('Cleanup: synthetic accounts/businesses removed; browser and dedicated Vite stopped.')
}
