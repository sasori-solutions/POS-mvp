import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { OperationalOrder } from '../../src/lib/operations-contracts';
import type { Product } from '../../src/lib/pos-contracts';

type Actor = { businessId: string; userId: string; sessionId: string; employeeId: string; token: string; keyHash: string };
type Order = OperationalOrder & { orderKind?: 'counter' | 'service' | null };
type Save = { command: string; operationId: string; orderId: string; expectedRevision: number | null; name: string; tableId: string | null; items: object[]; orderKind?: unknown };
let db: PGlite, legacy: Actor, legacyPayload: Save, legacyReceipt: Order;
const migration = '20261005013000_order_kind.sql';

describe('canonical counter and service order intent with legacy replay compatibility', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`);
    const files = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort();
    for (const file of files.filter(file => file < migration)) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    legacy = await actor();
    legacyPayload = await draft(legacy, undefined, 'Mostrador');
    legacyReceipt = await execute<Order>(legacy, legacyPayload);
    await db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'));
  }, 90_000);
  afterAll(async () => { await db?.close(); });

  test('keeps historical intent unknown and returns the original accepted snapshot exactly', async () => {
    expect(legacyReceipt).not.toHaveProperty('orderKind');
    const current = await execute<Order>(legacy, { command: 'order', orderId: legacyReceipt.id });
    expect(current).toEqual({ ...legacyReceipt, orderKind: null });
    expect(await execute(legacy, legacyPayload)).toEqual(legacyReceipt);
    expect((await db.query<{ kind: string | null }>('select order_kind kind from app_private.operational_orders where business_id=$1 and id=$2', [legacy.businessId, legacyReceipt.id])).rows[0].kind).toBeNull();
    const omittedNew = await execute<Order>(legacy, await draft(legacy, undefined, 'Otra cuenta anterior'));
    expect(omittedNew.orderKind).toBeNull();
  });

  test('persists explicit intent through repeated refreshes and omitted edits without using the name', async () => {
    const owner = await actor();
    for (const [kind, name] of [['counter', 'Venta directa'], ['service', 'Mostrador']] as const) {
      const payload = await draft(owner, kind, name), order = await execute<Order>(owner, payload);
      expect(order.orderKind).toBe(kind);
      for (let count = 0; count < 3; count++) {
        expect((await execute<{ orders: Order[] }>(owner, { command: 'operations' })).orders.find(row => row.id === order.id)?.orderKind).toBe(kind);
        expect((await execute<Order>(owner, { command: 'order', orderId: order.id })).orderKind).toBe(kind);
      }
      const edit = { ...payload, operationId: randomUUID(), expectedRevision: order.revision, name: `${name} editado` };
      delete edit.orderKind;
      const edited = await execute<Order>(owner, edit);
      expect(edited.orderKind).toBe(kind);
      expect(await execute(owner, payload)).toEqual(order);
      await expect(execute(owner, { ...payload, orderKind: kind === 'counter' ? 'service' : 'counter' })).rejects.toThrow('OPERATION_CONFLICT');
      await expect(execute(owner, { ...edit, operationId: randomUUID(), expectedRevision: edited.revision, orderKind: kind === 'counter' ? 'service' : 'counter' })).rejects.toThrow('ORDER_CHANGED');
      expect((await execute<Order>(owner, { command: 'order', orderId: order.id })).orderKind).toBe(kind);
    }
  });

  test('rejects invalid or misplaced intent and counter requests containing a table', async () => {
    const owner = await actor(), payload = await draft(owner, 'counter');
    for (const orderKind of [null, '', 'Mostrador', true, 1, {}, []])
      await expect(execute(owner, { ...payload, orderKind })).rejects.toThrow('VALIDATION_ERROR');
    await expect(execute(owner, { ...payload, tableId: randomUUID() })).rejects.toThrow('VALIDATION_ERROR');
    await expect(execute(owner, { command: 'operations', orderKind: 'counter' })).rejects.toThrow('VALIDATION_ERROR');
    await expect(execute(owner, { ...payload, unexpected: true })).rejects.toThrow('VALIDATION_ERROR');
  });

  test('disabled accounts permit explicit direct checkout and cannot be bypassed by a service name', async () => {
    const owner = await actor(), servicePayload = await draft(owner, 'service', 'Cuenta existente');
    const service = await execute<Order>(owner, servicePayload);
    await db.query("update app_private.businesses set profile=profile||'{\"accountsEnabled\":false}'::jsonb where id=$1", [owner.businessId]);
    const counter = await execute<Order>(owner, await draft(owner, 'counter', 'Venta directa'));
    expect(counter.orderKind).toBe('counter');
    await expect(execute(owner, await draft(owner, 'service', 'Mostrador'))).rejects.toThrow('PERMISSION_DENIED');
    expect(await execute<Order>(owner, { ...servicePayload, operationId: randomUUID(), expectedRevision: service.revision, name: 'Cuenta editada' })).toMatchObject({ orderKind: 'service' });
    expect(await execute(owner, servicePayload)).toEqual(service);
    expect(await execute<Order>(owner, await draft(owner, undefined, 'Mostrador'))).toMatchObject({ orderKind: null });
  });

  test('sales-only cashiers can manage their own typed or legacy counter and cannot create a service order', async () => {
    const owner = await actor(), cashier = await actor(owner.businessId, ['catalog.read', 'sales.create']);
    const payload = await draft(owner, 'counter');
    const ownPayload = { ...payload, operationId: randomUUID(), orderId: randomUUID(), name: 'Cobro directo personal' };
    const counter = await execute<Order>(cashier, ownPayload);
    expect(counter.orderKind).toBe('counter');
    expect(await execute(cashier, { ...ownPayload, operationId: randomUUID(), expectedRevision: counter.revision })).toMatchObject({ id: counter.id, orderKind: 'counter' });
    await expect(execute(cashier, { ...payload, operationId: randomUUID(), orderId: randomUUID(), orderKind: 'service', name: 'Mostrador' })).rejects.toThrow('PERMISSION_DENIED');
    const legacyPayload = { ...payload, operationId: randomUUID(), orderId: randomUUID(), name: 'Mostrador' };
    delete legacyPayload.orderKind;
    const oldCounter = await execute<Order>(cashier, legacyPayload);
    expect(oldCounter.orderKind).toBeNull();
    expect(await execute(cashier, legacyPayload)).toEqual(oldCounter);
    expect((await execute<{ orders: Order[] }>(cashier, { command: 'operations' })).orders.map(row => row.id)).toContain(counter.id);
    const foreign = await execute<Order>(owner, payload);
    await expect(execute(cashier, { command: 'order', orderId: foreign.id })).rejects.toThrow('PERMISSION_DENIED');
  });

  test('a known service is never a cashier counter after grants change or on accepted replay', async () => {
    const owner = await actor(), manager = await actor(owner.businessId, ['catalog.read', 'sales.create', 'orders.read', 'orders.manage']);
    const payload = await draft(owner, 'service', 'Mostrador');
    const service = await execute<Order>(manager, payload);
    await db.query('update app_private.employees set permissions=$1 where id=$2', [['catalog.read', 'sales.create'], manager.employeeId]);
    await renewedOperator(manager);
    expect((await execute<{ orders: Order[] }>(manager, { command: 'operations' })).orders.map(row => row.id)).not.toContain(service.id);
    await expect(execute(manager, { command: 'order', orderId: service.id })).rejects.toThrow('PERMISSION_DENIED');
    await expect(execute(manager, payload)).rejects.toThrow('PERMISSION_DENIED');
    await expect(execute(manager, { ...payload, operationId: randomUUID(), expectedRevision: service.revision })).rejects.toThrow('PERMISSION_DENIED');
  });

  test('counter sends and table moves fail before any event or kitchen write while service works', async () => {
    const owner = await actor(), payload = await draft(owner, 'counter'), counter = await execute<Order>(owner, payload);
    const table = await execute<{ id: string }>(owner, { command: 'save_table', operationId: randomUUID(), tableId: randomUUID(), expectedRevision: null, name: 'Mesa sintética', active: true });
    await expect(execute(owner, { command: 'send_order', operationId: randomUUID(), orderId: counter.id, expectedRevision: counter.revision })).rejects.toThrow('PERMISSION_DENIED');
    await expect(execute(owner, { command: 'move_order', operationId: randomUUID(), orderId: counter.id, expectedRevision: counter.revision, tableId: table.id })).rejects.toThrow('PERMISSION_DENIED');
    const edit = { ...payload, operationId: randomUUID(), expectedRevision: counter.revision, tableId: table.id }; delete edit.orderKind;
    await expect(execute(owner, edit)).rejects.toThrow('ORDER_CHANGED');
    expect(await execute(owner, { command: 'order', orderId: counter.id })).toEqual(counter);
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.kitchen_batches where business_id=$1 and order_id=$2', [owner.businessId, counter.id])).rows[0].count).toBe(0);
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.order_events where business_id=$1 and order_id=$2', [owner.businessId, counter.id])).rows[0].count).toBe(1);
    let service = await execute<Order>(owner, { ...await draft(owner, 'service', 'Mostrador'), tableId: table.id });
    service = await execute(owner, { command: 'send_order', operationId: randomUUID(), orderId: service.id, expectedRevision: service.revision });
    expect(service.orderKind).toBe('service');
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.kitchen_batches where business_id=$1 and order_id=$2', [owner.businessId, service.id])).rows[0].count).toBe(1);
  });

  test('revoked sessions cannot replay accepted counter saves and cross-tenant references remain isolated', async () => {
    const owner = await actor(), other = await actor(), payload = await draft(owner, 'counter');
    const counter = await execute<Order>(owner, payload);
    await expect(execute(other, { command: 'order', orderId: counter.id })).rejects.toThrow('ORDER_NOT_FOUND');
    await db.query('update app_private.operator_sessions set revoked_at=clock_timestamp() where user_id=$1', [owner.userId]);
    await expect(execute(owner, payload)).rejects.toThrow('SESSION_INVALID');
  });

  test('confirmed reserved counter payment retains the paid-items kitchen path and integer receipt', async () => {
    const owner = await actor(), payload = await draft(owner, 'counter');
    let counter = await execute<Order>(owner, payload);
    await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 });
    counter = await execute(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: counter.id, expectedRevision: counter.revision });
    const quote = await execute<{ id: string; revision: number }>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: counter.id, expectedRevision: counter.revision, paymentMethod: 'cash',
      items: counter.items.map(line => ({ lineId: line.lineId, quantity: line.quantity })) });
    expect((await execute<Order>(owner, { command: 'order', orderId: counter.id })).balanceCents).toBe(1001);
    const payment = { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true };
    const receipt = await execute<{ order: Order; attempt: { totalCents: number; status: string } }>(owner, payment);
    expect(receipt.order).toMatchObject({ orderKind: 'counter', balanceCents: 0 });
    expect(receipt.attempt).toMatchObject({ totalCents: 1001, status: 'completed' });
    expect(await execute(owner, payment)).toEqual(receipt);
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.kitchen_batches where business_id=$1 and order_id=$2', [owner.businessId, counter.id])).rows[0].count).toBe(1);
    expect((await db.query<{ cents: number }>('select total_cents::integer cents from app_private.sales where business_id=$1', [owner.businessId])).rows[0].cents).toBe(1001);
  });

  test('the persisted type cannot be reassigned or removed by internal update paths', async () => {
    const owner = await actor(), counter = await execute<Order>(owner, await draft(owner, 'counter'));
    for (const kind of [null, 'service']) await expect(db.query('update app_private.operational_orders set order_kind=$1 where business_id=$2 and id=$3', [kind, owner.businessId, counter.id])).rejects.toThrow('ORDER_CHANGED');
    expect((await execute<Order>(owner, { command: 'order', orderId: counter.id })).orderKind).toBe('counter');
  });
});

async function actor(businessId?: string, permissions: string[] = []): Promise<Actor> {
  const value = { businessId: businessId ?? randomUUID(), userId: randomUUID(), sessionId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) };
  const role = businessId ? 'cashier' : 'owner';
  await db.query('insert into auth.users(id) values($1)', [value.userId]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.sessionId, value.userId]);
  if (!businessId) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"paymentMethods":["cash"],"accountsEnabled":true}')`, [value.businessId]);
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [value.businessId, value.userId, role]);
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Persona sintética',$4,$5)", [value.employeeId, value.businessId, value.userId, role, permissions]);
  if (businessId) await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')", [value.businessId, value.employeeId, value.keyHash]);
  await renewedOperator(value);
  if (!businessId) await execute(value, { command: 'activate_operations', operationId: randomUUID() });
  return value;
}
async function renewedOperator(value: Actor) {
  value.token = randomUUID().replaceAll('-', '').repeat(2);
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))", [value.businessId, value.userId, value.sessionId, value.token, value.keyHash]);
}
async function execute<T = unknown>(value: Actor, command: object): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>("select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) result", [value.userId, value.sessionId, JSON.stringify({ action: 'pos', businessId: value.businessId, operatorToken: value.token, ...command }), value.keyHash, randomUUID()])).rows[0].result;
  if (result.error) throw new Error(result.error.code);
  return result.data;
}
async function draft(owner: Actor, orderKind?: string, name = 'Mostrador'): Promise<Save> {
  const product = await execute<Product>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: '', priceCents: 1001 });
  return { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name, tableId: null, ...(orderKind ? { orderKind } : {}), items: [{ lineId: randomUUID(), productId: product.id, version: product.version, unitPriceCents: product.priceCents, quantity: 1, note: '' }] };
}
