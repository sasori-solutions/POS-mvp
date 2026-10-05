/** Real local browser -> Auth -> Edge -> PostgreSQL, with no mocked responses or Google. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import { localConfiguration, requireLoopback, seedDevelopment } from '../../scripts/local-development.mjs'
import { readFileSync } from 'node:fs'

const origin = process.env.DEV_SMOKE_ORIGIN ?? 'http://127.0.0.1:5173'
requireLoopback(origin)
const config = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['--workdir', '.local-dev', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
requireLoopback(config.API_URL)
const { projectId } = localConfiguration(readFileSync('supabase/config.toml', 'utf8'), process.cwd(), Number(new URL(origin).port))
const browser = await chromium.launch()
const ownerContext = await browser.newContext({ viewport: { width: 1024, height: 900 } })
const employeeContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
let businessId
let employeeBusinessId
const businessName = `Dev smoke ${randomUUID().slice(0, 8)}`
const external = []
for (const context of [ownerContext, employeeContext]) {
  await context.route('**/*', route => {
    const hostname = new URL(route.request().url()).hostname
    if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return route.continue()
    external.push(route.request().url()); return route.abort()
  })
}
const owner = await ownerContext.newPage()
const employee = await employeeContext.newPage()
const failedAccountResponses = []
for (const [actor, page] of [['owner', owner], ['employee', employee]]) {
  page.on('response', async response => {
    if (!response.url().endsWith('/functions/v1/account') || response.status() < 400) return
    try {
      const request = response.request().postDataJSON()
      const reply = await response.json()
      failedAccountResponses.push({ actor, action: request.action, command: request.command, status: response.status(), code: reply.error?.code })
    } catch { /* A discarded response must not expose request credentials in diagnostics. */ }
  })
}
await owner.addInitScript(() => {
  if (!localStorage.getItem('pos-mexico-auth')) localStorage.setItem('pos-mexico-auth', 'hosted-session-placeholder')
})
function response(page, action) { return page.waitForResponse(response => response.url().endsWith('/functions/v1/account') && response.request().postDataJSON().action === action) }
async function login(page, account) {
  await page.getByRole('link', { name: 'Entrar en desarrollo' }).click()
  await page.getByLabel('Cuenta de prueba').selectOption(`${account}@pos.local.test`)
  await page.getByRole('button', { name: 'Entrar en desarrollo', exact: true }).click()
}
try {
  await owner.goto(`${origin}/`)
  await expect(owner.getByRole('link', { name: 'Entrar en desarrollo' })).toBeVisible()
  assert.equal(await owner.evaluate(() => localStorage.getItem('pos-mexico-auth')), 'hosted-session-placeholder', 'Local initialization ignores hosted identity storage')
  await login(owner, 'new')
  await owner.getByRole('button', { name: 'Crear mi negocio', exact: true }).click()
  await owner.getByLabel('Nombre del negocio').fill(businessName)
  await owner.getByRole('button', { name: 'Continuar', exact: true }).click()
  await owner.getByRole('button', { name: 'Continuar', exact: true }).click()
  await owner.getByTestId('pin-input').fill('234567')
  await owner.getByTestId('pin-confirm-input').fill('234567')
  const creation = response(owner, 'create_business')
  await owner.getByRole('button', { name: 'Crear negocio', exact: true }).click()
  businessId = (await (await creation).json()).data.business.id
  await expect(owner.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible()
  await owner.getByRole('navigation').getByRole('button', { name: 'Productos', exact: true }).click()
  await owner.getByRole('button', { name: 'Agregar producto', exact: true }).click()
  await owner.getByLabel('Nombre', { exact: true }).fill('Café del smoke')
  await owner.getByLabel('Precio final MXN', { exact: true }).fill('12.34')
  await owner.getByRole('button', { name: 'Guardar producto', exact: true }).click()
  await expect(owner.getByRole('button', { name: 'Editar Café del smoke' })).toBeVisible()
  await owner.reload()
  await expect(owner.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible()
  await owner.getByTestId('pin-input').fill('234567')
  await owner.getByRole('button', { name: 'Entrar', exact: true }).click()
  await owner.getByRole('button', { name: /^Agregar Café del smoke,/ }).click()
  await owner.getByRole('button', { name: 'Cobrar $12.34' }).click()
  const registration = response(owner, 'pos')
  await owner.getByRole('button', { name: 'Registrar pago', exact: true }).click()
  const sale = (await (await registration).json()).data
  assert.equal(sale.totalCents, 1234)
  await expect(owner.getByRole('heading', { name: 'Venta registrada' })).toBeVisible()
  await owner.getByRole('navigation').getByRole('button', { name: 'Más', exact: true }).click()
  await owner.getByRole('button', { name: /Empleados/ }).click()
  await owner.getByRole('button', { name: 'Agregar empleado', exact: true }).click()
  await owner.getByLabel('Nombre del empleado').fill('Empleado smoke local')
  await owner.getByRole('checkbox', { name: 'Cobrar ventas', exact: true }).check()
  await expect(owner.getByRole('checkbox', { name: 'Consultar productos', exact: true })).toBeChecked()
  const employeeCreation = response(owner, 'create_employee')
  await owner.getByRole('button', { name: 'Crear invitación', exact: true }).click()
  assert.deepEqual((await (await employeeCreation).json()).data.permissions, ['catalog.read', 'sales.create'])
  const invitation = await owner.getByLabel('Enlace de invitación', { exact: true }).inputValue()
  await employee.goto(`${origin}/`)
  await login(employee, 'employee')
  await employee.getByRole('button', { name: 'Crear mi negocio', exact: true }).click()
  await employee.getByLabel('Nombre del negocio').fill('Negocio propio del empleado')
  await employee.getByRole('button', { name: 'Continuar', exact: true }).click()
  await employee.getByRole('button', { name: 'Continuar', exact: true }).click()
  await employee.getByTestId('pin-input').fill('456789')
  await employee.getByTestId('pin-confirm-input').fill('456789')
  const ownCreation = response(employee, 'create_business')
  await employee.getByRole('button', { name: 'Crear negocio', exact: true }).click()
  employeeBusinessId = (await (await ownCreation).json()).data.business.id
  await employee.goto(invitation)
  await employee.getByTestId('pin-input').fill('345678')
  await employee.getByTestId('pin-confirm-input').fill('345678')
  const acceptance = response(employee, 'accept_invitation')
  await employee.getByRole('button', { name: 'Unirme', exact: true }).click()
  assert.deepEqual((await (await acceptance).json()).data.business.permissions, ['catalog.read', 'sales.create'])
  await expect(employee.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible()
  await employee.getByRole('navigation').getByRole('button', { name: 'Productos', exact: true }).click()
  await expect(employee.getByRole('heading', { name: 'Productos', exact: true })).toBeVisible()
  assert.equal(await employee.getByRole('button', { name: 'Agregar producto', exact: true }).count(), 0)
  await employee.reload()
  await employee.getByTestId('pin-input').fill('345678')
  await employee.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(employee.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible()
  await owner.getByRole('button', { name: 'Listo', exact: true }).click()
  await owner.getByRole('button', { name: 'Volver a Más', exact: true }).click()
  await employee.getByRole('navigation').getByRole('button', { name: 'Más', exact: true }).click()
  await employee.getByRole('button', { name: 'Cambiar negocio', exact: true }).click()
  await expect(employee.getByRole('heading', { name: 'Mis negocios', exact: true })).toBeVisible()
  await expect(employee.getByRole('heading', { name: 'Como empleado', exact: true })).toBeVisible()
  await employee.getByRole('button', { name: new RegExp(businessName) }).click()
  await employee.getByTestId('pin-input').fill('345678')
  await employee.getByRole('button', { name: 'Entrar', exact: true }).click()
  await employee.getByRole('navigation').getByRole('button', { name: 'Más', exact: true }).click()
  await employee.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await login(employee, 'employee')
  await expect(employee.getByRole('heading', { name: 'Ingresa tu PIN', exact: true })).toBeVisible()
  await expect(employee.getByText(/Dev smoke/)).toBeVisible()
  await employee.getByTestId('pin-input').fill('345678')
  await employee.getByRole('button', { name: 'Entrar', exact: true }).click()
  await owner.getByRole('navigation').getByRole('button', { name: 'Productos', exact: true }).click()
  await owner.getByRole('button', { name: 'Agregar producto', exact: true }).click()
  await owner.getByLabel('Nombre', { exact: true }).fill('Producto creado después del ingreso')
  await owner.getByLabel('Precio final MXN', { exact: true }).fill('25.00')
  await owner.getByRole('button', { name: 'Guardar producto', exact: true }).click()
  await expect(employee.getByRole('button', { name: /^Agregar Producto creado después del ingreso,/ })).toBeVisible({ timeout: 20_000 })
  await owner.getByRole('navigation').getByRole('button', { name: 'Más', exact: true }).click()
  await owner.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await expect(owner.getByRole('link', { name: 'Entrar en desarrollo' })).toBeVisible()
  assert.equal(await owner.evaluate(() => localStorage.getItem('pos-mexico-auth')), 'hosted-session-placeholder', 'Local logout preserves hosted identity storage')
  await login(owner, 'new')
  await owner.getByTestId('pin-input').fill('234567')
  await owner.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(owner.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible()
  await owner.getByRole('navigation').getByRole('button', { name: 'Ventas', exact: true }).click()
  await owner.getByRole('button', { name: /^Ver venta/ }).click()
  await expect(owner.locator('.sale-detail')).toContainText('$12.34')
  assert.equal(await owner.evaluate(() => localStorage.getItem('pos-mexico-auth')), 'hosted-session-placeholder', 'Local sign-in and logout leave hosted identity storage untouched')
  const counts = () => execFileSync('docker', ['exec', '-i', `supabase_db_${projectId}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', 'select (select count(*) from auth.users), (select count(*) from app_private.businesses), (select count(*) from app_private.products), (select count(*) from app_private.sales);'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const before = counts()
  assert.equal((await seedDevelopment(config)).created, false)
  assert.equal(counts(), before, 'Seeding again preserves identities, businesses, products and sales without duplicates')
  assert.deepEqual(external, [], 'No external requests, including Google or hosted Supabase')
  if (failedAccountResponses.length) console.error(JSON.stringify({ failedAccountResponses }))
  console.log('PASS development UI: password login, business/PIN, persisted product/sale, owned and employee business selection, logout/relogin, a product created after employee login, device reload and non-destructive reseeding, without Google.')
} catch (error) {
  console.error(JSON.stringify({ failedAccountResponses }))
  throw error
} finally {
  await browser.close()
  for (const cleanupId of [businessId, employeeBusinessId].filter(Boolean)) {
    assert.match(cleanupId, /^[0-9a-f-]{36}$/)
    execFileSync('docker', ['exec', '-i', `supabase_db_${projectId}`, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', `delete from app_private.businesses where id='${cleanupId}'::uuid;`], { stdio: ['ignore', 'pipe', 'pipe'] })
  }
}
