import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PosCommand, Product, Sale, SaleSummary } from '../../src/lib/pos-contracts'

let db: PGlite
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string }

describe('real PostgreSQL migrations and financial transactions (embedded, synthetic Auth rows)', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions;
      create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

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
    await db.query(`insert into app_private.devices(id,business_id,name,register_name,token_hash) values($1,$2,'Synthetic device','Caja 1',extensions.digest($3,'sha256'))`, [deviceId, owner.businessId, deviceToken])
    await db.query(`insert into app_private.device_operator_sessions(business_id,device_id,employee_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`, [owner.businessId, deviceId, cashier.employeeId, token])
    const device = async <T>(command: PosCommand) => (await db.query<{ result: { data: T } }>('select public.pos_device($1,$2,$3::jsonb) as result', [deviceToken, token, JSON.stringify(command)])).rows[0].result.data
    expect((await device<{ products: Product[] }>({ command: 'catalog' })).products).toHaveLength(1)
    expect((await device<Sale>(saleCommand(product))).totalCents).toBe(1001)
    await expect(device(newProduct())).rejects.toThrow('PERMISSION_DENIED')
    await db.query('update app_private.device_operator_sessions set employee_id=$1 where device_id=$2', [kitchen.employeeId, deviceId])
    await expect(device({ command: 'catalog' })).rejects.toThrow('PERMISSION_DENIED')
    await db.query('update app_private.devices set revoked_at=now() where id=$1', [deviceId])
    await expect(device({ command: 'catalog' })).rejects.toThrow('DEVICE_REVOKED')
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
})

async function newActor(role = 'owner', existingBusiness?: string): Promise<Actor> {
  const actor = { userId: randomUUID(), sessionId: randomUUID(), businessId: existingBusiness ?? randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.sessionId, actor.userId])
  if (!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","paymentMethods":["cash","card_external","transfer"]}')`, [actor.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [actor.businessId, actor.userId, role])
  await db.query(`insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Persona sintética',$4)`, [actor.employeeId, actor.businessId, actor.userId, role])
  await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`, [actor.businessId, actor.userId, actor.sessionId, actor.token])
  return actor
}

function newProduct(): Extract<PosCommand, { command: 'save_product' }> {
  return { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: 'Café', priceCents: 1001 }
}
function saleCommand(product: Product, quantity = 1, paymentMethod: Sale['paymentMethod'] = 'card_external'): Extract<PosCommand, { command: 'complete_sale' }> {
  return { command: 'complete_sale', operationId: randomUUID(), items: [{ productId: product.id, quantity, unitPriceCents: product.priceCents, version: product.version }], totalCents: product.priceCents * quantity, paymentMethod }
}
async function execute<T = unknown>(actor: Actor, command: PosCommand): Promise<T> {
  return (await db.query<{ result: { data: T } }>('select public.pos_execute($1,$2,$3,$4,$5::jsonb) as result', [actor.userId, actor.sessionId, actor.businessId, actor.token, JSON.stringify(command)])).rows[0].result.data
}
async function count(table: string, businessId: string): Promise<number> {
  if (!['products', 'sales', 'sale_items'].includes(table)) throw new Error('Unknown fixture table')
  return Number((await db.query<{ count: string }>(`select count(*) from app_private.${table} where business_id=$1`, [businessId])).rows[0].count)
}
