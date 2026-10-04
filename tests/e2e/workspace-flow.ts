import { expect, type Page } from '@playwright/test'

/** Owner entry now opens its dashboard. Operational tests explicitly enter the POS. */
export async function enterOperations(page: Page) {
  await expect(page.locator('#pos-section-title')).toBeVisible()
  const openMenu = page.getByRole('button', {name:'Abrir menú',exact:true})
  if (await openMenu.isVisible()) await openMenu.click()
  const pos = page.getByRole('button',{name:'Punto de Venta',exact:true}).filter({visible:true}).first()
  if (await pos.isVisible()) await pos.click()
  await expect(page.getByRole('heading',{name:'Venta',exact:true})).toBeVisible()
}
export async function openOperationalMore(page: Page) {
  await expect(page.locator('#pos-section-title')).toBeVisible()
  const more = page.getByRole('button',{name:'Más',exact:true}).filter({visible:true}).first()
  if (!await more.isVisible()) await enterOperations(page)
  await more.click()
}
export async function ownerAccountMenu(page: Page) {
  const menu=page.getByRole('button',{name:'Abrir menú',exact:true})
  if(await menu.isVisible()) await menu.click()
  await page.getByRole('button',{name:/^Opciones de cuenta:/}).filter({visible:true}).first().click()
}
/** Personal PIN submits on its sixth digit; paired registers retain an explicit submit. */
export async function submitPinIfPresent(page: Page) {
  const submit=page.getByRole('button',{name:'Entrar',exact:true})
  if(await submit.isVisible()) await submit.click()
}
