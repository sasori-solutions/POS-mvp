import { emptyDetails } from '../../src/lib/product-details'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product, Sale, SaleSummary } from '../../src/lib/pos-contracts'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
let legacyActor: Actor
let legacyPinHash: string
let legacyTaxSale: Sale
let legacyTaxCommand: PosCommand
let legacyInventoryProduct: Product
let legacyEmptyInventoryProduct: Product

describe('real PostgreSQL migrations and financial transactions (embedded, synthetic Auth rows)', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions;
      create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    const migrations = readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()
    const posMigration = '20261002001000_products_sales.sql'
    for (const file of migrations.filter(name => name < posMigration)) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    legacyActor = await newActor()
    const credential = await db.query<{ pin_hash: string }>(`insert into app_private.operator_credentials(business_id,user_id,pin_hash,failed_attempts) values($1,$2,extensions.crypt('024680',extensions.gen_salt('bf',4)),2) returning pin_hash`, [legacyActor.businessId, legacyActor.userId])
    legacyPinHash = credential.rows[0].pin_hash
    const vatMigration = '20261002001400_mvp_mexican_vat.sql'
    for (const file of migrations.filter(name => name >= posMigration && name < vatMigration)) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    const legacyProduct = await execute<Product>(legacyActor,{...newProduct(),priceCents:11600,details:{...emptyDetails(),taxBps:1600,customerName:'Alias anterior'}})
    legacyTaxCommand = saleCommand(legacyProduct,1)
    legacyTaxSale = await execute<Sale>(legacyActor,legacyTaxCommand)
    for (const file of migrations.filter(name => name >= vatMigration)) {
      if (file === '20261002001900_manual_availability.sql') {
        legacyInventoryProduct = await execute<Product>(legacyActor, {
          ...newProduct(), details: { ...emptyDetails(), trackStock: true, stock: 3, lowStockAlert: 7 },
        })
        legacyEmptyInventoryProduct = await execute<Product>(legacyActor, {
          ...newProduct(), details: { ...emptyDetails(), trackStock: true, stock: 0, lowStockAlert: 7 },
        })
      }
      await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('upgrades existing account data and preserves PIN hashes, counters and operator access', async () => {
    const credential = await db.query<{ pin_hash: string; failed_attempts: number }>('select pin_hash,failed_attempts from app_private.operator_credentials where business_id=$1 and user_id=$2', [legacyActor.businessId, legacyActor.userId])
    expect(credential.rows[0]).toEqual({ pin_hash: legacyPinHash, failed_attempts: 2 })
    const context = await db.query<{ result: { data: { business: { id: string; role: string } } } }>("select public.account_secure($1,$2,'context',$3::jsonb) as result", [legacyActor.userId, legacyActor.sessionId, JSON.stringify({ businessId: legacyActor.businessId, operatorToken: legacyActor.token })])
    expect(context.rows[0].result.data.business).toMatchObject({ id: legacyActor.businessId, role: 'owner' })
    expect(await execute(legacyActor, { command: 'catalog' })).toHaveProperty('products')
  })


  it('upgrades recorded IVA without reconstructing rates from current products or changing accepted replay', async () => {
    const sale = await execute<Sale>(legacyActor,{command:'sale',saleId:legacyTaxSale.id})
    expect(sale.totalCents).toBe(11600)
    expect(sale.items[0]).toMatchObject({name:'Alias anterior',taxCents:1600,taxTreatment:'legacy',taxBps:null})
    expect(await execute(legacyActor,legacyTaxCommand)).toEqual(legacyTaxSale)
    const rows=await db.query<{tax_treatment:null;tax_bps:null}>('select tax_treatment,tax_bps from app_private.sale_items where sale_id=$1',[legacyTaxSale.id])
    expect(rows.rows[0]).toEqual({tax_treatment:null,tax_bps:null})
  })
  it('validates explicit Mexican IVA and stores mixed-rate snapshots atomically through later edits/retries', async () => {
    const actor=await newActor()
    const settings=[['vat_16',1600,11600,1600],['border_8',800,10800,800],['vat_0',0,2500,0],['exempt',0,3000,0]] as const
    const products=[] as Product[]
    for(const [taxTreatment,taxBps,priceCents] of settings) products.push(await execute<Product>(actor,{...newProduct(),priceCents,details:{...emptyDetails(),taxTreatment,taxBps,customerName:'Unused customer display'}}))
    const command={command:'complete_sale' as const,operationId:randomUUID(),paymentMethod:'cash' as const,totalCents:27900,items:products.map(p=>({productId:p.id,quantity:1,unitPriceCents:p.priceCents,version:p.version}))}
    const receipt=await execute<Sale>(actor,command)
    for(const [i,p] of products.entries()) expect(receipt.items.find(item=>item.productId===p.id)).toMatchObject({name:p.name,taxTreatment:settings[i][0],taxBps:settings[i][1],taxCents:settings[i][3]})
    expect(receipt.items.reduce((sum,item)=>sum+(item.taxCents??0),0)).toBe(2400)
    const p=products[0]
    await execute(actor,{...newProduct(),productId:p.id,expectedVersion:p.version,operationId:randomUUID(),details:{...emptyDetails(),taxTreatment:'exempt',taxBps:0}})
    expect(await execute(actor,command)).toEqual(receipt)
    expect(await execute(actor,{command:'sale',saleId:receipt.id})).toEqual(receipt)
    for(const details of [{...emptyDetails(),taxTreatment:'vat_16' as const,taxBps:0},{...emptyDetails(),taxTreatment:'exempt' as const,taxBps:800}])
      await expect(execute(actor,{...newProduct(),details})).rejects.toThrow('VALIDATION_ERROR')
    for (const role of ['anon','authenticated']) for (const fn of ['app_private.product_tax_treatment(jsonb)','app_private.included_vat_cents(bigint,integer)'])
      expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,fn])).rows[0].allowed).toBe(false)
  })

  it('rejects replay by another actor after the original employee is permanently removed', async () => {
    const owner = await newActor()
    const original = await newActor('cashier', owner.businessId)
    const current = await newActor('cashier', owner.businessId)
    const product = await execute<Product>(owner, newProduct())
    const command = saleCommand(product)
    const receipt = await execute<Sale>(original, command)
    await db.query('delete from app_private.employees where id=$1', [original.employeeId])
    expect((await db.query<{ actor_id: null }>('select actor_id from app_private.pos_operations where operation_id=$1', [command.operationId])).rows[0].actor_id).toBeNull()
    await expect(execute(current, command)).rejects.toThrow('OPERATION_CONFLICT')
    await expect(execute(original, command)).rejects.toThrow()
    expect(await execute(owner, { command: 'sale', saleId: receipt.id })).toEqual(receipt)
    expect(await count('sales', owner.businessId)).toBe(1)
  })

  it('applies migrations with RLS and grants only the service entry points', async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(`select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and relname in ('products','sales','sale_items','pos_operations')`)
    expect(rows.rows).toHaveLength(4); expect(rows.rows.every(row => row.relrowsecurity)).toBe(true)
    for (const role of ['anon', 'authenticated']) {
      const permissions = await db.query<{ table_access: boolean; rpc_access: boolean }>(`select has_table_privilege($1,'app_private.sales','SELECT') as table_access,has_function_privilege($1,'public.pos_execute(uuid,uuid,uuid,text,jsonb)','EXECUTE') as rpc_access`, [role])
      expect(permissions.rows[0]).toEqual({ table_access: false, rpc_access: false })
      await db.exec(`set role ${role}`)
      await expect(db.query('select * from app_private.sales')).rejects.toThrow(/permission denied/)
      await expect(db.query('select public.pos_device(null,null,$1)', [{ command: 'catalog' }])).rejects.toThrow(/permission denied/)
      await db.exec('reset role')
    }
    expect((await db.query<{ allowed: boolean }>(`select has_function_privilege('service_role','public.pos_execute(uuid,uuid,uuid,text,jsonb)','EXECUTE') as allowed`)).rows[0].allowed).toBe(true)
  })

  it('persists catalog, detects edit conflicts, and deduplicates creation retries', async () => {
    const actor = await newActor()
    const command = newProduct()
    const first = await execute<Product>(actor, command)
    expect(first).toMatchObject({ name: 'Café sintético', priceCents: 1001, version: 1, active: true })
    expect(await execute(actor, command)).toEqual(first)
    expect((await execute<{ products: Product[] }>(actor, { command: 'catalog' })).products).toEqual([first])
    const changed = await execute<Product>(actor, { ...command, expectedVersion: 1, name: 'Café nuevo', priceCents: 1234, operationId: randomUUID() })
    expect(changed.version).toBe(2)
    await expect(execute(actor, { ...command, expectedVersion: 1, operationId: randomUUID() })).rejects.toThrow('PRODUCT_CHANGED')
    await expect(execute(actor, { ...command, name: 'Other' })).rejects.toThrow('OPERATION_CONFLICT')
    expect(await execute(actor, command)).toEqual(first)
    expect(await count('products', actor.businessId)).toBe(1)
  })

  it('deletes sold products from every catalog while preserving receipts and accepted retries', async () => {
    const owner = await newActor()
    const cashier = await newActor('cashier', owner.businessId)
    const product = await execute<Product>(owner, newProduct())
    const saleRequest = saleCommand(product)
    const receipt = await execute<Sale>(cashier, saleRequest)
    const command = { command: 'delete_product' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version }
    expect(await execute(owner, command)).toEqual({ id: product.id, deleted: true })
    expect(await execute(owner, command)).toEqual({ id: product.id, deleted: true })
    for (const actor of [owner, cashier]) expect((await execute<{ products: Product[] }>(actor, { command: 'catalog' })).products).toEqual([])
    expect(await execute(cashier, { command: 'sale', saleId: receipt.id })).toEqual(receipt)
    expect(await execute(cashier, saleRequest)).toEqual(receipt)
    await expect(execute(cashier, saleCommand(product))).rejects.toThrow('PRODUCT_UNAVAILABLE')
    for (const update of [
      { ...newProduct(), productId: product.id, expectedVersion: product.version + 1 },
      { command: 'set_product_active' as const, productId: product.id, expectedVersion: product.version + 1, active: true, operationId: randomUUID() },
      { command: 'set_product_sold_out' as const, productId: product.id, expectedVersion: product.version + 1, soldOut: false, operationId: randomUUID() },
    ]) await expect(execute(owner, update)).rejects.toThrow('PRODUCT_CHANGED')
    expect(await count('products', owner.businessId)).toBe(1)
    expect(await count('sales', owner.businessId)).toBe(1)
  })

  it('authorizes deletion by current tenant/role and checks versions before retiring a product', async () => {
    const owner = await newActor()
    const other = await newActor()
    const cashier = await newActor('cashier', owner.businessId)
    const manager = await newActor('manager', owner.businessId)
    const kitchen = await newActor('kitchen', owner.businessId)
    const product = await execute<Product>(owner, newProduct())
    const command = { command: 'delete_product' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version }
    for (const actor of [cashier, kitchen]) await expect(execute(actor, command)).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(other, command)).rejects.toThrow('PRODUCT_CHANGED')
    await expect(execute(owner, { ...command, expectedVersion: product.version + 1 })).rejects.toThrow('PRODUCT_CHANGED')
    expect((await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products).toEqual([product])
    expect(await execute(manager, command)).toEqual({ id: product.id, deleted: true })
    await expect(execute(owner, command)).rejects.toThrow('OPERATION_CONFLICT')
    await expect(execute(manager, { ...command, expectedVersion: 2 })).rejects.toThrow('OPERATION_CONFLICT')
    await db.query('update app_private.employees set active=false where id=$1', [manager.employeeId])
    await expect(execute(manager, command)).rejects.toThrow('BUSINESS_ACCESS_DENIED')
  })

  it('rolls back deletion if its operation result cannot be persisted', async () => {
    const owner = await newActor()
    const product = await execute<Product>(owner, newProduct())
    const command = { command: 'delete_product' as const, operationId: randomUUID(), productId: product.id, expectedVersion: product.version }
    await db.exec(`create function app_private.fail_product_deletion() returns trigger language plpgsql set search_path='' as $$
      begin if new.result->>'deleted'='true' then raise exception 'synthetic deletion failure'; end if; return new; end; $$;
      create trigger fail_product_deletion before insert on app_private.pos_operations for each row execute function app_private.fail_product_deletion();`)
    try {
      await expect(execute(owner, command)).rejects.toThrow('synthetic deletion failure')
      expect((await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products).toEqual([product])
      expect((await db.query<{ count: number }>('select count(*)::integer as count from app_private.pos_operations where operation_id=$1', [command.operationId])).rows[0].count).toBe(0)
    } finally { await db.exec('drop trigger fail_product_deletion on app_private.pos_operations; drop function app_private.fail_product_deletion();') }
    expect(await execute(owner, command)).toEqual({ id: product.id, deleted: true })
  })

  it('registers exact MXN, immutable snapshots and authorized replay after catalog/payment changes', async () => {
    const actor = await newActor()
    const productCommand = newProduct()
    const product = await execute<Product>(actor, productCommand)
    const command = saleCommand(product, 3)
    const sale = await execute<Sale>(actor, command)
    expect(sale).toMatchObject({ totalCents: 3003, itemCount: 3, paymentMethod: 'card_external', timezone: 'America/Mexico_City', items: [{ name: product.name, quantity: 3, unitPriceCents: 1001, totalCents: 3003 }] })
    const edited = await execute<Product>(actor, { ...productCommand, expectedVersion: product.version, priceCents: 9999, name: 'Nombre cambiado', operationId: randomUUID() })
    await execute(actor, { command: 'set_product_active', productId: edited.id, expectedVersion: edited.version, active: false, operationId: randomUUID() })
    await db.query(`update app_private.businesses set profile=jsonb_set(profile,'{paymentMethods}','["cash"]'),timezone='America/Cancun' where id=$1`, [actor.businessId])
    expect(await execute(actor, command)).toEqual(sale)
    expect(await execute(actor, { command: 'sale', saleId: sale.id })).toEqual(sale)
    expect(await count('sales', actor.businessId)).toBe(1)
    expect(await count('sale_items', actor.businessId)).toBe(1)
    await expect(execute(actor, { ...command, totalCents: 3004 })).rejects.toThrow('OPERATION_CONFLICT')
    const stored = await db.query<{ result: string }>(`select result::text from app_private.pos_operations where operation_id=$1`, [command.operationId])
    expect(stored.rows[0].result).not.toContain(actor.token)
  })

  it('rejects stale/inactive/foreign products and disabled methods without a partial sale', async () => {
    const actor = await newActor(); const other = await newActor()
    const command = newProduct(); const product = await execute<Product>(actor, command)
    const foreign = await execute<Product>(other, newProduct())
    await expect(execute(actor, saleCommand(foreign))).rejects.toThrow('PRODUCT_UNAVAILABLE')
    await expect(execute(actor, { ...saleCommand(product), items: [{ productId: product.id, quantity: 1, unitPriceCents: 1002, version: 1 }], totalCents: 1002 })).rejects.toThrow('PRODUCT_CHANGED')
    const edited = await execute<Product>(actor, { ...command, expectedVersion: 1, name: 'Cambio', operationId: randomUUID() })
    await expect(execute(actor, saleCommand(product))).rejects.toThrow('PRODUCT_CHANGED')
    const inactive = await execute<Product>(actor, { command: 'set_product_active', productId: product.id, expectedVersion: edited.version, active: false, operationId: randomUUID() })
    await expect(execute(actor, saleCommand(inactive))).rejects.toThrow('PRODUCT_UNAVAILABLE')
    await db.query(`update app_private.businesses set profile=jsonb_set(profile,'{paymentMethods}','["cash"]') where id=$1`, [actor.businessId])
    await expect(execute(actor, saleCommand(inactive))).rejects.toThrow('PAYMENT_METHOD_DISABLED')
    expect(await count('sales', actor.businessId)).toBe(0)
    expect(await count('sale_items', actor.businessId)).toBe(0)
  })

  it('validates money, quantities and empty/duplicate lines again inside SQL', async () => {
    const actor = await newActor(); const product = await execute<Product>(actor, newProduct())
    for (const quantity of [0, -1, 1.5, 1000]) await expect(execute(actor, { ...saleCommand(product), items: [{ productId: product.id, quantity, unitPriceCents: product.priceCents, version: product.version }] })).rejects.toThrow('VALIDATION_ERROR')
    for (const items of [[], [saleCommand(product).items[0], saleCommand(product).items[0]]]) await expect(execute(actor, { ...saleCommand(product), items })).rejects.toThrow('VALIDATION_ERROR')
    await expect(execute(actor, { ...saleCommand(product), totalCents: 1000 })).rejects.toThrow('VALIDATION_ERROR')
    await expect(execute(actor, { ...newProduct(), priceCents: 100.01 })).rejects.toThrow('VALIDATION_ERROR')
    expect(await count('sales', actor.businessId)).toBe(0)
  })

  it('rolls back sale, lines and operation together on a persistence failure', async () => {
    const actor = await newActor(); const product = await execute<Product>(actor, newProduct()); const command = saleCommand(product)
    await db.exec(`create function public.test_fail_operation() returns trigger language plpgsql as $$ begin raise exception 'synthetic persistence failure'; end; $$;
      create trigger test_fail_operation before insert on app_private.pos_operations for each row execute function public.test_fail_operation();`)
    await expect(execute(actor, command)).rejects.toThrow('synthetic persistence failure')
    expect(await count('sales', actor.businessId)).toBe(0); expect(await count('sale_items', actor.businessId)).toBe(0)
    await db.exec('drop trigger test_fail_operation on app_private.pos_operations; drop function public.test_fail_operation();')
    expect((await execute<Sale>(actor, command)).totalCents).toBe(1001)
    expect(await count('sales', actor.businessId)).toBe(1)
  })

  it('enforces role and tenant permissions for personal identities and history', async () => {
    const owner = await newActor(); const cashier = await newActor('cashier', owner.businessId); const kitchen = await newActor('kitchen', owner.businessId); const outsider = await newActor()
    const product = await execute<Product>(owner, newProduct())
    await expect(execute(cashier, newProduct())).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(kitchen, { command: 'catalog' })).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute({ ...outsider, businessId: owner.businessId }, { command: 'catalog' })).rejects.toThrow('BUSINESS_ACCESS_DENIED')
    const ownerSale = await execute<Sale>(owner, saleCommand(product)); const cashierSale = await execute<Sale>(cashier, saleCommand(product))
    expect((await execute<{ sales: SaleSummary[] }>(owner, { command: 'sales', cursor: null })).sales).toHaveLength(2)
    expect((await execute<{ sales: SaleSummary[] }>(cashier, { command: 'sales', cursor: null })).sales.map(row => row.id)).toEqual([cashierSale.id])
    await expect(execute(cashier, { command: 'sale', saleId: ownerSale.id })).rejects.toThrow('SALE_NOT_FOUND')
    await expect(execute(outsider, { command: 'sale', saleId: ownerSale.id })).rejects.toThrow('SALE_NOT_FOUND')
    const ownCommand = saleCommand(product); await execute(owner, ownCommand)
    await expect(execute(cashier, ownCommand)).rejects.toThrow('OPERATION_CONFLICT')
    await db.query('delete from auth.users where id=$1', [cashier.userId])
    expect((await execute<Sale>(owner, { command: 'sale', saleId: cashierSale.id })).operatorName).toBe('Persona sintética')
  })

  it('enforces composite tenant relationships', async () => {
    const owner = await newActor(); const outsider = await newActor()
    const product = await execute<Product>(owner, newProduct()); const foreign = await execute<Product>(outsider, newProduct()); const sale = await execute<Sale>(owner, saleCommand(product))
    await expect(db.query(`insert into app_private.sale_items(business_id,sale_id,product_id,name,category,quantity,unit_price_cents,total_cents) values($1,$2,$3,'Foreign','',1,1,1)`, [owner.businessId, sale.id, foreign.id])).rejects.toThrow(/foreign key/)
  })

  it('refuses revoked/expired operators and revoked Auth sessions on every command', async () => {
    const actor = await newActor()
    await db.query('update app_private.operator_sessions set expires_at=now()-interval \'1 second\' where business_id=$1', [actor.businessId])
    await expect(execute(actor, { command: 'catalog' })).rejects.toThrow('SESSION_EXPIRED')
    await db.query('update app_private.operator_sessions set expires_at=now()+interval \'1 hour\',revoked_at=now() where business_id=$1', [actor.businessId])
    await expect(execute(actor, { command: 'sales', cursor: null })).rejects.toThrow('SESSION_INVALID')
    await db.query('delete from auth.sessions where id=$1', [actor.sessionId])
    await expect(execute(actor, { command: 'catalog' })).rejects.toThrow('AUTH_REQUIRED')
  })

  it('authorizes a shared register only with its current operator and active employee', async () => {
    const owner = await newActor(); const cashier = await newActor('cashier', owner.businessId); const kitchen = await newActor('kitchen', owner.businessId)
    const product = await execute<Product>(owner, newProduct()); const deviceId = randomUUID(); const deviceToken = 'bc'.repeat(32); const token = 'de'.repeat(32)
    await db.query('update app_private.employees set user_id=null where id in ($1,$2)', [cashier.employeeId, kitchen.employeeId])
    await db.query(`insert into app_private.devices(id,business_id,name,register_name,token_hash) values($1,$2,'Synthetic device','Caja 1',extensions.digest($3,'sha256'))`, [deviceId, owner.businessId, deviceToken])
    await db.query(`insert into app_private.device_operator_sessions(business_id,device_id,employee_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`, [owner.businessId, deviceId, cashier.employeeId, token])
    const device = async <T>(command: PosCommand) => (await db.query<{ result: { data: T } }>('select public.pos_device($1,$2,$3::jsonb) as result', [deviceToken, token, JSON.stringify(command)])).rows[0].result.data
    expect((await device<{ products: Product[] }>({ command: 'catalog' })).products).toHaveLength(1)
    expect((await device<Sale>(saleCommand(product))).totalCents).toBe(1001)
    await expect(device(newProduct())).rejects.toThrow('PERMISSION_DENIED')
    await db.query('update app_private.employees set user_id=$1 where id=$2', [cashier.userId, cashier.employeeId])
    const denied = await db.query<{ result: { error: { code: string } } }>('select public.pos_device($1,$2,$3::jsonb) as result', [deviceToken, token, JSON.stringify({ command: 'catalog' })])
    expect(denied.rows[0].result.error.code).toBe('DEVICE_LINK_REQUIRED')
    await db.query('update app_private.device_operator_sessions set employee_id=$1 where device_id=$2', [kitchen.employeeId, deviceId])
    await expect(device({ command: 'catalog' })).rejects.toThrow('PERMISSION_DENIED')
    await db.query('update app_private.devices set revoked_at=now() where id=$1', [deviceId])
    await expect(device({ command: 'catalog' })).rejects.toThrow('DEVICE_REVOKED')
  })

  it('protects sold products and allows an atomic whole-business cascade without orphaned records', async () => {
    const actor = await newActor(); const product = await execute<Product>(actor, newProduct())
    await execute(actor, saleCommand(product))
    await expect(db.query('delete from app_private.products where id=$1', [product.id])).rejects.toThrow(/foreign key/)
    expect(await count('sales', actor.businessId)).toBe(1)
    await db.query('delete from app_private.businesses where id=$1', [actor.businessId])
    for (const table of ['products', 'sales', 'sale_items'] as const) expect(await count(table, actor.businessId)).toBe(0)
    expect(Number((await db.query<{ count: string | number }>('select count(*) from app_private.pos_operations where business_id=$1', [actor.businessId])).rows[0].count)).toBe(0)
  })

  it('keeps personal POS commands inside the verified device and one-use nonce boundary', async () => {
    const owner = await newActor(); const cashier = await newActor('cashier', owner.businessId)
    const payload = { action: 'pos', businessId: cashier.businessId, operatorToken: cashier.token, command: 'catalog' }
    await expect(db.query("select public.account_secure($1,$2,'pos',$3::jsonb)", [cashier.userId, cashier.sessionId, JSON.stringify(payload)])).rejects.toThrow('DEVICE_LINK_REQUIRED')
    await expect(execute({ ...cashier, keyHash: 'ff'.repeat(32) }, { command: 'catalog' })).rejects.toThrow('DEVICE_APPROVAL_REQUIRED')
    const nonce = randomUUID()
    const invoke = () => db.query<{ result: { data?: unknown; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) as result", [cashier.userId, cashier.sessionId, JSON.stringify(payload), cashier.keyHash, nonce])
    expect((await invoke()).rows[0].result.data).toHaveProperty('products')
    expect((await invoke()).rows[0].result.error?.code).toBe('DEVICE_PROOF_INVALID')
    await db.query('update app_private.employee_personal_devices set key_hash=decode($1,\'hex\') where employee_id=$2', ['ef'.repeat(32), cashier.employeeId])
    await expect(execute(cashier, { command: 'catalog' })).rejects.toThrow('DEVICE_APPROVAL_REQUIRED')
  })

  it('paginates by stable server time and ID without duplicates', async () => {
    const actor = await newActor(); const product = await execute<Product>(actor, newProduct())
    for (let i = 0; i < 32; i++) await execute(actor, saleCommand(product, 1, i % 2 ? 'cash' : 'transfer'))
    const first = await execute<{ sales: SaleSummary[]; nextCursor: { createdAt: string; id: string } }>(actor, { command: 'sales', cursor: null })
    expect(first.sales).toHaveLength(30); expect(first.nextCursor).toBeTruthy()
    const second = await execute<{ sales: SaleSummary[]; nextCursor: null }>(actor, { command: 'sales', cursor: first.nextCursor })
    expect(second.sales).toHaveLength(2); expect(second.nextCursor).toBeNull()
    expect(new Set([...first.sales, ...second.sales].map(sale => sale.id)).size).toBe(32)
  })
  it('persists the expanded editor and restricts images, fields and availability by tenant and role', async () => {
    const owner = await newActor(), cashier = await newActor('cashier', owner.businessId), kitchen = await newActor('kitchen', owner.businessId), other = await newActor()
    const details = { ...emptyDetails(), description: 'Café con leche', sku: 'CAFE-01', barcode: '7501234567890', calories: 120, allergens: 'Leche', costCents: 100 }
    const command = { ...newProduct(), details }
    const product = await execute<Product>(owner, command)
    expect(product.details).toEqual(details)
    await expect(execute(cashier, { ...command, productId: randomUUID(), operationId: randomUUID() })).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(owner, { ...command, operationId: randomUUID(), productId: randomUUID(), details: { ...details, stock: 1.5 } })).rejects.toThrow('VALIDATION_ERROR')
    const toggle: PosCommand = { command: 'set_product_sold_out', productId: product.id, expectedVersion: product.version, soldOut: true, operationId: randomUUID() }
    const unavailable = await execute<Product>(cashier, toggle)
    expect(unavailable.details?.soldOut).toBe(true)
    expect(await execute(cashier, toggle)).toEqual(unavailable)
    await expect(execute(other, toggle)).rejects.toThrow('PRODUCT_CHANGED')
    await expect(execute(kitchen, toggle)).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(owner, saleCommand(unavailable))).rejects.toThrow('PRODUCT_UNAVAILABLE')
  })

  it('prices variations and required extras on the server, stores distinct lines and preserves tax snapshots on replay', async () => {
    const actor = await newActor(), variationId = randomUUID(), modifierId = randomUUID()
    const details = { ...emptyDetails(), taxBps: 1600, variations: [{ id: variationId, name: 'Grande', priceCents: 5801, sku: '', barcode: '', soldOut: false }], modifierSets: [{ id: randomUUID(), name: 'Leche', min: 1, max: 1, options: [{ id: modifierId, name: 'Avena', priceCents: 101 }] }] }
    const input = { ...newProduct(), details }, product = await execute<Product>(actor, input)
    const selection = { variationId, modifierIds: [modifierId], variablePriceCents: null }
    const command: Extract<PosCommand,{command:'complete_sale'}> = { ...saleCommand(product), items: [{ productId: product.id, version: product.version, quantity: 3, unitPriceCents: 5902, selection }], totalCents: 17706 }
    await expect(execute(actor, { ...command, items: [{ ...command.items[0], selection: { ...selection, modifierIds: [] } }] })).rejects.toThrow('VALIDATION_ERROR')
    await expect(execute(actor, { ...command, items: [{ ...command.items[0], unitPriceCents: 5901 }], totalCents: 17703 })).rejects.toThrow('PRODUCT_CHANGED')
    const sale = await execute<Sale>(actor, command)
    expect(sale.items[0]).toMatchObject({ unitPriceCents: 5902, totalCents: 17706, taxCents: 2442, selectionLabel: 'Grande, Avena' })
    await execute(actor, { ...input, expectedVersion: product.version, operationId: randomUUID(), details: { ...details, variations: [] } })
    expect(await execute(actor, command)).toEqual(sale)
    expect(await execute(actor, { command: 'sale', saleId: sale.id })).toEqual(sale)
    const variable = await execute<Product>(actor, { ...newProduct(), details: { ...emptyDetails(), variablePrice: true } })
    const variableLine = { productId: variable.id, version: variable.version, quantity: 2, unitPriceCents: 1001, selection: { variationId: null, modifierIds: [], variablePriceCents: 1001 } }
    expect((await execute<Sale>(actor, { ...saleCommand(variable), items: [variableLine], totalCents: 2002 })).totalCents).toBe(2002)
  })

  it('preserves dormant inventory on upgrade and legacy sales never reject or debit quantity', async () => {
    const catalog = await execute<{products:Product[]}>(legacyActor,{command:'catalog'})
    const product = catalog.products.find(p => p.id === legacyInventoryProduct.id)!
    expect(product.details).toMatchObject({trackStock:false,stock:3,lowStockAlert:7})
    const command = saleCommand(product,9)
    const receipt = await execute<Sale>(legacyActor,command)
    expect(receipt).toMatchObject({itemCount:9,totalCents:9009})
    const stored = await db.query<{details:unknown;version:number}>('select details,version from app_private.products where business_id=$1 and id=$2',[legacyActor.businessId,product.id])
    expect(stored.rows[0]).toMatchObject({details:{trackStock:true,stock:3,lowStockAlert:7},version:product.version})
    const emptyProduct = catalog.products.find(p => p.id === legacyEmptyInventoryProduct.id)!
    expect((await execute<Sale>(legacyActor,saleCommand(emptyProduct,9))).itemCount).toBe(9)
    expect((await db.query<{details:unknown;version:number}>('select details,version from app_private.products where id=$1',[emptyProduct.id])).rows[0]).toMatchObject({details:{trackStock:true,stock:0},version:emptyProduct.version})
    const unavailable = await execute<Product>(legacyActor,{command:'set_product_sold_out',productId:product.id,expectedVersion:product.version,soldOut:true,operationId:randomUUID()})
    await expect(execute(legacyActor,saleCommand(unavailable))).rejects.toThrow('PRODUCT_UNAVAILABLE')
    expect(await execute(legacyActor,command)).toEqual(receipt)
  })

  it('masked catalog saves preserve old inventory fields and obsolete clients cannot enable tracking', async () => {
    const catalog = await execute<{products:Product[]}>(legacyActor,{command:'catalog'})
    const product = catalog.products.find(p => p.id === legacyInventoryProduct.id)!
    let current = await execute<Product>(legacyActor,{...newProduct(),productId:product.id,expectedVersion:product.version,details:product.details,name:'Nombre actualizado'})
    current = await execute<Product>(legacyActor,{...newProduct(),productId:product.id,expectedVersion:current.version,details:{...current.details!,trackStock:true,stock:900,lowStockAlert:800}})
    expect(current.details).toMatchObject({trackStock:false,stock:3,lowStockAlert:7})
    const stored = await db.query<{details:unknown}>('select details from app_private.products where business_id=$1 and id=$2',[legacyActor.businessId,product.id])
    expect(stored.rows[0].details).toMatchObject({trackStock:true,stock:3,lowStockAlert:7})
    const actor = await newActor()
    const fresh = await execute<Product>(actor,{...newProduct(),details:{...emptyDetails(),trackStock:true,stock:3,lowStockAlert:1}})
    expect(fresh.details).toMatchObject({trackStock:false,stock:0,lowStockAlert:5})
    const command = saleCommand(fresh,8)
    const receipt = await execute<Sale>(actor,command)
    expect(await execute(actor,command)).toEqual(receipt)
    expect((await execute<{products:Product[]}>(actor,{command:'catalog'})).products[0]).toEqual(fresh)
    expect((await db.query<{details:unknown}>('select details from app_private.products where id=$1',[fresh.id])).rows[0].details).toMatchObject({trackStock:false,stock:0,lowStockAlert:5})
    for (const role of ['anon','authenticated']) expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'app_private.manual_availability_details(jsonb,jsonb)','EXECUTE') as allowed",[role])).rows[0].allowed).toBe(false)
  })

  it('assembles private bounded JPEG chunks with authorized retries and rejects foreign image attachment', async () => {
    const owner = await newActor(), other = await newActor(), cashier = await newActor('cashier',owner.businessId)
    const upload: Extract<PosCommand,{command:'upload_product_image'}> = {command:'upload_product_image',operationId:randomUUID(),imageId:randomUUID(),part:0,parts:2,data:'/9j/'}
    expect(await execute(owner,upload)).toMatchObject({complete:false})
    expect(await execute(owner,upload)).toMatchObject({complete:false})
    await expect(execute(cashier,{...upload,operationId:randomUUID()})).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(owner,{...upload,operationId:randomUUID(),data:'AAAA'})).rejects.toThrow('OPERATION_CONFLICT')
    await execute(owner,{...upload,operationId:randomUUID(),part:1,data:'2f/Z'})
    const input = {...newProduct(),details:{...emptyDetails(),imageId:upload.imageId}}
    expect((await execute<Product>(owner,input)).image).toBe('data:image/jpeg;base64,/9j/2f/Z')
    await expect(execute(other,{...input,productId:randomUUID(),operationId:randomUUID()})).rejects.toThrow('VALIDATION_ERROR')
    for(const role of ['anon','authenticated']) {
      expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,'app_private.product_images','SELECT') allowed",[role])).rows[0].allowed).toBe(false)
    }
  })

})

