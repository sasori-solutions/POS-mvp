/** Real local browser -> Auth/device proof -> Edge -> PostgreSQL smoke.
 * Run after npm run dev -- --port 5183 has applied the complete current migration chain.
 * Creates one synthetic business owned by the development fixture owner and removes only that business.
 * Response-loss routes execute the actual request and drop only delivery; they never synthesize API results.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium, expect } from '@playwright/test'

const origin = process.env.TEST_APP_ORIGIN ?? 'http://127.0.0.1:5183'
assert(['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname), 'Loopback app required')
const workdir = process.env.TEST_SUPABASE_WORKDIR ?? '.local-dev'
const config = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status','--workdir',workdir,'-o','json'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}))
for (const url of [config.API_URL,config.DB_URL]) assert(['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname), 'Loopback backend required')
const project = readFileSync(`${workdir}/supabase/config.toml`,'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
assert(project, 'Own local checkout stack required')
const container = `supabase_db_${project}`
const artifacts = process.env.TEST_SCREENSHOT_DIRECTORY ?? '/tmp/pos-lean-browser'
mkdirSync(artifacts,{recursive:true})
let browser, context, page, businessId, stage='setup', lost=null
const measurements=[]
const layoutFailures=[]
const replies=[]
const runtimeErrors=[]
let currentAccess

function sql(query) { return execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At','-q'],{input:query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim() }
function uuid(value) { assert.match(value,/^[a-f0-9-]{36}$/i);return `'${value}'::uuid` }
function body(request) { try{return request.postDataJSON()}catch{return null} }
function accountResponse(action,predicate=()=>true) {
  return page.waitForResponse(response=>response.url().endsWith('/functions/v1/account') && body(response.request())?.action===action && predicate(body(response.request())),{timeout:30_000}).then(async response=>{
    const reply=await response.json()
    assert(response.ok() && reply.data,`Actual ${action} failed: ${reply.error?.code ?? response.status()}`)
    return reply.data
  })
}
function commandResponse(command,predicate=()=>true) { return accountResponse('pos',request=>request.command===command && predicate(request)) }
async function clickCommand(command,button,predicate=()=>true) { const reply=commandResponse(command,predicate);await button.click();return reply }
async function unlock() {
  const pin=page.getByLabel('Tu PIN',{exact:true})
  const selection=page.getByRole('heading',{name:'Tus negocios',exact:true})
  await expect(pin.or(selection)).toBeVisible({timeout:30_000})
  if(await selection.isVisible()) await page.getByRole('button',{name:businessId?/^Lean browser smoke/:/^Cafetería de desarrollo/}).click()
  await expect(pin).toBeVisible()
  await page.getByLabel('Tu PIN',{exact:true}).fill('123456')
  const unlocked=accountResponse('unlock',request=>!businessId || request.businessId===businessId)
  await page.getByRole('button',{name:'Entrar',exact:true}).click()
  const result=await unlocked
  currentAccess={businessId:result.business.id,operatorToken:result.operatorToken}
  await expect(page.getByRole('navigation',{name:'Navegación principal'})).toBeVisible()
}
async function navigate(name) { await page.getByRole('navigation',{name:'Navegación principal'}).getByRole('button',{name,exact:true}).click();await expect(page.getByRole('heading',{name,exact:true,level:1})).toBeVisible() }
async function cash() { await navigate('Más');await page.getByRole('button',{name:'Caja',exact:true}).click();await expect(page.getByRole('heading',{name:'Caja',exact:true,level:1})).toBeVisible() }
async function report() { await navigate('Más');const result=commandResponse('report');await page.getByRole('button',{name:'Reportes',exact:true}).click();return result }
async function api(command) { return page.evaluate(async({access,command})=>{const{accountRequest}=await import('/src/lib/account.ts');return accountRequest({action:'pos',...access,...command})},{access:currentAccess,command}) }
async function closeDialog() { await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0) }
async function openOrder(name) { await navigate('Comandas');await page.getByRole('button',{name:'Cuentas',exact:true}).click();await page.getByRole('button',{name:new RegExp(`^${name}`)}).click();await expect(page.getByRole('dialog',{name,exact:true})).toBeVisible() }
async function checkLayout(name,width) {
  await page.setViewportSize({width,height:width===390?844:900})
  const result=await page.evaluate(()=>{
    const visible=element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none' && !element.closest('[hidden]')}
    const dialog=document.querySelector('dialog[open]')
    const scope=dialog ?? document.querySelector('.pos-home-shell')
    const buttons=[...scope.querySelectorAll('button,summary')].filter(visible).map(element=>{const r=element.getBoundingClientRect();return{name:element.getAttribute('aria-label')??element.textContent.trim().slice(0,80),width:r.width,height:r.height}})
    const r=dialog?.getBoundingClientRect()
    return{overflow:document.documentElement.scrollWidth>window.innerWidth+1,dialogOverflow:dialog?dialog.scrollWidth>dialog.clientWidth+1:false,bounds:r?{left:r.left,right:r.right}:null,buttons}
  })
  if(result.overflow) layoutFailures.push(`${name} document overflows at ${width}`)
  if(result.dialogOverflow) layoutFailures.push(`${name} dialog overflows at ${width}`)
  if(result.bounds && (result.bounds.left< -1 || result.bounds.right>width+1)) layoutFailures.push(`${name} dialog outside viewport at ${width}`)
  for(const button of result.buttons) if(button.width<47.5 || button.height<47.5) layoutFailures.push(`${name} control ${button.name} at ${width} needs48px; got${button.width}×${button.height}`)
  measurements.push({name,width,controls:result.buttons.length})
  await page.screenshot({path:`${artifacts}/${name}-${width}.png`,fullPage:true})
}
async function dropNext(command,predicate=()=>true) {
  let resolve
  const delivered=new Promise(yes=>{resolve=yes})
  lost={command,predicate,resolve}
  return {committed:delivered}
}
async function recoverReload(command) {
  await expect(page.getByRole('button',{name:'Reintentar solicitud guardada',exact:true}).first()).toBeVisible()
  await page.reload()
  await unlock()
  await expect(page.getByRole('button',{name:'Reintentar solicitud guardada',exact:true}).first()).toBeVisible()
  const response=commandResponse(command)
  await page.getByRole('button',{name:'Reintentar solicitud guardada',exact:true}).first().click()
  const recovered=await response
  await expect(page.getByRole('button',{name:'Reintentar solicitud guardada',exact:true})).toHaveCount(0)
  const stored=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('pos-operations:')).map(([key,value])=>({key,value})))
  assert(stored.every(entry=>!entry.key.includes(businessId)), 'Recovered exact mutation is removed from durable retry storage')
  return recovered
}

try {
  assert.equal((await fetch(origin)).ok,true,'Own development app must be running')
  browser=await chromium.launch({headless:true})
  context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
  await context.route('**/*',route=>['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort())
  await context.route('**/functions/v1/account',async route=>{
    const request=body(route.request())
    if(lost && request?.command===lost.command && lost.predicate(request)) {
      const dropped=lost;lost=null
      const response=await route.fetch()
      const reply=await response.json()
      assert(response.ok()&&reply.data,`Real backend must commit ${dropped.command} before loss`)
      await route.abort('failed')
      dropped.resolve(reply.data)
    }else await route.continue()
  })
  page=await context.newPage()
  page.on('pageerror',error=>runtimeErrors.push(error.message))
  page.on('response',async response=>{
    const request=body(response.request())
    if(request?.command && response.url().endsWith('/functions/v1/account')) {
      try{const reply=await response.json();replies.push({command:request.command,status:response.status(),code:reply.error?.code})}catch{/* Dropped delivery is intentional. */}
    }
  })
  page.setDefaultTimeout(15_000)
  stage='development owner login'
  await page.goto(origin)
  await page.getByRole('link',{name:'Entrar en desarrollo',exact:true}).click()
  await page.getByRole('button',{name:'Entrar en desarrollo',exact:true}).click()
  await unlock()
  stage='fresh synthetic business through actual signed browser client'
  const fixture=await page.evaluate(async()=>{
    const{accountRequest}=await import('/src/lib/account.ts')
    const{supabase}=await import('/src/lib/supabase.ts')
    const result=await accountRequest({action:'create_business',name:'Lean browser smoke',businessType:'cafe',timezone:'America/Mexico_City',pin:'123456',operationId:crypto.randomUUID(),profile:{branchName:'Principal',registerName:'Caja prueba',address:'',city:'',state:'',contactPhone:'',paymentMethods:['cash','card_external','transfer']}})
    const {data}=await supabase.auth.getSession()
    localStorage.setItem(`pos-mexico-last-business:${data.session.user.id}`,result.business.id)
    return result
  })
  businessId=fixture.business.id
  currentAccess={businessId,operatorToken:fixture.operatorToken}
  await api({command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Café exacto',category:'Café',priceCents:1001})
  await page.reload();await unlock()
  await expect(page.getByText('Lean browser smoke',{exact:true})).toBeVisible()

  stage='activate and open cash'
  await cash()
  await expect(page.getByRole('button',{name:'Activar turnos',exact:true})).toBeDisabled()
  await page.getByRole('checkbox',{name:'Los dispositivos están actualizados y los registros pendientes están conciliados.',exact:true}).check()
  await clickCommand('activate_operations',page.getByRole('button',{name:'Activar turnos',exact:true}))
  await page.getByLabel('Efectivo inicial',{exact:true}).fill('100.00')
  const shift=await clickCommand('open_shift',page.getByRole('button',{name:'Abrir turno',exact:true}))
  assert.equal(shift.openingCents,10000)
  await checkLayout('cash-open',390);await checkLayout('cash-open',1024)

  stage='named table and editable order'
  await navigate('Comandas');await page.getByRole('button',{name:'Mesas',exact:true}).click()
  await page.getByLabel('Nombre',{exact:true}).fill('Mesa Prueba')
  const table=await clickCommand('save_table',page.getByRole('button',{name:'Guardar mesa',exact:true}))
  await page.getByRole('button',{name:'Abrir cuenta de mesa',exact:true}).click()
  const dialog=()=>page.getByRole('dialog')
  await dialog().getByLabel('Nombre de la cuenta',{exact:true}).fill('Cuenta Prueba')
  await dialog().getByRole('button',{name:/^Café exacto/}).click()
  await dialog().getByRole('button',{name:'Añadir Café exacto',exact:true}).click()
  await dialog().getByRole('button',{name:'Añadir Café exacto',exact:true}).click()
  await dialog().getByLabel('Nota de cocina',{exact:true}).fill('Sin azúcar')
  let order=await clickCommand('save_order',dialog().getByRole('button',{name:'Guardar cuenta',exact:true}))
  assert.equal(order.tableId,table.id);assert.equal(order.items[0].quantity,3)
  await dialog().getByRole('button',{name:'Editar artículos',exact:true}).click()
  await dialog().getByLabel('Nombre de la cuenta',{exact:true}).fill('Cuenta Prueba editada')
  order=await clickCommand('save_order',dialog().getByRole('button',{name:'Guardar cuenta',exact:true}))
  assert.equal(order.name,'Cuenta Prueba editada')
  await checkLayout('order-service',390);await checkLayout('order-service',1024)

  stage='send kitchen delta and progress preparation'
  order=await clickCommand('send_order',dialog().getByRole('button',{name:'Enviar nuevos artículos a cocina',exact:true}))
  assert.equal(order.items[0].sentQuantity,3)
  await closeDialog();await page.getByRole('button',{name:'Cocina',exact:true}).click()
  const batch=page.getByRole('region',{name:'Comanda Cuenta Prueba editada',exact:true})
  await expect(batch.getByText('Nota: Sin azúcar',{exact:true})).toBeVisible()
  await clickCommand('set_kitchen_status',batch.getByRole('button',{name:'Comenzar preparación',exact:true}))
  await clickCommand('set_kitchen_status',batch.getByRole('button',{name:'Marcar lista',exact:true}))
  await checkLayout('kitchen-ready',390);await checkLayout('kitchen-ready',1024)
  await clickCommand('set_kitchen_status',batch.getByRole('button',{name:'Marcar entregada',exact:true}))

  stage='one-cent whole-order discount and final quantity split'
  await openOrder(order.name)
  await dialog().getByText('Descuento de toda la cuenta',{exact:true}).click()
  const discount=dialog().locator('details').filter({hasText:'Descuento de toda la cuenta'})
  await discount.getByLabel('Importe',{exact:true}).fill('0.01')
  await discount.getByLabel('Motivo',{exact:true}).fill('Descuento sintético de un centavo')
  order=await clickCommand('set_order_discount',discount.getByRole('button',{name:'Aplicar descuento',exact:true}))
  assert.equal(order.totalCents,3002);assert.equal(order.discountCents,1)
  order=await clickCommand('begin_order_checkout',dialog().getByRole('button',{name:'Finalizar cuenta para cobrar',exact:true}))
  await dialog().getByRole('checkbox',{name:'Dividir por artículos al final del servicio',exact:true}).check()
  await dialog().getByLabel('Cantidad a cobrar de Café exacto',{exact:true}).fill('1')
  await dialog().getByRole('combobox',{name:/^Método de pago/}).selectOption('cash')
  await checkLayout('checkout-split',390);await checkLayout('checkout-split',1024)

  stage='prepare response loss and reload recovery'
  const preparationLoss=await dropNext('prepare_checkout')
  await dialog().getByRole('button',{name:'Preparar cobro de artículos',exact:true}).click()
  const prepared=await preparationLoss.committed
  assert.equal(prepared.totalCents,1001)
  assert.equal((await api({command:'operations'})).attempts.filter(a=>a.orderId===order.id).length,1)
  const recovered=await recoverReload('prepare_checkout')
  assert.equal(recovered.id,prepared.id);assert.equal(recovered.totalCents,prepared.totalCents)
  await openOrder(order.name)
  await clickCommand('start_checkout',dialog().getByRole('button',{name:'Iniciar cobro',exact:true}))
  await dialog().getByLabel('Efectivo recibido',{exact:true}).fill('20.00')
  await expect(dialog().getByText('Cambio: $9.99',{exact:true})).toBeVisible()
  await dialog().getByRole('checkbox',{name:'He comprobado si se recibió el pago.',exact:true}).check()
  await dialog().getByLabel('Motivo o referencia',{exact:true}).fill('Recibí billete de 20; cambio de 9.99')
  await checkLayout('cash-payment-confirm',390);await checkLayout('cash-payment-confirm',1024)

  stage='completion response loss and exact replay without duplicate money'
  const completionLoss=await dropNext('resolve_checkout',r=>r.resolution==='complete')
  await dialog().getByRole('button',{name:'Confirmar pago recibido',exact:true}).click()
  const completed=await completionLoss.committed
  assert.equal(completed.status,'completed');assert.equal(completed.id,prepared.id)
  const replayed=await recoverReload('resolve_checkout')
  assert.equal(replayed.id,completed.id);assert.equal(replayed.saleId,completed.saleId)
  assert.equal(sql(`select count(*) from app_private.sales where business_id=${uuid(businessId)};`),'1')
  assert.equal(sql(`select sum(total_cents) from app_private.sales where business_id=${uuid(businessId)};`),'1001')

  stage='frozen remaining balance paid by external card'
  await openOrder(order.name)
  await expect(dialog().getByText('Cuenta final · Artículos y descuento fijos',{exact:true})).toBeVisible()
  await expect(dialog().getByRole('button',{name:'Editar artículos',exact:true})).toHaveCount(0)
  await expect(dialog().getByText('Descuento de toda la cuenta',{exact:true})).toHaveCount(0)
  await dialog().getByRole('combobox',{name:/^Método de pago/}).selectOption('card_external')
  const remainder=await clickCommand('prepare_checkout',dialog().getByRole('button',{name:'Preparar cobro completo',exact:true}))
  assert.equal(remainder.totalCents,2001)
  await clickCommand('start_checkout',dialog().getByRole('button',{name:'Iniciar cobro',exact:true}))
  await expect(dialog().getByText('Cobra $20.01 en tu terminal externa.',{exact:true})).toBeVisible()
  await dialog().getByRole('checkbox',{name:'He comprobado si se recibió el pago.',exact:true}).check()
  await dialog().getByLabel('Motivo o referencia',{exact:true}).fill('Terminal externa verificada')
  const paid=await clickCommand('resolve_checkout',dialog().getByRole('button',{name:'Confirmar pago recibido',exact:true}),r=>r.resolution==='complete')
  assert.equal(paid.totalCents,2001)
  await expect(dialog().getByText('La mesa sigue ocupada hasta que cierres esta cuenta.',{exact:true})).toBeVisible()
  const beforeClose=await api({command:'tables'})
  assert.equal(beforeClose.tables.find(t=>t.id===table.id).orderId,order.id)
  order=await clickCommand('close_order',dialog().getByRole('button',{name:'Cerrar cuenta y liberar mesa',exact:true}))
  assert.equal(order.status,'closed')
  assert.equal((await api({command:'tables'})).tables.find(t=>t.id===table.id).orderId,null)
  await closeDialog()

  stage='cash closing freezes money and reveals expected only after count'
  await cash()
  const counting=await clickCommand('begin_shift_close',page.getByRole('button',{name:'Detener caja e iniciar conteo',exact:true}))
  assert.equal(counting.status,'closing');assert.equal(counting.expectedCents,null)
  await expect(page.getByRole('heading',{name:'Contar efectivo',exact:true})).toBeVisible()
  await expect(page.getByText('Esperado',{exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'Guardar movimiento',exact:true})).toHaveCount(0)
  await expect(page.getByText(/Los cobros, devoluciones y movimientos están detenidos/)).toBeVisible()
  await checkLayout('cash-count',390);await checkLayout('cash-count',1024)
  await navigate('Ventas')
  await page.getByRole('button',{name:new RegExp(`^Ver venta ${completed.saleId.slice(0,8)},`)}).click()
  await dialog().getByText('Devolver venta completa',{exact:true}).click()
  await dialog().getByLabel('Motivo',{exact:true}).fill('Conteo activo: devolución bloqueada')
  await expect(dialog().getByRole('button',{name:'Preparar devolución completa',exact:true})).toBeDisabled()
  await expect(dialog().getByText('Abre o reanuda el turno en Caja antes de devolver dinero.',{exact:true})).toBeVisible()
  await checkLayout('refund-blocked-during-count',390);await checkLayout('refund-blocked-during-count',1024)
  await closeDialog();await cash()
  await page.getByLabel('Efectivo contado',{exact:true}).fill('110.01')
  const closed=await clickCommand('close_shift',page.getByRole('button',{name:'Guardar conteo y cerrar',exact:true}))
  assert.equal(closed.expectedCents,11001);assert.equal(closed.differenceCents,0)
  await expect(page.getByText('Esperado',{exact:true})).toBeVisible()
  const beforeReversal=await report()
  assert.equal(beforeReversal.salesCents,3002);assert.equal(beforeReversal.discountCents,1);assert.equal(beforeReversal.saleCount,2)
  await checkLayout('report-before-reversal',390);await checkLayout('report-before-reversal',1024)

  stage='reverse original cash sale in the currently open new shift'
  await cash();await page.getByLabel('Efectivo inicial',{exact:true}).fill('0.00')
  const newShift=await clickCommand('open_shift',page.getByRole('button',{name:'Abrir turno',exact:true}))
  assert.notEqual(newShift.id,shift.id)
  await navigate('Ventas')
  await page.getByRole('button',{name:new RegExp(`^Ver venta ${completed.saleId.slice(0,8)},`)}).click()
  await dialog().getByText('Devolver venta completa',{exact:true}).click()
  await dialog().getByLabel('Motivo',{exact:true}).fill('Devolución sintética en nuevo turno')
  const reversal=await clickCommand('prepare_reversal',dialog().getByRole('button',{name:'Preparar devolución completa',exact:true}))
  assert.equal(reversal.shiftId,newShift.id);assert.equal(reversal.totalCents,1001)
  await clickCommand('start_checkout',dialog().getByRole('button',{name:'Iniciar devolución',exact:true}))
  await dialog().getByRole('checkbox',{name:'He comprobado si se entregó la devolución.',exact:true}).check()
  await dialog().getByLabel('Motivo o referencia',{exact:true}).fill('Efectivo entregado una vez')
  await clickCommand('resolve_checkout',dialog().getByRole('button',{name:'Confirmar devolución entregada',exact:true}),r=>r.resolution==='complete')
  await expect(dialog().getByText(/Devolución registrada\./)).toBeVisible()
  await checkLayout('reversal-completed',390);await checkLayout('reversal-completed',1024)
  await closeDialog()
  const afterReversal=await report()
  assert.equal(afterReversal.salesCents,3002);assert.equal(afterReversal.reversalCents,1001);assert.equal(afterReversal.netCents,2001)
  assert.equal(sql(`select count(*) from app_private.sales where business_id=${uuid(businessId)};`),'2')
  assert.equal(sql(`select count(*) from app_private.sale_reversals where business_id=${uuid(businessId)};`),'1')
  assert.equal(sql(`select status from app_private.operational_orders where business_id=${uuid(businessId)} and id=${uuid(order.id)};`),'closed')

  stage='queued cancellation keeps only effective kitchen work and independent notices'
  const product=(await api({command:'catalog'})).products.find(item=>item.name==='Café exacto')
  assert(product,'Synthetic product remains available for kitchen fixture')
  async function queued(name,quantity) {
    const saved=await api({command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name,tableId:null,items:[{lineId:randomUUID(),productId:product.id,version:product.version,unitPriceCents:product.priceCents,quantity,note:'Sin azúcar'}]})
    return api({command:'send_order',operationId:randomUUID(),orderId:saved.id,expectedRevision:saved.revision})
  }
  let partial=await queued('Comanda parcial sintética',3)
  partial=await api({command:'begin_order_checkout',operationId:randomUUID(),orderId:partial.id,expectedRevision:partial.revision})
  let firstUnit=await api({command:'prepare_checkout',operationId:randomUUID(),orderId:partial.id,expectedRevision:partial.revision,items:[{lineId:partial.items[0].lineId,quantity:1}],paymentMethod:'cash'})
  firstUnit=await api({command:'start_checkout',operationId:randomUUID(),attemptId:firstUnit.id,expectedRevision:firstUnit.revision})
  await api({command:'resolve_checkout',operationId:randomUUID(),attemptId:firstUnit.id,expectedRevision:firstUnit.revision,resolution:'complete',confirmed:true,reason:'Una unidad pagada antes de cancelar el resto en cola'})
  partial=await api({command:'order',orderId:partial.id})
  assert.equal(partial.items[0].paidQuantity,1)
  partial=await api({command:'cancel_order',operationId:randomUUID(),orderId:partial.id,expectedRevision:partial.revision,reason:'Dos unidades sin preparar canceladas'})
  let fully=await queued('Comanda cancelada sintética',2)
  fully=await api({command:'cancel_order',operationId:randomUUID(),orderId:fully.id,expectedRevision:fully.revision,reason:'Todo el pedido en cola cancelado'})
  const kitchen=(await api({command:'kitchen'})).batches
  const partialBatch=kitchen.find(item=>item.orderId===partial.id&&item.kind==='items')
  const cancelledBatch=kitchen.find(item=>item.orderId===fully.id&&item.kind==='items')
  assert.equal(partialBatch.items[0].quantity,3);assert.equal(partialBatch.items[0].cancelledQuantity,2);assert.equal(partialBatch.fullyCancelled,false)
  assert.equal(cancelledBatch.items[0].quantity,2);assert.equal(cancelledBatch.items[0].cancelledQuantity,2);assert.equal(cancelledBatch.fullyCancelled,true)
  await navigate('Comandas');await page.getByRole('button',{name:'Cocina',exact:true}).click()
  const partialCards=page.getByRole('region',{name:`Comanda ${partial.name}`,exact:true})
  const partialWork=partialCards.filter({has:page.getByText('Cantidad original: 3 · Canceladas: 2',{exact:true})})
  const fullCards=page.getByRole('region',{name:`Comanda ${fully.name}`,exact:true})
  const fullWork=fullCards.filter({has:page.getByText('Cantidad original: 2 · Canceladas: 2',{exact:true})})
  await expect(partialWork.getByText('1 × Café exacto',{exact:true})).toBeVisible()
  await expect(partialWork.getByRole('button',{name:'Comenzar preparación',exact:true})).toBeVisible()
  await expect(fullWork).toHaveCount(0)
  await checkLayout('kitchen-cancelled-active',390);await checkLayout('kitchen-cancelled-active',1024)
  const partialNotice=partialCards.filter({has:page.getByRole('button',{name:'Confirmar aviso',exact:true})})
  const acknowledged=await clickCommand('set_kitchen_status',partialNotice.getByRole('button',{name:'Confirmar aviso',exact:true}))
  assert.equal(acknowledged.kind,'cancellation');assert.equal(acknowledged.status,'delivered')
  await expect(partialWork.getByText('1 × Café exacto',{exact:true})).toBeVisible()
  await expect(partialNotice).toHaveCount(0)
  await clickCommand('set_kitchen_status',fullCards.getByRole('button',{name:'Confirmar aviso',exact:true}))
  await expect(fullCards).toHaveCount(0)
  await page.getByRole('checkbox',{name:'Mostrar entregadas y canceladas',exact:true}).check()
  await expect(fullWork.getByText('Cancelada',{exact:true})).toBeVisible()
  await expect(fullWork.getByText('0 × Café exacto',{exact:true})).toBeVisible()
  await expect(fullWork.getByRole('button')).toHaveCount(0)
  await expect(partialCards.getByText('Cancelación · Entregada',{exact:true})).toBeVisible()
  await checkLayout('kitchen-cancelled-history',390);await checkLayout('kitchen-cancelled-history',1024)
  const effective=await clickCommand('set_kitchen_status',partialWork.getByRole('button',{name:'Comenzar preparación',exact:true}))
  assert.equal(effective.status,'preparing');assert.equal(effective.items[0].quantity-effective.items[0].cancelledQuantity,1)
  assert.equal(effective.items[0].quantity,3,'Original sent snapshot stays intact')
  assert.equal(runtimeErrors.length,0,'No browser runtime exceptions')
  const unexpected=replies.filter(r=>r.status>=400)
  assert.deepEqual(unexpected,[],'All actual server responses must succeed apart from intentional response delivery loss')
  assert.deepEqual(layoutFailures,[],'Every visible navigation and operation control must be at least48px without overflow')
  console.log(JSON.stringify({passed:true,workflow:'real local Auth/Edge/Postgres',checks:measurements,responseLoss:['prepare_checkout','resolve_checkout'],cashCents:1001,cardCents:2001,reversalCents:1001,kitchenCancellation:{originalQuantity:3,paidQuantity:1,cancelledQuantity:2,quantityToPrepare:1,fullyCancelledQuantity:2,noticeAckIndependent:true},screenshots:artifacts}))
} catch(error) {
  if(page) await page.screenshot({path:`${artifacts}/failure.png`,fullPage:true}).catch(()=>{})
  console.error(JSON.stringify({failed:true,stage,message:error.message,layoutFailures,screenshots:artifacts}))
  process.exitCode=1
} finally {
  if(context) await context.close()
  if(browser) await browser.close()
  if(businessId) {
    sql(`delete from app_private.businesses where id=${uuid(businessId)};`)
    assert.equal(sql(`select count(*) from app_private.checkout_attempts where business_id=${uuid(businessId)};`),'0','Direct business cascade removes synthetic reversal attempts too')
  }
}
