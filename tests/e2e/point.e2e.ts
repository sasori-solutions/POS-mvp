import { test, expect, type Page } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { mockPoint } from './point-fixture'
import { enterOperations } from './workspace-flow'

async function unlock(page: Page) { await page.goto('/'); await page.getByTestId('pin-input').fill(fixturePin); await expect(page.getByRole('heading',{name:'Inicio',exact:true})).toBeVisible() }
async function sell(page: Page) {
  await enterOperations(page)
  await page.getByRole('button',{name:/^Agregar Latte,/}).click()
  const view = page.getByRole('button',{name:/^Ver cuenta/}); if (await view.isVisible()) await view.click()
  await page.getByRole('button',{name:'Cobrar',exact:true}).click()
  await page.locator('label').filter({has:page.getByRole('radio',{name:'Mercado Pago A terminal',exact:true})}).click()
  await expect(page.getByRole('radio',{name:'Mercado Pago A terminal',exact:true})).toBeChecked()
  await expect(page.getByRole('button',{name:/^Enviar a terminal/})).toBeEnabled()
}

test('Point linked SQL payment creates one sale and reports verified volume; owner does not get global admin', async ({page}) => {
  const backend = await mockPoint(page)
  try {
    await unlock(page); await expect(page.getByRole('button',{name:'Panel privado SASORI'})).toHaveCount(0)
    await sell(page); await page.getByRole('button',{name:/^Enviar a terminal/}).click()
    await expect(page.getByRole('heading',{name:'Pago aprobado'})).toBeVisible()
    await expect(page.getByText('El pago quedó registrado.')).toBeVisible()
    expect(backend.remoteCharges()).toBe(1)
    expect((await backend.execute({command:'merchant_report',from:'2026-01-01',to:'2026-12-31'})).paymentCount).toBe(1)
    expect((await backend.db.query<{count:string}>(`select count(*)::text count from app_private.sales`)).rows[0].count).toBe('1')
    await page.getByRole('button',{name:'Continuar'}).click()
    await page.getByRole('button',{name:'Dashboard',exact:true}).filter({visible:true}).first().click()
    const menu=page.getByRole('button',{name:'Abrir menú',exact:true});if(await menu.isVisible())await menu.click()
    await page.getByRole('button',{name:'Reportes',exact:true}).first().click()
    await page.getByRole('button',{name:'Pagos integrados',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Pagos integrados y comisión'})).toBeVisible()
    await expect(page.getByText(/Un pago verificado no demuestra depósito/)).toBeVisible()
  } finally { await backend.db.close() }
})

test('uncertain action_required blocks cart/payment changes and restores through reload/PIN and two tabs', async ({page,context}) => {
  const backend = await mockPoint(page,{state:'unknown_review',startLoss:true})
  const other = await context.newPage()
  try {
    await backend.attach(other); await unlock(page); await sell(page)
    await page.getByRole('button',{name:/^Enviar a terminal/}).click()
    await expect(page.getByRole('heading',{name:'Pago por confirmar'})).toBeVisible()
    await expect(page.getByRole('button',{name:'Cerrar',exact:true})).toBeDisabled()
    await expect(page.getByRole('radio',{name:'Efectivo',exact:true})).toHaveCount(0)
    await page.reload(); await page.getByTestId('pin-input').fill(fixturePin)
    await expect(page.getByRole('button',{name:/^Recuperar cobro/})).toBeVisible()
    await page.getByRole('button',{name:/^Recuperar cobro/}).click()
    await expect(page.getByText('Consulta este cobro antes de intentar otro.')).toBeVisible()
    await unlock(other); await other.getByRole('button',{name:/^Recuperar cobro/}).click()
    await expect(other.getByRole('heading',{name:'Pago por confirmar'})).toBeVisible()
    const recovered = (await backend.execute({command:'recover'})).checkouts[0]
    await backend.apply(recovered.id,'approved_verified')
    await page.getByRole('button',{name:'Consultar estado'}).click()
    await other.getByRole('button',{name:'Consultar estado'}).click()
    await expect(page.getByRole('heading',{name:'Pago aprobado'})).toBeVisible()
    await expect(other.getByRole('heading',{name:'Pago aprobado'})).toBeVisible()
    expect(backend.remoteCharges()).toBe(1)
    expect(backend.calls.filter(call=>call.command==='start')).toHaveLength(1)
    expect(JSON.stringify(await page.evaluate(()=>Object.entries(localStorage)))).not.toContain('synthetic-account')
  } finally { await other.close(); await backend.db.close() }
})

test('rejection is definitive and backend cancellation follows provider capability', async ({page}) => {
  const backend = await mockPoint(page,{state:'processing'})
  try {
    await unlock(page); await sell(page); await page.getByRole('button',{name:/^Enviar a terminal/}).click()
    await expect(page.getByRole('heading',{name:'Procesando pago'})).toBeVisible()
    await page.getByRole('button',{name:'Cancelar cobro'}).click()
    await expect(page.getByRole('heading',{name:'Pago cancelado'})).toBeVisible()
    expect((await backend.execute({command:'merchant_report',from:'2026-01-01',to:'2026-12-31'})).paymentCount).toBe(0)
    expect(backend.remoteCharges()).toBe(1)
  } finally { await backend.db.close() }
})

for (const width of [320,390,768,1024,1440]) test(`Point setup and reports retain focus/touch/layout at ${width}px`, async ({page},info) => {
  await page.setViewportSize({width,height:900})
  const backend = await mockPoint(page,{physicalPending:true,enabled:false})
  try {
    await unlock(page)
    const menu = page.getByRole('button',{name:'Abrir menú'}); if (await menu.isVisible()) await menu.click()
    await page.getByRole('button',{name:'Vincular una terminal',exact:true}).first().click()
    await expect(page.getByRole('heading',{name:'Elige tu terminal',exact:true})).toBeFocused()
    await expect(page.getByRole('button',{name:/^SN-SYNTHETIC-01/})).toHaveAttribute('aria-pressed','true')
    await expect(page.getByText('En la terminal, confirma la sucursal y caja y activa el modo Punto de venta.')).toBeVisible()
    await expect(page.getByRole('button',{name:'Activar cobros',exact:true})).toHaveCount(0)
    expect((await backend.execute({command:'settings'})).enabled).toBe(false)
    await page.getByRole('button',{name:'Comprobar terminal',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Activa tu terminal',exact:true})).toBeFocused()
    await expect(page.getByRole('button',{name:'Activar cobros',exact:true})).toBeEnabled()
    await page.getByRole('button',{name:'Activar cobros',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Todo listo para cobrar',exact:true})).toBeVisible()
    expect((await backend.execute({command:'settings'})).enabled).toBe(true)
    const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,small:[...document.querySelectorAll('button,input,select')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.height<47}).map(e=>e.textContent)}))
    expect(geometry).toEqual({overflow:false,small:[]})
    await page.screenshot({path:`artifacts/qa/point-setup-${info.project.name}-${width}.png`,fullPage:true})
  } finally { await backend.db.close() }
})
