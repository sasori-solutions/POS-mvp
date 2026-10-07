import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorSession } from '../../src/lib/contracts';
import type { ModifierSet, Product, ProductDetails } from '../../src/lib/pos-contracts';
import { emptyDetails } from '../../src/lib/product-details';

type Actor = { user: string; auth: string; business: string; token: string; key: string; employee: string };
let db: PGlite;
describe('atomic authorised catalogue batches', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec('create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role; create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);');
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && file <= '20261007160000_catalog_bulk.sql').sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it('imports products with exact cents and inactive status, then replays the original result after later edits', async () => {
    const owner = await actor(); const ids = [randomUUID(), randomUUID()];
    const input = { command: 'import_products', operationId: randomUUID(), items: ids.map((id, index) => ({ productId: id, expectedVersion: null, name: `Producto ${index}`, category: 'Bebidas', priceCents: 1001 + index, active: index === 0, details: detail() })) };
    const saved = await pos<{ products: Product[] }>(owner, input);
    expect(saved.products.map(product => product.priceCents).sort()).toEqual([1001, 1002]);
    expect(saved.products.find(product => product.id === ids[1])!.active).toBe(false);
    const first = saved.products[0];
    await pos(owner, { command: 'save_product', operationId: randomUUID(), productId: first.id, expectedVersion: first.version, name: 'Nombre posterior', category: 'Otra', priceCents: 2222 });
    expect(await pos(owner, input)).toEqual(saved);
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.products where business_id=$1', [owner.business])).rows[0].count).toBe(2);
    await expect(pos(owner, { ...input, items: [{ ...input.items[0], priceCents: 99 }, input.items[1]] })).rejects.toThrow('OPERATION_CONFLICT');
  });

  it('rolls back all prior row writes and their nested receipts when any row is stale', async () => {
    const owner = await actor(); const first = await product(owner), second = await product(owner);
    const before = (await db.query<{ count: number }>('select count(*)::integer count from app_private.pos_operations where business_id=$1', [owner.business])).rows[0].count;
    const input = { command: 'bulk_edit_products', operationId: randomUUID(), products: [{ productId: first.id, expectedVersion: first.version }, { productId: second.id, expectedVersion: second.version + 1 }], patch: { category: 'No debe guardarse', priceCents: 1111 } };
    await expect(pos(owner, input)).rejects.toThrow('PRODUCT_CHANGED');
    const saved = (await db.query<{ version: number; category: string }>('select version,category from app_private.products where business_id=$1', [owner.business])).rows;
    expect(saved.every(row => row.version === 1 && row.category === '')).toBe(true);
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.pos_operations where business_id=$1', [owner.business])).rows[0].count).toBe(before);
    const corrected = { ...input, products: [{ productId: first.id, expectedVersion: first.version }, { productId: second.id, expectedVersion: second.version }] };
    expect((await pos<{ products: Product[] }>(owner, corrected)).products.every(row => row.priceCents === 1111 && row.category === 'No debe guardarse')).toBe(true);
  });

  it('preserves variants, linked modifiers and recorded sale snapshots while bulk editing IVA/status/base price', async () => {
    const owner = await actor(); const source = await product(owner);
    const sale = await pos(owner, { command: 'complete_sale', operationId: randomUUID(), items: [{ productId: source.id, quantity: 1, version: source.version, unitPriceCents: source.priceCents }], totalCents: source.priceCents, paymentMethod: 'cash' });
    const groupId = randomUUID();
    const group = { id: groupId, name: 'Leches', min: 0, max: 2, options: [{ id: randomUUID(), name: 'Sin leche', priceCents: -25, soldOut: false, maxQuantity: 2 }] } satisfies ModifierSet;
    await pos(owner, { command: 'save_modifier_group', operationId: randomUUID(), groupId, expectedVersion: null, name: group.name, min: group.min, max: group.max, options: group.options });
    const options: ProductDetails = { ...detail(), modifierSets: [{ ...group, libraryId: groupId }], variations: [{ id: randomUUID(), name: 'Grande', priceCents: 1500, sku: '0001', barcode: '', soldOut: false }] };
    const current = await pos<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: source.id, expectedVersion: source.version, name: source.name, category: '', priceCents: source.priceCents, details: options });
    const input = { command: 'bulk_edit_products', operationId: randomUUID(), products: [{ productId: current.id, expectedVersion: current.version }], patch: { category: 'Comida', active: false, priceCents: 2002, vatTreatment: 'exempt' } };
    const saved = (await pos<{ products: Product[] }>(owner, input)).products[0];
    expect(saved).toMatchObject({ priceCents: 2002, active: false, category: 'Comida', details: { taxTreatment: 'exempt', taxBps: 0, variations: options.variations, modifierSets: options.modifierSets } });
    expect((await db.query<{ group_id: string }>('select group_id from app_private.product_modifier_groups where business_id=$1 and product_id=$2', [owner.business, source.id])).rows).toEqual([{ group_id: groupId }]);
    const saleId = (sale as { id: string }).id;
    expect(await pos(owner, { command: 'sale', saleId })).toEqual(sale);
    expect(await pos(owner, input)).toEqual({ products: [saved] });
  });

  it('rejects ungranted, foreign, revoked and differently owned replays before any mutation', async () => {
    const owner = await actor(); const source = await product(owner); const other = await actor(); const restricted = await actor('cashier', owner.business);
    const input = { command: 'bulk_edit_products', operationId: randomUUID(), products: [{ productId: source.id, expectedVersion: source.version }], patch: { active: false } };
    await expect(pos(restricted, input)).rejects.toThrow('PERMISSION_DENIED');
    await expect(pos(other, input)).rejects.toThrow('PRODUCT_CHANGED');
    await pos(owner, input);
    const manager = await actor('manager', owner.business);
    await expect(pos(manager, input)).rejects.toThrow('OPERATION_CONFLICT');
    await db.query("update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=$1 and user_id=$2", [owner.business, owner.user]);
    await expect(pos(owner, input)).rejects.toThrow('SESSION_INVALID');
    for (const role of ['anon', 'authenticated']) expect((await db.query<{ permitted: boolean }>("select has_function_privilege($1,'app_private.pos_command(uuid,uuid,jsonb)','EXECUTE') permitted", [role])).rows[0].permitted).toBe(false);
  });

  it('rejects oversized, duplicate and unknown keys even through direct service SQL dispatch', async () => {
    const owner = await actor(); const source = await product(owner);
    const input = { command: 'bulk_edit_products', operationId: randomUUID(), products: [{ productId: source.id, expectedVersion: source.version }], patch: { category: 'Bebidas' } };
    for (const patch of [{ products: [...input.products, ...input.products] }, { patch: { hidden: true } }, { products: Array.from({ length: 21 }, () => ({ productId: randomUUID(), expectedVersion: 1 })) }]) await expect(pos(owner, { ...input, ...patch })).rejects.toThrow('VALIDATION_ERROR');
    await expect(pos(owner, { command: 'import_products', operationId: randomUUID(), items: [{ productId: randomUUID(), expectedVersion: null, name: 'Muy largo', category: '', priceCents: 1, active: true, details: { ...detail(), description: 'A'.repeat(8200) } }] })).rejects.toThrow('PAYLOAD_TOO_LARGE');
  });
});

