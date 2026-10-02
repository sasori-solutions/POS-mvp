import { emptyDetails } from '../../src/lib/product-details'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product, Sale, SaleSummary } from '../../src/lib/pos-contracts'
import { signedRequest } from './device-proof-fixture'

type Identity = { userId: string; token: string }
type Operator = { business: { id: string; employee: { id: string } }; operatorToken: string }
type Reply<T> = { status: number; body: { data?: T; error?: { code: string } } }
const config = localConfig()
const users: string[] = []
const businesses: string[] = []
const pin = '583927'
let admin: SupabaseClient
let owner: Identity
let outsider: Identity
let employee: Identity

describe.skipIf(!config)('products and sales through real local Auth, signed Edge requests and PostgreSQL', () => {
  beforeAll(async () => {
    admin = client(config!.serviceRoleKey)
    ;[owner, outsider, employee] = await Promise.all([identity(), identity(), identity()])
    expect((await call(owner, { action: 'status' })).status).toBe(200)
  }, 60_000)
  afterAll(async () => {
    for (const id of users) {
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) throw error
    }
    if (businesses.length) sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)
  }, 60_000)

  it('persists catalog changes, all methods and immutable receipts through the secure dispatcher', async () => {
    const operator = await business()
    const product = await save(operator)
    for (const method of ['cash', 'card_external', 'transfer'] as const) {
      const receipt = data(await pos<Sale>(operator, sale(product, 3, method)))
      expect(receipt.totalCents).toBe(3003)
      expect(receipt.paymentMethod).toBe(method)
      expect(receipt.items[0]).toMatchObject({ name: product.name, quantity: 3, unitPriceCents: 1001 })
    }
    const edited = data(await pos<Product>(operator, { command: 'save_product', operationId: randomUUID(), productId: product.id, expectedVersion: 1, name: 'Nombre nuevo', category: 'Pan', priceCents: 9000 }))
    expect(edited.version).toBe(2)
    const inactive = data(await pos<Product>(operator, { command: 'set_product_active', operationId: randomUUID(), productId: product.id, expectedVersion: 2, active: false }))
    expect(inactive.active).toBe(false)
    const history = data(await pos<{ sales: SaleSummary[] }>(operator, { command: 'sales', cursor: null }))
    expect(history.sales).toHaveLength(3)
    expect(data(await pos<Sale>(operator, { command: 'sale', saleId: history.sales[0].id })).items[0].unitPriceCents).toBe(1001)
  })

  it('deletes products through signed Edge with scoped permissions and preserved sale history', async () => {
    const operator = await business()
    const cashier = await cashierFor(operator)
    const foreignOperator = await business()
    const product = await save(operator)
    const saleRequest = sale(product)
    const receipt = data(await pos<Sale>(cashier, saleRequest, employee))
    const command = { command: 'delete_product' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version }
    expect((await pos(cashier, command, employee)).body.error?.code).toBe('PERMISSION_DENIED')
    expect((await pos(foreignOperator, command)).body.error?.code).toBe('PRODUCT_CHANGED')
    const replies = await Promise.all([pos(operator, command), pos(operator, command)])
    for (const reply of replies) expect(data(reply)).toEqual({ id: product.id, deleted: true })
    expect(sql(`select version from app_private.products where id=${uuid(product.id)};`).trim()).toBe('2')
    for (const [actor, identity] of [[operator, owner], [cashier, employee]] as const)
      expect(data(await pos<{ products: Product[] }>(actor, { command: 'catalog' }, identity)).products).toEqual([])
    expect(data(await pos<Sale>(cashier, saleRequest, employee))).toEqual(receipt)
    expect(data(await pos<Sale>(operator, { command: 'sale', saleId: receipt.id }))).toEqual(receipt)
    expect((await pos(cashier, sale(product), employee)).body.error?.code).toBe('PRODUCT_UNAVAILABLE')
    expect((await pos(operator, { command: 'set_product_active', operationId: randomUUID(), productId: product.id, expectedVersion: 2, active: true })).body.error?.code).toBe('PRODUCT_CHANGED')
    data(await call(owner, { action: 'lock', ...args(operator) }))
    expect((await pos(operator, command)).body.error?.code).toBe('SESSION_INVALID')
  }, 30000)

  it('serializes product deletion against concurrent edits and new sales', async () => {
    const operator = await business()
    const product = await save(operator)
    const command = { command: 'delete_product' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version }
    const competing = { command: 'save_product' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version, name: 'Edición concurrente', category: product.category, priceCents: product.priceCents }
    const edits = await Promise.all([pos(operator, command), pos(operator, competing)])
    expect(edits.map(r => r.status).sort()).toEqual([200, 409])
    expect(edits.find(r => r.status === 409)?.body.error?.code).toBe('PRODUCT_CHANGED')
    const next = await save(operator)
    const saleRequest = sale(next)
    const replies = await Promise.all([
      pos(operator, { ...command, operationId: randomUUID(), productId: next.id, expectedVersion: next.version }),
      pos<Sale>(operator, saleRequest),
    ])
    expect(replies[0].status).toBe(200)
    expect([200, 409]).toContain(replies[1].status)
    if (replies[1].status === 200) expect(data(await pos<Sale>(operator, saleRequest))).toEqual(replies[1].body.data)
    else expect(replies[1].body.error?.code).toBe('PRODUCT_UNAVAILABLE')
    expect(count('sales', operator)).toBe(replies[1].status === 200 ? 1 : 0)
    expect(data(await pos<{ products: Product[] }>(operator, { command: 'catalog' })).products.some(p => p.id === next.id)).toBe(false)
  }, 30000)

  it('serializes simultaneous identical sale submissions into one accepted sale', async () => {
    const operator = await business(); const product = await save(operator); const command = sale(product)
    const replies = await Promise.all(Array.from({ length: 4 }, () => pos<Sale>(operator, command)))
    expect(replies.map(reply => reply.status)).toEqual([200, 200, 200, 200])
    expect(new Set(replies.map(reply => reply.body.data!.id)).size).toBe(1)
    expect(count('sales', operator)).toBe(1)
    expect(count('sale_items', operator)).toBe(1)
    sql(`update app_private.products set active=false,price_cents=9000,version=version+1 where id=${uuid(product.id)};`)
    expect(data(await pos<Sale>(operator, command))).toEqual(replies[0].body.data)
  })

  it('rejects concurrent conflicting reuse of a financial operation without a second record', async () => {
    const operator = await business(); const product = await save(operator); const command = sale(product)
    const changed = { ...sale(product, 2), operationId: command.operationId }
    const replies = await Promise.all([pos<Sale>(operator, command), pos<Sale>(operator, changed)])
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 409])
    expect(replies.find(reply => reply.status === 409)!.body.error!.code).toBe('OPERATION_CONFLICT')
    expect(count('sales', operator)).toBe(1)
  })

  it('enforces tenant, cashier history and current browser proof on financial commands', async () => {
    const operator = await business(); const product = await save(operator)
    const cashier = await cashierFor(operator)
    const ownerSale = data(await pos<Sale>(operator, sale(product)))
    const cashierSale = data(await pos<Sale>(cashier, sale(product), employee))
    expect(data(await pos<{ sales: SaleSummary[] }>(cashier, { command: 'sales', cursor: null }, employee)).sales.map(item => item.id)).toEqual([cashierSale.id])
    expect((await pos(cashier, { command: 'sale', saleId: ownerSale.id }, employee)).body.error!.code).toBe('SALE_NOT_FOUND')
    expect((await pos(operator, { command: 'catalog' }, outsider)).body.error!.code).toBe('BUSINESS_ACCESS_DENIED')
    const unsigned = await call(employee, { action: 'pos', ...args(cashier), command: 'catalog' }, false)
    expect(unsigned.body.error!.code).toBe('DEVICE_LINK_REQUIRED')
    expect((await pos(cashier, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Forbidden', category: '', priceCents: 100 }, employee)).body.error!.code).toBe('PERMISSION_DENIED')
  })

  it('rejects an erased employee sale replay after a fresh invitation while preserving financial history', async () => {
    const operator = await business()
    const original = await cashierFor(operator)
    const product = await save(operator)
    const command = sale(product)
    const receipt = data(await pos<Sale>(original, command, employee))
    data(await call(owner, { action: 'delete_employee', ...args(operator), employeeId: original.business.employee.id, operationId: randomUUID() }))
    expect(sql(`select actor_id is null from app_private.pos_operations where business_id=${uuid(operator.business.id)} and operation_id=${uuid(command.operationId)};`).trim()).toBe('t')
    expect((await pos(original, command, employee)).status).toBeGreaterThanOrEqual(400)
    const current = await cashierFor(operator)
    expect(current.business.employee.id).not.toBe(original.business.employee.id)
    expect((await pos(current, command, employee)).body.error?.code).toBe('OPERATION_CONFLICT')
    expect((await pos(operator, command)).body.error?.code).toBe('OPERATION_CONFLICT')
    expect(data(await pos<Sale>(operator, { command: 'sale', saleId: receipt.id }))).toEqual(receipt)
    expect(count('sales', operator)).toBe(1)
  })

  it('keeps a cashier sale consistent when product deactivation races registration', async () => {
    const operator = await business(); const cashier = await cashierFor(operator); const product = await save(operator)
    const [registration, deactivation] = await Promise.all([
      pos<Sale>(cashier, sale(product), employee),
      pos<Product>(operator, { command: 'set_product_active', productId: product.id, expectedVersion: product.version, active: false, operationId: randomUUID() }),
    ])
    expect(deactivation.status).toBe(200)
    expect([200, 409]).toContain(registration.status)
    if (registration.status === 200) expect(registration.body.data!.items[0]).toMatchObject({ unitPriceCents: 1001, quantity: 1, totalCents: 1001 })
    else expect(registration.body.error!.code).toBe('PRODUCT_UNAVAILABLE')
    expect(count('sales', operator)).toBe(registration.status === 200 ? 1 : 0)
    expect(count('sale_items', operator)).toBe(registration.status === 200 ? 1 : 0)
  })

  it('registers on a paired device without an owner JWT and rejects revoked credentials', async () => {
    const operator = await business(); const product = await save(operator)
    const pairing = data(await call<{ pairingCode: string }>(owner, { action: 'create_pairing_code', ...args(operator), operationId: randomUUID() }))
    const device = data(await call<{ deviceToken: string; device: { id: string } }>(null, { action: 'device_pair', pairingCode: pairing.pairingCode, deviceName: 'Caja sintética', operationId: randomUUID() }))
    const unlocked = data(await call<Operator>(null, { action: 'device_unlock', deviceToken: device.deviceToken, employeeId: operator.business.employee.id, pin }))
    const request = { action: 'device_pos', deviceToken: device.deviceToken, operatorToken: unlocked.operatorToken, ...sale(product) }
    expect(data(await call<Sale>(null, request)).totalCents).toBe(1001)
    expect((await call(null, { ...request, deviceToken: '00'.repeat(32) })).body.error!.code).toBe('DEVICE_REVOKED')
    data(await call(owner, { action: 'device_lock', deviceToken: device.deviceToken, operatorToken: unlocked.operatorToken }))
    expect((await call(null, { action: 'device_pos', deviceToken: device.deviceToken, operatorToken: unlocked.operatorToken, command: 'catalog' })).status).toBeGreaterThanOrEqual(400)
  })

  it('rolls back a persistence failure and accepts a safe retry after recovery', async () => {
    const operator = await business(); const product = await save(operator); const command = sale(product)
    sql(`create function app_private.pos_test_failure() returns trigger language plpgsql as $$ begin if new.business_id=${uuid(operator.business.id)} then raise exception 'Synthetic write failure'; end if; return new; end; $$; create trigger pos_test_failure before insert on app_private.sale_items for each row execute function app_private.pos_test_failure();`)
    try {
      expect((await pos(operator, command)).status).toBe(500)
      expect(count('sales', operator)).toBe(0)
      expect(count('sale_items', operator)).toBe(0)
      expect(sql(`select count(*) from app_private.pos_operations where business_id=${uuid(operator.business.id)} and operation_id=${uuid(command.operationId)};`).trim()).toBe('0')
    } finally { sql('drop trigger pos_test_failure on app_private.sale_items; drop function app_private.pos_test_failure();') }
    expect(data(await pos<Sale>(operator, command)).totalCents).toBe(1001)
    expect(count('sales', operator)).toBe(1)
  })
  it('persists expanded details and exact selections through Edge and serializes limited inventory', async () => {
    const operator = await business(), variationId = randomUUID(), modifierId = randomUUID()
    const details = { ...emptyDetails(), trackStock:true,stock:2,taxBps:1600,taxTreatment:'vat_16' as const,description:'Producto sintético',variations:[{id:variationId,name:'Grande',priceCents:5801,sku:'TEST-G',barcode:'',soldOut:false}],modifierSets:[{id:randomUUID(),name:'Leche',min:1,max:1,options:[{id:modifierId,name:'Avena',priceCents:101}]}] }
    const imageId = randomUUID()
    const upload = { command:'upload_product_image' as const, operationId:randomUUID(),imageId,part:0,parts:1,data:'/9j/2f/Z' }
    expect(data(await pos(operator,upload))).toMatchObject({imageId,complete:true})
    const product = data(await pos<Product>(operator,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Latte de prueba',category:'Café',priceCents:5801,details:{...details,imageId}}))
    expect(product.details?.description).toBe(details.description)
    expect(product.image).toBe('data:image/jpeg;base64,/9j/2f/Z')
    const selection = {variationId,modifierIds:[modifierId],variablePriceCents:null}
    const command = {...sale(product,2),items:[{productId:product.id,quantity:2,unitPriceCents:5902,version:product.version,selection}],totalCents:11804}
    const competing = {...command,operationId:randomUUID()}
    const replies = await Promise.all([pos<Sale>(operator,command),pos<Sale>(operator,competing)])
    expect(replies.map(r=>r.status).sort()).toEqual([200,409])
    const accepted = replies.find(r=>r.status===200)!
    expect(accepted.body.data?.items[0]).toMatchObject({selectionLabel:'Grande, Avena',unitPriceCents:5902,taxCents:1628,taxTreatment:'vat_16',taxBps:1600})
    expect(count('sales',operator)).toBe(1)
    const stock = data(await pos<{products:Product[]}>(operator,{command:'catalog'})).products.find(p=>p.id===product.id)!
    expect(stock.details?.stock).toBe(0)
    expect(stock.version).toBe(product.version+1)
    const retryCommand = replies[0].status===200 ? command : competing
    expect(data(await pos<Sale>(operator,retryCommand))).toEqual(accepted.body.data)
    const availability = {command:'set_product_sold_out' as const,operationId:randomUUID(),productId:stock.id,expectedVersion:stock.version,soldOut:true}
    const unavailable = data(await pos<Product>(operator,availability))
    expect(unavailable.details?.soldOut).toBe(true)
    expect(data(await pos(operator,availability))).toEqual(unavailable)
  },30000)


  it('validates and retains mixed IVA classifications through real Edge and immutable history', async () => {
    const operator=await business()
    const products:Product[]=[]
    const rates=[['vat_16',1600,11600],['vat_0',0,2500],['exempt',0,3000],['border_8',800,10800]] as const
    for(const [taxTreatment,taxBps,priceCents] of rates) products.push(data(await pos<Product>(operator,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'IVA sintético',category:'',priceCents,details:{...emptyDetails(),taxTreatment,taxBps}})))
    const command={command:'complete_sale' as const,operationId:randomUUID(),paymentMethod:'cash' as const,totalCents:27900,items:products.map(p=>({productId:p.id,quantity:1,unitPriceCents:p.priceCents,version:p.version}))}
    const receipt=data(await pos<Sale>(operator,command))
    expect(receipt.items.reduce((sum,item)=>sum+(item.taxCents??0),0)).toBe(2400)
    expect(new Set(receipt.items.map(item=>item.taxTreatment))).toEqual(new Set(rates.map(row=>row[0])))
    expect((await pos(operator,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Invalid tax',category:'',priceCents:11600,details:{...emptyDetails(),taxTreatment:'exempt',taxBps:1600}})).body.error?.code).toBe('VALIDATION_ERROR')
    const p=products[0]
    data(await pos(operator,{command:'save_product',operationId:randomUUID(),productId:p.id,expectedVersion:p.version,name:p.name,category:'',priceCents:p.priceCents,details:{...emptyDetails(),taxTreatment:'exempt',taxBps:0}}))
    expect(data(await pos<Sale>(operator,command))).toEqual(receipt)
    expect(data(await pos<Sale>(operator,{command:'sale',saleId:receipt.id}))).toEqual(receipt)
  })

})

function localConfig() {
  let status: Record<string, string>
  if (process.env.TEST_SUPABASE_URL) status = { API_URL: process.env.TEST_SUPABASE_URL, ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? '', SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '' }
  else {
    try { status = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
    catch { return null }
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(status.API_URL).hostname)) throw new Error('Financial tests refuse non-loopback services')
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Local integration credentials unavailable')
  return { url: status.API_URL, anonKey: status.ANON_KEY, serviceRoleKey: status.SERVICE_ROLE_KEY, dbContainer: process.env.TEST_LOCAL_DB_CONTAINER ?? 'supabase_db_pos-mexico-pwa' }
}
function client(key: string) { return createClient(config!.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) }
async function identity(): Promise<Identity> {
  const email = `pos-integration-${randomUUID()}@example.test`; const password = `local-only-${randomUUID()}-Aa9!`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw created.error
  users.push(created.data.user.id)
  const login = await client(config!.anonKey).auth.signInWithPassword({ email, password }); if (login.error) throw login.error
  return { userId: created.data.user.id, token: login.data.session!.access_token }
}
async function business() {
  const operator = data(await call<Operator>(owner, { action: 'create_business', name: 'POS sintético', businessType: 'cafe', timezone: 'America/Mexico_City', pin, operationId: randomUUID(), profile: { branchName: 'Principal', registerName: 'Caja 1', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash', 'card_external', 'transfer'] } }))
  businesses.push(operator.business.id); return operator
}
function args(operator: Operator) { return { businessId: operator.business.id, operatorToken: operator.operatorToken } }
async function cashierFor(operator: Operator) {
  const person = data(await call<{ invitation: { invitationCode: string } }>(owner, { action: 'create_employee', ...args(operator), name: 'Caja sintética', role: 'cashier', pin: null, inviteWithGoogle: true, operationId: randomUUID() }))
  return data(await call<Operator>(employee, { action: 'accept_invitation', invitationCode: person.invitation.invitationCode, pin: '024680', operationId: randomUUID() }))
}
async function save(operator: Operator) { return data(await pos<Product>(operator, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: 'Café', priceCents: 1001 })) }
function sale(product: Product, quantity = 1, paymentMethod: Sale['paymentMethod'] = 'card_external'): Extract<PosCommand, { command: 'complete_sale' }> { return { command: 'complete_sale', operationId: randomUUID(), items: [{ productId: product.id, quantity, unitPriceCents: product.priceCents, version: product.version }], totalCents: product.priceCents * quantity, paymentMethod } }
function pos<T = unknown>(operator: Operator, command: PosCommand, identity = owner) { return call<T>(identity, { action: 'pos', ...args(operator), ...command }) }
async function call<T = unknown>(identity: Identity | null, request: Record<string, unknown>, sign = true): Promise<Reply<T>> {
  const response = await fetch(`${config!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey, ...(identity ? { authorization: `Bearer ${identity.token}` } : {}) }, body: JSON.stringify(sign ? await signedRequest(identity?.userId, request) : request) })
  return { status: response.status, body: await response.json() }
}
function data<T>(reply: Reply<T>): T { expect(reply.status, JSON.stringify(reply.body.error)).toBe(200); expect(reply.body.data).toBeDefined(); return reply.body.data! }
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid synthetic UUID'); return `'${value}'::uuid` }
function sql(query: string) { return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { input: query, encoding: 'utf8' }) }
function count(table: 'sales' | 'sale_items', operator: Operator) { return Number(sql(`select count(*) from app_private.${table} where business_id=${uuid(operator.business.id)};`).trim()) }
