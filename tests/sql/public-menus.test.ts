import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDetails } from '../../src/lib/product-details';
import type { Product } from '../../src/lib/pos-contracts';
import type { OperatorSession } from '../../src/lib/contracts';
import type { MenuCommand, MenuConfiguration, PublicMenuDocument } from '../../src/lib/menu-contracts';
type Actor = { user: string; auth: string; business: string; employee: string; token: string; key: string };
let db: PGlite;
describe('published menu capabilities and live catalogue projection', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec('create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role; create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);');
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && file <= '20261007210000_public_menu_product_cascade.sql').sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
  }, 120000);
  afterAll(async () => db?.close());

  it('publishes only reviewed public fields, reads live changes under a stable QR and immediately stops serving unpublished menus', async () => {
    const owner = await actor(); const source = await product(owner);
    const command = save([source.id]); const draft = await pos<MenuConfiguration>(owner, command);
    expect((await read(draft.publicId)).error?.code).toBe('MENU_UNAVAILABLE');
    const published = await pos<MenuConfiguration>(owner, { ...command, operationId: randomUUID(), expectedRevision: draft.revision, published: true });
    expect(published.publicId).toBe(draft.publicId);
    const first = (await read(published.publicId)).data!;
    expect(first).toMatchObject({ businessName: 'Negocio sintético', availability: 'open', products: [{ name: 'Nombre para clientes', priceCents: 1001, available: true }] });
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|costCents|stock|transferAccount|employee|kitchenName|sku|barcode|libraryId|permissions|operatorToken|businessId/i);
    const changed = await pos<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: source.id, expectedVersion: source.version, name: source.name, category: 'Bebidas', priceCents: 1111 });
    expect((await read(published.publicId)).data!.products[0].priceCents).toBe(1111);
    const out = await pos<Product>(owner, { command: 'set_product_sold_out', operationId: randomUUID(), productId: source.id, expectedVersion: changed.version, soldOut: true });
    expect((await read(published.publicId)).data!.products[0].available).toBe(false);
    await pos(owner, { command: 'set_product_active', operationId: randomUUID(), productId: source.id, expectedVersion: out.version, active: false });
    expect((await read(published.publicId)).data!.products).toEqual([]);
    await pos(owner, { ...command, operationId: randomUUID(), expectedRevision: published.revision, published: false });
    expect(await read(published.publicId)).toEqual({ error: { code: 'MENU_UNAVAILABLE' } });
  });

  it('returns the same server-generated public UUID after a lost response, before later menu/catalogue changes, but reauthorizes the actor first', async () => {
    const owner = await actor(); const source = await product(owner); const command = { ...save([source.id]), published: true };
    const accepted = await pos<MenuConfiguration>(owner, command);
    await pos(owner, { ...command, operationId: randomUUID(), expectedRevision: accepted.revision, name: 'Nombre posterior' });
    expect(await pos(owner, command)).toEqual(accepted);
    expect((await pos<{ menus: MenuConfiguration[] }>(owner, { command: 'menus' })).menus).toHaveLength(1);
    await expect(pos(owner, { ...command, locationLabel: 'Otra barra' })).rejects.toThrow('OPERATION_CONFLICT');
    const manager = await actor('manager', owner.business);
    await expect(pos(manager, command)).rejects.toThrow('PERMISSION_DENIED');
    await db.exec("set app.pos_session_kind='device';");
    await expect(db.query('select app_private.pos_command($1,$2,$3::jsonb)', [owner.business, owner.employee, JSON.stringify({ command: 'menus' })])).rejects.toThrow('PERMISSION_DENIED');
    await expect(db.query('select app_private.pos_command($1,$2,$3::jsonb)', [owner.business, owner.employee, JSON.stringify(command)])).rejects.toThrow('PERMISSION_DENIED');
    await db.query('update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=$1 and user_id=$2', [owner.business, owner.user]);
    await expect(pos(owner, command)).rejects.toThrow('SESSION_INVALID');
  });

  it('keeps menu product references in the tenant and rejects invalid/duplicate/oversized schedules atomically', async () => {
    const owner = await actor(), other = await actor(); const source = await product(other);
    await expect(pos(owner, save([source.id]))).rejects.toThrow('PRODUCT_CHANGED');
    expect((await pos<{ menus: MenuConfiguration[] }>(owner, { command: 'menus' })).menus).toEqual([]);
    const own = await product(owner);
    const command = save([own.id]);
    for (const patch of [{ productIds: [own.id, own.id] }, { productIds: Array.from({ length: 101 }, () => randomUUID()) }, { schedules: [{ weekdays: [2, 1], startMinute: 1, endMinute: 2 }] }, { schedules: [{ weekdays: [1], startMinute: 600, endMinute: 600 }] }, { hidden: true }]) await expect(pos(owner, { ...command, ...patch })).rejects.toThrow('VALIDATION_ERROR');
    expect((await pos<{ menus: MenuConfiguration[] }>(owner, { command: 'menus' })).menus).toEqual([]);
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.public_menu_read(uuid)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'app_private.public_menus','SELECT') allowed", [role])).rows[0].allowed).toBe(false);
    }
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege('service_role','public.public_menu_read(uuid)','EXECUTE') allowed")).rows[0].allowed).toBe(true);
  });

  it('cascades menu links with their tenant while retaining the composite tenant-product boundary', async () => {
    const owner = await actor(), source = await product(owner);
    const menu = await pos<MenuConfiguration>(owner, { ...save([source.id]), published: true });
    expect((await read(menu.publicId)).data!.products).toHaveLength(1);
    await db.query('delete from app_private.businesses where id=$1', [owner.business]);
    expect(await read(menu.publicId)).toEqual({ error: { code: 'MENU_UNAVAILABLE' } });
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.public_menu_products where business_id=$1', [owner.business])).rows[0].count).toBe(0);
    const definition = (await db.query<{ definition: string }>("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='app_private.public_menu_products'::regclass and conname='public_menu_products_business_id_product_id_fkey'")).rows[0].definition;
    expect(definition).toContain('FOREIGN KEY (business_id, product_id)');
    expect(definition).toContain('REFERENCES app_private.products(business_id, id) ON DELETE CASCADE');
  });

  it('handles midnight rollover, closing boundaries and DST using the saved business timezone', async () => {
    const schedules = [{ weekdays: [2], startMinute: 1320, endMinute: 120 }];
    const open = async (instant: string, zone: string, value = schedules) => (await db.query<{ result: boolean }>('select app_private.menu_schedule_open($1::jsonb,$2::timestamptz,$3) result', [JSON.stringify(value), instant, zone])).rows[0].result;
    expect(await open('2026-10-07T07:00:00Z', 'America/Hermosillo')).toBe(true);
    expect(await open('2026-10-07T09:00:00Z', 'America/Hermosillo')).toBe(false);
    expect(await open('2026-10-07T07:00:00Z', 'Etc/UTC')).toBe(false);
    const sunday = [{ weekdays: [0], startMinute: 60, endMinute: 120 }];
    expect(await open('2026-11-01T05:30:00Z', 'America/New_York', sunday)).toBe(true);
    expect(await open('2026-11-01T06:30:00Z', 'America/New_York', sunday)).toBe(true);
    expect(await open('2026-11-01T07:00:00Z', 'America/New_York', sunday)).toBe(false);
    const owner = await actor(), source = await product(owner);
    const localDay = (await db.query<{ local_day: number }>("select extract(dow from clock_timestamp() at time zone 'America/Hermosillo')::integer local_day")).rows[0].local_day;
    const menu = await pos<MenuConfiguration>(owner, { ...save([source.id]), published: true, schedules: [{ weekdays: [(localDay + 2) % 7], startMinute: 0, endMinute: 1440 }] });
    expect((await read(menu.publicId)).data).toMatchObject({ availability: 'outside_hours', products: [] });
  });

  it('projects conditional extra and combo availability while preserving customer snapshots and hiding preparation data', async () => {
    const owner = await actor(), parent = randomUUID(), child = randomUUID();
    const extras = await pos<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café con leche', category: '', priceCents: 1001, details: { ...emptyDetails(), modifierSets: [
      { id: randomUUID(), name: 'Preparación', min: 1, max: 1, options: [{ id: parent, name: 'Con leche', priceCents: 0 }] },
      { id: randomUUID(), name: 'Leche', parentOptionId: parent, min: 1, max: 1, options: [{ id: child, name: 'Avena', priceCents: -25, soldOut: true }] },
    ] } });
    const component = await product(owner);
    const combo = await pos<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Combo desayuno', category: '', priceCents: 1800, details: { ...emptyDetails(), comboComponents: [{ productId: component.id, version: component.version, quantity: 2 }] } });
    const menu = await pos<MenuConfiguration>(owner, { ...save([extras.id, combo.id]), published: true });
    const first = (await read(menu.publicId)).data!;
    expect(first.products[0]).toMatchObject({ available: false, modifierGroups: [{ options: [{ name: 'Con leche', soldOut: true }] }, { parentOptionId: parent, options: [{ priceCents: -25, soldOut: true }] }] });
    expect(first.products[1]).toMatchObject({ available: true, comboComponents: [{ name: 'Nombre para clientes', quantity: 2, selectionLabel: '' }] });
    expect(JSON.stringify(first.products[1])).not.toMatch(/PRIVATE|productId|kitchenName|version|comboUnavailableReason/);
    await pos(owner, { command: 'set_modifier_option_sold_out', operationId: randomUUID(), productId: extras.id, expectedVersion: extras.version, modifierId: child, soldOut: false });
    expect((await read(menu.publicId)).data!.products[0].available).toBe(true);
    await pos(owner, { command: 'set_product_sold_out', operationId: randomUUID(), productId: component.id, expectedVersion: component.version, soldOut: true });
    const current = (await read(menu.publicId)).data!.products[1]; expect(current.available).toBe(false);
    expect(current.comboComponents).toEqual(first.products[1].comboComponents); expect(JSON.stringify(current)).not.toContain('PRIVATE');
  });
});
function save(productIds: string[]): Extract<MenuCommand, { command: 'save_menu' }> { return { command: 'save_menu', operationId: randomUUID(), menuId: randomUUID(), expectedRevision: null, name: 'Menú sintético', locationLabel: 'Barra principal', published: false, schedules: [], productIds }; }
async function read(id: string) { return (await db.query<{ result: { data?: PublicMenuDocument; error?: { code: string } } }>('select public.public_menu_read($1) result', [id])).rows[0].result; }
async function actor(role = 'owner', existing?: string): Promise<Actor> {
  const value: Actor = { user: randomUUID(), auth: randomUUID(), business: existing ?? randomUUID(), employee: randomUUID(), token: '', key: randomUUID().replaceAll('-', '').repeat(2) };
  await db.query('insert into auth.users(id) values($1)', [value.user]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.auth, value.user]);
  if (!existing) await db.query("insert into app_private.businesses(id,name,business_type,timezone) values($1,'Negocio sintético','cafe','America/Hermosillo')", [value.business]);
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [value.business, value.user, role]);
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'PRIVATE PERSON',$4,$5)", [value.employee, value.business, value.user, role, role === 'owner' ? [] : ['catalog.read', 'catalog.manage']]);
  await db.query("insert into app_private.operator_credentials(business_id,user_id,pin_hash) values($1,$2,extensions.crypt('024680',extensions.gen_salt('bf',12)))", [value.business, value.user]);
  const result = (await db.query<{ result: { data: OperatorSession } }>("select public.account_secure($1,$2,'unlock',$3::jsonb,$4,$5) result", [value.user, value.auth, JSON.stringify({ action: 'unlock', businessId: value.business, pin: '024680' }), value.key, randomUUID()])).rows[0].result;
  value.token = result.data.operatorToken; return value;
}
async function pos<T = unknown>(value: Actor, command: object): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result", [value.user, value.auth, JSON.stringify({ action: 'pos', businessId: value.business, operatorToken: value.token, ...command }), value.key, randomUUID()])).rows[0].result;
  if (result.error) throw new Error(result.error.code); return result.data;
}
function product(value: Actor) { return pos<Product>(value, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'PRIVATE INTERNAL TITLE', category: '', priceCents: 1001, details: { ...emptyDetails(), customerName: 'Nombre para clientes', kitchenName: 'PRIVATE PREPARATION', costCents: 321, stock: 12, sku: 'PRIVATE SKU', barcode: 'PRIVATE BARCODE', customAttributes: [{ name: 'PRIVATE ATTRIBUTE', value: 'PRIVATE VALUE' }] } }); }