function detail(): ProductDetails { return { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 }; }
async function actor(role = 'owner', existing?: string): Promise<Actor> {
  const value: Actor = { user: randomUUID(), auth: randomUUID(), business: existing ?? randomUUID(), token: '', key: randomUUID().replaceAll('-', '').repeat(2), employee: randomUUID() };
  await db.query('insert into auth.users(id) values($1)', [value.user]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.auth, value.user]);
  if (!existing) await db.query("insert into app_private.businesses(id,name,business_type,timezone) values($1,'Negocio sintético','cafe','America/Mexico_City')", [value.business]);
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [value.business, value.user, role]);
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Persona sintética',$4,$5)", [value.employee, value.business, value.user, role, role === 'owner' ? [] : role === 'manager' ? ['catalog.read', 'catalog.manage'] : ['catalog.read', 'sales.create']]);
  await db.query("insert into app_private.operator_credentials(business_id,user_id,pin_hash) values($1,$2,extensions.crypt('024680',extensions.gen_salt('bf',12)))", [value.business, value.user]);
  const session = (await db.query<{ result: { data: OperatorSession } }>('select public.account_secure($1,$2,\'unlock\',$3::jsonb,$4,$5) result', [value.user, value.auth, JSON.stringify({ action: 'unlock', businessId: value.business, pin: '024680' }), value.key, randomUUID()])).rows[0].result.data;
  value.token = session.operatorToken; return value;
}
async function pos<T = unknown>(value: Actor, command: object): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>('select public.account_secure($1,$2,\'pos\',$3::jsonb,$4,$5) result', [value.user, value.auth, JSON.stringify({ action: 'pos', businessId: value.business, operatorToken: value.token, ...command }), value.key, randomUUID()])).rows[0].result;
  if (result.error) throw new Error(result.error.code); return result.data;
}
function product(value: Actor) { return pos<Product>(value, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto sintético', category: '', priceCents: 116, details: detail() }); }
