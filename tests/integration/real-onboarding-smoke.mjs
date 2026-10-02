/** Real loopback browser -> account function -> Postgres smoke. No network response mocks.
 * Run with local Supabase/account already serving; ALLOWED_ORIGINS must include 127.0.0.1:5175.
 * TEST_SUPABASE_* and TEST_LOCAL_DB_CONTAINER can select an isolated loopback stack.
 * TEST_MAILPIT_URL optionally selects its loopback mailbox.
 * Synthetic password authentication is injected only in this test, never in application UI.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

const config = process.env.TEST_SUPABASE_URL ? { API_URL: process.env.TEST_SUPABASE_URL, ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY, SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY } : JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.API_URL).hostname), 'Loopback Supabase required')
assert(config.ANON_KEY && config.SERVICE_ROLE_KEY, 'Local credentials required')
const projectId = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
const databaseContainer = process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${projectId}`
const mailbox = new URL(process.env.TEST_MAILPIT_URL ?? config.MAILPIT_URL ?? config.API_URL)
if (!process.env.TEST_MAILPIT_URL && !config.MAILPIT_URL) mailbox.port = String(Number(new URL(config.API_URL).port) + 3)
assert(['localhost', '127.0.0.1', '[::1]'].includes(mailbox.hostname), 'Loopback Mailpit required')
const origin = 'http://127.0.0.1:5175'
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const credentials = { email: `smoke-${randomUUID()}@example.test`, password: `local-only-${randomUUID()}-Aa9!` }
let userId, employeeUserId, invitedUserId, businessId, browser, server
let stage = 'prepare'
const rawKeys = new Map()
async function rawAccount(request, accessToken) {
  let body = request
  if (accessToken) {
    if (!rawKeys.has(accessToken)) rawKeys.set(accessToken, await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']))
    const keys = rawKeys.get(accessToken), nonce = randomUUID(), issuedAt = Date.now()
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(JSON.stringify({ request, nonce, issuedAt })))
    body = { ...request, deviceProof: { publicKey: Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64url'), nonce, issuedAt, signature: Buffer.from(signature).toString('base64url') } }
  }
  return fetch(`${config.API_URL}/functions/v1/account`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, apikey: config.ANON_KEY, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body) })
}
const accountResponse = (page, action) => page.waitForResponse(response => response.url().endsWith('/functions/v1/account') && JSON.parse(response.request().postData() ?? '{}').action === action)
function staffSnapshot() {
  assert.match(businessId, /^[a-f0-9-]{36}$/i)
  return JSON.parse(execFileSync('docker', ['exec', '-i', databaseContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tA', '-c',
    `select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'userId',e.user_id,'sharedPin',exists(select 1 from app_private.shared_employee_credentials c where c.business_id=e.business_id and c.employee_id=e.id)) order by e.name),'[]'::jsonb) from app_private.employees e where e.business_id='${businessId}'::uuid and e.role<>'owner';`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())
}
try {
  const created = await admin.auth.admin.createUser({ ...credentials, email_confirm: true })
  if (created.error) throw new Error('Synthetic user creation failed')
  userId = created.data.user.id
  const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const signed = await client.auth.signInWithPassword(credentials)
  if (signed.error) throw new Error('Synthetic local sign-in failed')
  server = spawn('./node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5175', '--strictPort'], {
    env: { ...process.env, VITE_SUPABASE_URL: config.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: config.ANON_KEY }, stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null) throw new Error('Dedicated Vite could not start')
    try { if ((await fetch(origin)).ok) break } catch { /* Wait for dedicated server startup. */ }
    await pause(250)
  }
  browser = await chromium.launch({ headless: true })
  const ownerContext = await browser.newContext({ serviceWorkers: 'block' })
  const deviceContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 393, height: 851 } })
  for (const context of [ownerContext, deviceContext]) await context.route('**/*', route => {
    const hostname = new URL(route.request().url()).hostname
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ? route.continue() : route.abort()
  })
  await ownerContext.addInitScript(session => localStorage.setItem('pos-mexico-auth', JSON.stringify(session)), signed.data.session)
  const ownerPage = await ownerContext.newPage()
  const devicePage = await deviceContext.newPage()
  stage = 'create business'
  await ownerPage.goto(origin)
  await ownerPage.getByRole('button', { name: 'Crear mi negocio' }).click()
  await ownerPage.getByLabel('Nombre del negocio').fill('Café smoke sintético')
  await ownerPage.getByLabel('Sucursal', { exact: true }).fill('Principal smoke')
  await ownerPage.getByLabel('Caja', { exact: true }).fill('Caja smoke')
  await ownerPage.getByText('Dirección y contacto (opcional)', { exact: true }).click()
  await ownerPage.getByLabel('Ciudad', { exact: true }).fill('Ciudad sintética')
  await ownerPage.getByRole('button', { name: 'Continuar', exact: true }).click()
  await ownerPage.getByTestId('pin-input').fill('028462')
  await ownerPage.getByTestId('pin-confirm-input').fill('028462')
  const creationResponse = ownerPage.waitForResponse(response => response.url().endsWith('/functions/v1/account') && JSON.parse(response.request().postData() ?? '{}').action === 'create_business')
  await ownerPage.getByRole('button', { name: 'Crear PIN', exact: true }).click()
  const creation = await (await creationResponse).json()
  assert(creation.data, 'Real business creation must return data')
  businessId = creation.data.business.id
  assert.equal(creation.data.business.profile.city, 'Ciudad sintética')
  await ownerPage.getByRole('heading', { name: 'Cuenta creada', exact: true }).waitFor()
  await ownerPage.getByRole('button', { name: 'Ir al inicio', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Empleados', exact: true }).click()
  stage = 'seed an existing PIN-only employee for compatibility'
  const legacyResponse = await rawAccount({ action: 'create_employee', businessId, operatorToken: creation.data.operatorToken, name: 'Cajero smoke', role: 'cashier', pin: null, inviteWithGoogle: false, operationId: randomUUID() }, signed.data.session.access_token)
  assert.equal(legacyResponse.status, 200)
  const employee = (await legacyResponse.json()).data
  assert(employee.id && !employee.pinReady && !employee.googleLinked && employee.pinSetup)
  assert.match(employee.pinSetup.setupCode, /^[a-f0-9]{64}$/)
  await ownerPage.evaluate(() => window.dispatchEvent(new Event('focus')))
  await ownerPage.getByRole('button', { name: 'Administrar Cajero smoke', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Eliminar empleado', exact: true }).waitFor()
  assert.equal(await ownerPage.locator('.management-shell input[type="password"]').count(), 0, 'Only the employee chooses the PIN')
  await ownerPage.getByRole('button', { name: 'Volver a empleados', exact: true }).click()
  stage = 'single Google employee form'
  assert.equal(await ownerPage.getByRole('button', { name: 'Crear invitación', exact: true }).count(), 0)
  await ownerPage.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
  await ownerPage.getByLabel('Nombre del empleado', { exact: true }).fill('Pendiente Google smoke')
  assert.equal(await ownerPage.getByRole('checkbox').count(), 0, 'One invitation method')
  assert.equal(await ownerPage.locator('.management-shell input[type="password"]').count(), 0)
  await ownerPage.setViewportSize({ width: 393, height: 851 })
  await ownerPage.screenshot({ path: '/tmp/pos-mexico-lifecycle-employee-form.png', fullPage: false })
  const googleResponse = accountResponse(ownerPage, 'create_employee')
  await ownerPage.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  const pendingEmployee = (await (await googleResponse).json()).data
  assert(pendingEmployee.id && !pendingEmployee.pinReady && pendingEmployee.invitation)
  assert.match(pendingEmployee.invitation.invitationCode, /^[a-f0-9]{64}$/)
  await ownerPage.getByText('Pendiente de aceptar', { exact: true }).waitFor()
  await expect(ownerPage.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`${origin}/#invite=${pendingEmployee.invitation.invitationCode}`)
  await expect(ownerPage.getByRole('heading', { name: 'Invitación lista' })).toBeVisible()
  assert.equal(await ownerPage.getByLabel('Nombre del empleado', { exact: true }).count(), 0)
  await ownerPage.screenshot({ path: '/tmp/pos-mexico-lifecycle-pending-employee.png', fullPage: true })
  await ownerPage.getByRole('button', { name: 'Volver a empleados', exact: true }).click()
  assert.equal(await ownerPage.getByRole('heading', { name: 'Invitaciones', exact: true }).count(), 0, 'No duplicate invitation list')
  assert.equal(staffSnapshot().length, 2)
  await ownerPage.setViewportSize({ width: 1280, height: 900 })
  stage = 'pair device'
  await ownerPage.getByRole('button', { name: 'Volver a Más', exact: true }).click();
  await ownerPage.getByRole('button', { name: 'Dispositivos de caja', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  const pairingCode = await ownerPage.getByLabel('Código para vincular dispositivo', { exact: true }).inputValue()
  assert.match(pairingCode, /^[a-f0-9]{64}$/)
  await devicePage.goto(`${origin}/register`)
  await devicePage.getByLabel('Código para vincular dispositivo', { exact: true }).fill(pairingCode)
  await devicePage.getByLabel('Nombre del dispositivo', { exact: true }).fill('Tablet smoke')
  await devicePage.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click()
  await devicePage.getByRole('heading', { name: 'Elige tu nombre', exact: true }).waitFor()
  assert.equal(await devicePage.getByRole('button', { name: 'Pendiente Google smoke', exact: true }).count(), 0)
  assert.equal(await devicePage.getByRole('button', { name: 'Cajero smoke', exact: true }).count(), 0, 'A person without a PIN cannot unlock')
  stage = 'employee chooses own PIN on the paired device'
  await devicePage.getByRole('button', { name: 'Crear o restablecer mi PIN', exact: true }).click()
  await devicePage.getByLabel('Código de autorización', { exact: true }).fill(employee.pinSetup.setupCode)
  await devicePage.getByRole('button', { name: 'Continuar', exact: true }).click()
  await devicePage.getByLabel('Nuevo PIN', { exact: true }).fill('024680')
  await devicePage.getByLabel('Confirmar nuevo PIN', { exact: true }).fill('024680')
  const setupResponse = accountResponse(devicePage, 'device_set_employee_pin')
  await devicePage.getByRole('button', { name: 'Guardar mi PIN', exact: true }).click()
  assert.equal((await (await setupResponse).json()).data.business.employee.id, employee.id)
  await devicePage.getByRole('button', { name: 'Más', exact: true }).waitFor()
  await devicePage.getByRole('button', { name: 'Más', exact: true }).click()
  assert.equal(await devicePage.getByRole('button', { name: 'Datos del negocio', exact: true }).count(), 0)
  await devicePage.screenshot({ path: '/tmp/pos-mexico-real-employee-smoke.png', fullPage: true })
  stage = 'link existing employee invitation'
  await ownerPage.getByRole('button', { name: 'Volver a Más', exact: true }).click();
  await ownerPage.getByRole('button', { name: 'Empleados', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Administrar Cajero smoke', exact: true }).click()
  const linkResponse = accountResponse(ownerPage, 'create_invitation')
  await ownerPage.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  const linkResult = await linkResponse
  assert.equal(JSON.parse(linkResult.request().postData()).employeeId, employee.id)
  assert.equal(linkResult.status(), 200)
  const invitationCode = (await linkResult.json()).data.invitationCode
  await expect(ownerPage.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`${origin}/#invite=${invitationCode}`)
  assert.match(invitationCode, /^[a-f0-9]{64}$/)
  const employeeCredentials = { email: `smoke-${randomUUID()}@example.test`, password: `local-only-${randomUUID()}-Aa9!` }
  const employeeCreated = await admin.auth.admin.createUser({ ...employeeCredentials, email_confirm: true })
  if (employeeCreated.error) throw new Error('Synthetic employee account creation failed')
  employeeUserId = employeeCreated.data.user.id
  const employeeClient = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const employeeSigned = await employeeClient.auth.signInWithPassword(employeeCredentials)
  if (employeeSigned.error) throw new Error('Synthetic employee local sign-in failed')
  const personalContext = await browser.newContext({ serviceWorkers: 'block' })
  await personalContext.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  // Use real local Auth data exactly as the SDK stores it, without an app login bypass.
  await personalContext.addInitScript(session => {
    if (!localStorage.getItem('pos-mexico-auth')) localStorage.setItem('pos-mexico-auth', JSON.stringify(session))
  }, employeeSigned.data.session)
  const personalPage = await personalContext.newPage()
  await personalPage.goto(`${origin}/join`)
  await personalPage.getByLabel('Enlace de invitación', { exact: true }).fill(`${origin}/#invite=${invitationCode}`)
  await personalPage.getByRole('button', { name: 'Abrir invitación', exact: true }).click()
  assert.equal(await personalPage.getByLabel('Tu nombre', { exact: true }).count(), 0)
  await personalPage.getByTestId('pin-input').fill('024680')
  assert.equal(await personalPage.getByTestId('pin-confirm-input').count(), 0, 'Linking verifies and preserves the existing PIN')
  const acceptanceResponse = accountResponse(personalPage, 'accept_invitation')
  await personalPage.getByRole('button', { name: 'Unirme', exact: true }).click()
  const acceptance = (await (await acceptanceResponse).json()).data
  assert.equal(acceptance.business.employee.id, employee.id)
  assert.equal(acceptance.business.employee.name, 'Cajero smoke')
  const staff = staffSnapshot()
  assert.equal(staff.length, 2, 'Linking must not create another person')
  assert.deepEqual(staff.find(row => row.id === employee.id), { id: employee.id, name: 'Cajero smoke', userId: employeeUserId, sharedPin: false })
  await personalPage.getByRole('button', { name: 'Más', exact: true }).click()
  assert.equal(await personalPage.getByRole('button', { name: 'Datos del negocio', exact: true }).count(), 0)
  await personalPage.reload()
  await personalPage.getByRole('heading', { name: 'Ingresa tu PIN', exact: true }).waitFor()
  await personalPage.getByTestId('pin-input').fill('024680')
  await personalPage.getByRole('button', { name: 'Entrar', exact: true }).click()
  await personalPage.getByRole('button', { name: 'Más', exact: true }).waitFor()
  stage = 'linked employee preserves PIN and revokes previous device session'
  await devicePage.evaluate(() => window.dispatchEvent(new Event('focus')))
  await devicePage.getByRole('heading', { name: 'Elige tu nombre', exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await devicePage.getByRole('button', { name: 'Cajero smoke', exact: true }).count(), 0, 'Google-linked staff no longer appear on shared registers')
  assert.equal(await devicePage.getByRole('button', { name: 'Pendiente Google smoke', exact: true }).count(), 0)
  const linkedDeviceToken = await devicePage.evaluate(() => localStorage.getItem('pos-mexico-device'))
  const blockedRegister = await rawAccount({ action: 'device_unlock', deviceToken: linkedDeviceToken, employeeId: employee.id, pin: '024680' })
  assert.equal((await blockedRegister.json()).error.code, 'DEVICE_LINK_REQUIRED', 'A correct employee PIN cannot bypass the linked browser through a register')
  stage = 'invitation outcome and employee deletion'
  await ownerPage.getByRole('button', { name: 'Volver a empleados', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Volver a Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Empleados', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Administrar Cajero smoke', exact: true }).click()
  await ownerPage.getByText('Invitación aceptada', { exact: true }).waitFor()
  assert.equal(await ownerPage.getByText(/revocada o utilizada/).count(), 0)
  assert.equal(await ownerPage.getByRole('button', { name: 'Crear invitación', exact: true }).count(), 0)
  await ownerPage.getByRole('button', { name: 'Eliminar empleado', exact: true }).click()
  await ownerPage.setViewportSize({ width: 393, height: 851 })
  await ownerPage.screenshot({ path: '/tmp/pos-mexico-lifecycle-delete-confirmation.png', fullPage: true })
  const deleteResponse = accountResponse(ownerPage, 'delete_employee')
  await ownerPage.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click()
  const deletion = await deleteResponse
  assert.equal(deletion.status(), 200)
  assert.equal(JSON.parse(deletion.request().postData()).employeeId, employee.id)
  assert.deepEqual((await deletion.json()).data, { id: employee.id, deleted: true })
  await expect(ownerPage.getByRole('button', { name: 'Administrar Cajero smoke', exact: true })).toHaveCount(0)
  await devicePage.evaluate(() => window.dispatchEvent(new Event('focus')))
  await devicePage.getByRole('heading', { name: 'Elige tu nombre', exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await devicePage.getByRole('button', { name: 'Cajero smoke', exact: true }).count(), 0)
  const closedPersonal = accountResponse(personalPage, 'context')
  await personalPage.evaluate(() => window.dispatchEvent(new Event('focus')))
  assert.equal((await closedPersonal).status(), 403, 'Deletion closes the existing personal session')
  await expect(personalPage.getByRole('button', { name: 'Más', exact: true })).toHaveCount(0)
  assert.equal(staffSnapshot().length, 1, 'Deletion removes the employee row')
  assert(!staffSnapshot().some(row => row.id === employee.id))
  await expect(ownerPage.getByText('Empleados eliminados', { exact: true })).toHaveCount(0)
  stage = 'fresh invitation after deletion creates a new employee and PIN'
  await ownerPage.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
  await ownerPage.getByLabel('Nombre del empleado', { exact: true }).fill('Cajero nuevo smoke')
  const freshCreationResponse = accountResponse(ownerPage, 'create_employee')
  await ownerPage.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  const freshEmployee = (await (await freshCreationResponse).json()).data
  assert.notEqual(freshEmployee.id, employee.id)
  await personalPage.goto(`${origin}/#invite=${freshEmployee.invitation.invitationCode}`)
  await expect(personalPage.getByLabel('Confirma tu PIN', { exact: true })).toBeVisible()
  await expect(personalPage.getByLabel('PIN actual', { exact: true })).toHaveCount(0)
  await personalPage.getByTestId('pin-input').fill('135791')
  await personalPage.getByTestId('pin-confirm-input').fill('135791')
  const freshAcceptance = accountResponse(personalPage, 'accept_invitation')
  await personalPage.getByRole('button', { name: 'Unirme', exact: true }).click()
  assert.equal((await (await freshAcceptance).json()).data.business.employee.id, freshEmployee.id)
  await personalPage.getByRole('button', { name: 'Más', exact: true }).waitFor()
  await personalPage.reload()
  await personalPage.getByRole('heading', { name: 'Ingresa tu PIN', exact: true }).waitFor()
  const oldPinResponse = accountResponse(personalPage, 'unlock')
  await personalPage.getByTestId('pin-input').fill('024680')
  await personalPage.getByRole('button', { name: 'Entrar', exact: true }).click()
  assert.equal((await (await oldPinResponse).json()).error.code, 'PIN_INVALID')
  await personalPage.getByTestId('pin-input').fill('135791')
  await personalPage.getByRole('button', { name: 'Entrar', exact: true }).click()
  await personalPage.getByRole('button', { name: 'Más', exact: true }).waitFor()
  await ownerPage.getByRole('button', { name: 'Volver a empleados', exact: true }).click()
  await ownerPage.screenshot({ path: '/tmp/pos-mexico-lifecycle-employee-list.png', fullPage: true })
  await devicePage.reload()
  await devicePage.getByRole('heading', { name: 'Elige tu nombre', exact: true }).waitFor()
  assert.equal(await devicePage.getByRole('button', { name: 'Cajero nuevo smoke', exact: true }).count(), 0, 'A fresh Google-linked employee cannot bypass personal device checks through a shared register')
  stage = 'cancel and renew invitation with exact outcome'
  await ownerPage.getByRole('button', { name: 'Administrar Pendiente Google smoke', exact: true }).click()
  const cancelInvitation = accountResponse(ownerPage, 'revoke_invitation')
  await ownerPage.getByRole('button', { name: 'Cancelar invitación', exact: true }).click()
  assert.equal((await cancelInvitation).status(), 200)
  await ownerPage.getByText('Invitación cancelada', { exact: true }).waitFor()
  const renewInvitation = accountResponse(ownerPage, 'create_invitation')
  await ownerPage.getByRole('button', { name: 'Renovar invitación', exact: true }).click()
  const renewedResponse = await renewInvitation
  assert.equal(renewedResponse.status(), 200)
  const renewed = (await renewedResponse.json()).data
  await ownerPage.getByText('Pendiente de aceptar', { exact: true }).waitFor()
  assert.equal(staffSnapshot().length, 2, 'Renewing never duplicates the person')
  await ownerPage.getByRole('button', { name: 'Volver a empleados', exact: true }).click()
  await ownerPage.setViewportSize({ width: 1280, height: 900 })
  stage = 'revoke device'
  await ownerPage.getByRole('button', { name: 'Volver a Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Dispositivos de caja', exact: true }).click()
  const revocationResponse = ownerPage.waitForResponse(response => response.url().endsWith('/functions/v1/account') && JSON.parse(response.request().postData() ?? '{}').action === 'revoke_device')
  await ownerPage.getByRole('button', { name: 'Desvincular Tablet smoke', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Confirmar desvinculación', exact: true }).click()
  assert.equal((await revocationResponse).status(), 200)
  stage = 'verify revoked device'
  // This register is idle after linked employees were removed from its roster; reload requests fresh device_status.
  await devicePage.reload()
  await devicePage.getByRole('heading', { name: 'Vincular caja compartida', exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await devicePage.evaluate(() => localStorage.getItem('pos-mexico-device')), null)
  stage = 'new invitation recipient chooses their PIN'
  const invitedCredentials = { email: `smoke-${randomUUID()}@example.test`, password: `local-only-${randomUUID()}-Aa9!` }
  const invitedCreated = await admin.auth.admin.createUser({ ...invitedCredentials, email_confirm: true })
  if (invitedCreated.error) throw new Error('Synthetic invitee creation failed')
  invitedUserId = invitedCreated.data.user.id
  const invitedClient = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const invitedSigned = await invitedClient.auth.signInWithPassword(invitedCredentials)
  if (invitedSigned.error) throw new Error('Synthetic invitee local sign-in failed')
  const invitedContext = await browser.newContext({ serviceWorkers: 'block' })
  await invitedContext.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  await invitedContext.addInitScript(session => localStorage.setItem('pos-mexico-auth', JSON.stringify(session)), invitedSigned.data.session)
  const invitedPage = await invitedContext.newPage()
  await invitedPage.goto(`${origin}/#invite=${renewed.invitationCode}`)
  await invitedPage.getByTestId('pin-confirm-input').waitFor()
  assert.equal(await invitedPage.getByLabel('Enlace de invitación', { exact: true }).count(), 0, 'The link fills the invitation without manual code entry')
  await invitedPage.getByTestId('pin-input').fill('024682')
  await invitedPage.getByTestId('pin-confirm-input').fill('024682')
  const invitedAcceptance = accountResponse(invitedPage, 'accept_invitation')
  await invitedPage.getByRole('button', { name: 'Unirme', exact: true }).click()
  assert.equal((await (await invitedAcceptance).json()).data.business.employee.id, pendingEmployee.id)
  await invitedPage.getByRole('heading', { name: 'Venta', exact: true }).waitFor()
  assert.equal(staffSnapshot().length, 2, 'Accepting reuses the invited person')
  await invitedContext.close()
  stage = 'known owner PIN change without OAuth'
  await ownerPage.getByRole('button', { name: 'Volver a Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Cambiar mi PIN', exact: true }).click()
  await ownerPage.getByLabel('PIN actual', { exact: true }).fill('028462')
  await ownerPage.getByTestId('pin-input').fill('086420')
  await ownerPage.getByTestId('pin-confirm-input').fill('086420')
  const changeResponse = accountResponse(ownerPage, 'change_pin')
  await ownerPage.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click()
  assert.equal((await changeResponse).status(), 200)
  await ownerPage.getByRole('button', { name: 'Más', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Bloquear', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Olvidé mi PIN', exact: true }).click()
  stage = 'email PIN recovery through the local mailbox without Google'
  const mailResponse = accountResponse(ownerPage, 'request_pin_email')
  await ownerPage.getByRole('button', { name: 'Enviar enlace al correo', exact: true }).click()
  assert.equal((await mailResponse).status(), 200)
  await ownerPage.getByRole('heading', { name: 'Revisa tu correo', exact: true }).waitFor()
  const inbox = await (await fetch(new URL('/api/v1/messages', mailbox))).json()
  const found = inbox.messages.find(message => message.To.some(to => to.Address===credentials.email))
  assert(found, 'Recovery reaches the synthetic local mailbox')
  const mail = await (await fetch(new URL(`/api/v1/message/${found.ID}`, mailbox))).json()
  const recoveryToken = mail.Text.match(/#recovery=([a-f0-9]{64})/)?.[1]
  assert(recoveryToken)
  const recoveryContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 393, height: 851 } })
  await recoveryContext.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  const recoveryPage = await recoveryContext.newPage()
  await recoveryPage.goto(`${origin}/recover-pin#recovery=${recoveryToken}`)
  await recoveryPage.getByRole('heading', { name: 'Crea un nuevo PIN', exact: true }).waitFor()
  assert.equal(await recoveryPage.evaluate(() => localStorage.getItem('pos-mexico-auth')), null)
  assert.equal(await recoveryPage.evaluate(token => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }).includes(token), recoveryToken), false)
  await recoveryPage.screenshot({ path: '/tmp/pos-pin-email-real-form.png', fullPage: true })
  await recoveryPage.getByTestId('pin-input').fill('482620')
  await recoveryPage.getByTestId('pin-confirm-input').fill('482620')
  const resetResponse = accountResponse(recoveryPage, 'confirm_pin_email')
  await recoveryPage.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click()
  assert.equal((await resetResponse).status(), 200)
  await recoveryPage.getByRole('heading', { name: 'PIN actualizado', exact: true }).waitFor()
  await ownerPage.getByRole('button', { name: 'Volver al PIN', exact: true }).click()
  await ownerPage.getByTestId('pin-input').fill('482620')
  await ownerPage.getByRole('button', { name: 'Entrar', exact: true }).click()
  await ownerPage.getByRole('button', { name: 'Más', exact: true }).waitFor()
  console.log('PASS real loopback browser/Auth/Edge/Postgres/Mailpit: email confirmation opens in a signed-out browser, PIN updates without Google/code entry, original account unlocks with the new PIN; current-PIN change, employee-owned setup, same-PIN Google linking, invitation acceptance, permanent deletion and reinvitation with a new PIN, linked-browser enforcement and legacy PIN-only registers remain working. Synthetic identities only; no hosted email delivery claim.')

} catch (error) {
  console.error(`Failure category: ${error?.name ?? 'Error'}; ${String(error?.message ?? '').split('\n')[0]}`)
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: '/tmp/pos-real-onboarding-failure.png', fullPage: true }).catch(() => undefined)
  throw new Error(`Real loopback onboarding smoke failed at: ${stage}. Credentials and response payloads omitted.`)
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
  if (invitedUserId) { const result = await admin.auth.admin.deleteUser(invitedUserId); if (result.error) throw new Error('Synthetic invitee cleanup failed') }
  if (employeeUserId) { const result = await admin.auth.admin.deleteUser(employeeUserId); if (result.error) throw new Error('Synthetic employee cleanup failed') }
  if (userId) { const result = await admin.auth.admin.deleteUser(userId); if (result.error) throw new Error('Synthetic user cleanup failed') }
  if (businessId) {
    assert.match(businessId, /^[a-f0-9-]{36}$/i)
    execFileSync('docker', ['exec', '-i', databaseContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', `delete from app_private.businesses where id='${businessId}'::uuid;`], { stdio: ['ignore', 'pipe', 'pipe'] })
  }
}
