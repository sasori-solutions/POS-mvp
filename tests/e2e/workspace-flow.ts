import { expect, type Page } from '@playwright/test'

/** Owner entry now opens its dashboard. Operational tests explicitly enter the POS. */
export async function enterOperations(page: Page) {
  await expect(page.locator('#pos-section-title')).toBeVisible()
  const openMenu = page.getByRole('button', {name:'Abrir menú',exact:true})
  if (await openMenu.isVisible()) await openMenu.click()
  const pos = page.getByRole('button',{name:'Punto de Venta',exact:true}).filter({visible:true}).first()
  if (await pos.isVisible()) await pos.click()
  else if (await page.locator('#pos-section-title').textContent() !== 'Venta') {
    await page.getByRole('button', { name: 'Venta', exact: true }).filter({ visible: true }).first().click()
  }
  await expect(page.getByRole('heading',{name:'Venta',exact:true})).toBeVisible()
}
export async function openOperationalMore(page: Page) {
  await expect(page.locator('#pos-section-title')).toBeVisible()
  const more = page.getByRole('button',{name:'Más',exact:true}).filter({visible:true}).first()
  if (!await more.isVisible()) await enterOperations(page)
  await more.click()
}
export async function ownerAccountMenu(page: Page) {
  await openOwnerNavigation(page)
  await page.getByRole('button',{name:/^Opciones de cuenta:/}).filter({visible:true}).first().click()
}

/** Owner management lives in the dashboard sidebar, including its mobile drawer. */
export async function openOwnerNavigation(page: Page) {
  await expect(page.locator('#pos-section-title')).toBeVisible()
  const dashboard = page.getByRole('button', { name: 'Dashboard', exact: true }).filter({ visible: true }).first()
  if (await dashboard.isVisible()) await dashboard.click()
  await expect(page.locator('.workspace-owner')).toBeVisible()
  const menu = page.getByRole('button', { name: 'Abrir menú', exact: true })
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click()
  await expect(page.getByRole('navigation', { name: 'Navegación del dueño' }).filter({ visible: true })).toBeVisible()
}

export async function openOwnerTask(page: Page, task: string, options: { keyboard?: boolean } = {}) {
  const names: Record<string, string> = { 'Datos del negocio': 'Configuración', 'Dispositivos de caja': 'Dispositivos' }
  if (task === 'Cambiar mi PIN') await ownerAccountMenu(page)
  else await openOwnerNavigation(page)
  const control = page.getByRole('button', { name: names[task] ?? task, exact: true }).filter({ visible: true }).first()
  if (options.keyboard) { await control.focus(); await expect(control).toBeFocused(); await control.press('Enter') }
  else await control.click()
}
/** Personal PIN submits on its sixth digit; paired registers retain an explicit submit. */
export async function submitPinIfPresent(page: Page) {
  const submit=page.getByRole('button',{name:'Entrar',exact:true})
  if(await submit.isVisible()) await submit.click()
}