async function newActor(role = 'owner', existingBusiness?: string): Promise<Actor> {
  const actor = { userId: randomUUID(), sessionId: randomUUID(), businessId: existingBusiness ?? randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  if (!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","paymentMethods":["cash","card_external","transfer"]}')`, [actor.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [actor.businessId, actor.userId, role])
  await db.query(`insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Persona sintética',$4)`, [actor.employeeId, actor.businessId, actor.userId, role])
  await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`, [actor.businessId, actor.userId, actor.sessionId, actor.token])
  if (role !== 'owner') {
    await db.query(`insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')`, [actor.businessId, actor.employeeId, actor.keyHash])
    await db.query(`update app_private.operator_sessions set employee_device_key_hash=decode($1,'hex') where business_id=$2 and user_id=$3`, [actor.keyHash, actor.businessId, actor.userId])
  }
  return actor
}

function newProduct(): Extract<PosCommand, { command: 'save_product' }> {
  return { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: 'Café', priceCents: 1001 }
}
function saleCommand(product: Product, quantity = 1, paymentMethod: Sale['paymentMethod'] = 'card_external'): Extract<PosCommand, { command: 'complete_sale' }> {
  return { command: 'complete_sale', operationId: randomUUID(), items: [{ productId: product.id, quantity, unitPriceCents: product.priceCents, version: product.version }], totalCents: product.priceCents * quantity, paymentMethod }
}
async function execute<T = unknown>(actor: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) as result", [actor.userId, actor.sessionId, JSON.stringify({ action: 'pos', businessId: actor.businessId, operatorToken: actor.token, ...command }), actor.keyHash, randomUUID()])).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}
async function count(table: string, businessId: string): Promise<number> {
  if (!['products', 'sales', 'sale_items'].includes(table)) throw new Error('Unknown fixture table')
  return Number((await db.query<{ count: string }>(`select count(*) from app_private.${table} where business_id=$1`, [businessId])).rows[0].count)
}
