import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessContext, DeviceSummary, OperatorSession, TransferAccount } from '../../src/lib/contracts';
import type { Product, Sale, PosCommand } from '../../src/lib/pos-contracts';
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts';
import { emptyDetails } from '../../src/lib/product-details';
import { signedRequest } from './device-proof-fixture';
const config = localConfig();
type Identity = { id: string; token: string; email: string; password: string; browser: string };
type Operator = { identity: Identity; session: OperatorSession };
type Reply<T> = { status: number; data?: T; error?: { code: string } };
const users: string[] = [], businesses: string[] = []; const pin = '583927';
let admin: SupabaseClient, owner: Identity, kitchenIdentity: Identity, cashierIdentity: Identity;
const bank: TransferAccount = { beneficiary: 'Comercio sintético', bank: 'Banco sintético', clabe: '000000000000000000' };
describe.skipIf(!config)('restaurant foundation through real loopback Auth, signed Edge and PostgreSQL', () => {
  beforeAll(async () => { admin = client(config!.serviceRoleKey); [owner, kitchenIdentity, cashierIdentity] = await Promise.all([identity(), identity(), identity()]); }, 60000);
  afterAll(async () => {
    if (!admin) return;
    if (businesses.length) { sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`); expect(sql(`select count(*) from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)).toBe('0'); }
    for (const id of users) { const result = await admin.auth.admin.deleteUser(id); if (result.error) throw new Error('Synthetic restaurant Auth cleanup failed'); }
  }, 60000);

  it('persists the explicitly chosen timezone/tax and receiving details, keeps them private from summaries and kitchen, and confirms a transfer exactly once', async () => {
    const operator = await business();
    expect(operator.session.business).toMatchObject({ timezone: 'America/Hermosillo', profile: { defaultVatTreatment: 'exempt', transferAccount: bank } });
    const summary = data(await call<{ businesses: unknown[] }>(owner, { action: 'status' })); expect(JSON.stringify(summary)).not.toMatch(/clabe|beneficiary|Comercio sintético/);
    const kitchen = await employee(operator, kitchenIdentity, 'kitchen', ['kitchen.read']);
    const cashier = await employee(operator, cashierIdentity, 'cashier', ['catalog.read', 'sales.create', 'orders.read', 'orders.manage']);
    expect(kitchen.session.business.profile).not.toHaveProperty('transferAccount'); expect(cashier.session.business.profile.transferAccount).toEqual(bank);
    const source = data(await pos<Product>(operator, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café sintético', category: '', priceCents: 1001, details: { ...emptyDetails(), taxTreatment: 'exempt', taxBps: 0 } }));
    data(await pos(operator, { command: 'activate_operations', operationId: randomUUID() })); data(await pos(operator, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 }));
    let order = data(await pos<OperationalOrder>(operator, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta transferencia', tableId: null, orderKind: 'service', items: [{ lineId: randomUUID(), productId: source.id, version: source.version, quantity: 1, unitPriceCents: 1001, note: '' }] }));
    order = data(await pos<OperationalOrder>(operator, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }));
    const attempt = data(await pos<CheckoutAttempt>(operator, { command: 'prepare_checkout', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity: 1 }], paymentMethod: 'transfer' }));
    const payment = { command: 'record_checkout', operationId: randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, confirmed: true } as const;
    expect((await raw(owner, { action: 'pos', ...args(operator), ...payment, confirmed: false })).status).toBe(400);
    expect(count('sales', operator)).toBe(0);
    const lost = await raw(owner, { action: 'pos', ...args(operator), ...payment }); expect(lost.status).toBe(200); await lost.body?.cancel();
    const accepted = data(await pos<{ attempt: CheckoutAttempt }>(operator, payment)); expect(data(await pos(operator, payment))).toEqual(accepted); expect(count('sales', operator)).toBe(1);
    expect(data(await pos<Sale>(operator, { command: 'sale', saleId: accepted.attempt.saleId! }))).toMatchObject({ totalCents: 1001, paymentMethod: 'transfer', items: [{ taxCents: 0 }] });
    expect((await call(owner, { action: 'update_business', ...args(operator), name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Hermosillo', profile: { ...operator.session.business.profile, transferAccount: { ...bank, clabe: '000000000000000001' } } })).error?.code).toBe('VALIDATION_ERROR');
  }, 30000);

  it('stores atomic import/bulk receipts, recovers an accepted HTTP response after later edits and preserves the old sale snapshot', async () => {
    const operator = await business(); const productId = randomUUID();
    const input: Extract<PosCommand, { command: 'import_products' }> = { command: 'import_products', operationId: randomUUID(), items: [{ productId, expectedVersion: null, name: 'Producto inicial', category: '', priceCents: 1001, active: true, details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 } }] };
    const source = data(await pos<{ products: Product[] }>(operator, input)).products[0];
    const receipt = data(await pos<Sale>(operator, { command: 'complete_sale', operationId: randomUUID(), items: [{ productId, version: source.version, quantity: 1, unitPriceCents: 1001 }], totalCents: 1001, paymentMethod: 'cash' }));
    const command: Extract<PosCommand, { command: 'bulk_edit_products' }> = { command: 'bulk_edit_products', operationId: randomUUID(), products: [{ productId, expectedVersion: source.version }], patch: { category: 'Nueva categoría', priceCents: 1111, active: false, vatTreatment: 'exempt' } };
    const lost = await raw(owner, { action: 'pos', ...args(operator), ...command }); expect(lost.status).toBe(200); await lost.body?.cancel();
    const accepted = data(await pos<{ products: Product[] }>(operator, command)); expect(accepted.products[0]).toMatchObject({ active: false, priceCents: 1111, details: { taxTreatment: 'exempt' } });
    data(await pos(operator, { command: 'save_product', operationId: randomUUID(), productId, expectedVersion: accepted.products[0].version, name: 'Edición posterior', category: '', priceCents: 2222 }));
    const replay = await Promise.all([pos(operator, command), pos(operator, command)]); expect(replay.map(data)).toEqual([accepted, accepted]);
    expect(data(await pos(operator, { command: 'sale', saleId: receipt.id }))).toEqual(receipt); expect(count('products', operator)).toBe(1);
    const stale: Extract<PosCommand, { command: 'import_products' }> = { command: 'import_products', operationId: randomUUID(), items: [{ ...input.items[0], productId: randomUUID(), expectedVersion: null }, { ...input.items[0], expectedVersion: 1 }] };
    expect((await pos(operator, stale)).error?.code).toBe('PRODUCT_CHANGED'); expect(count('products', operator)).toBe(1);
  }, 30000);

  it('lists distinct signed owner browsers, revokes only the selected browser and refuses both its old token and a fresh PIN unlock', async () => {
    const operator = await business();
    const another = await login(owner.email, owner.password, owner.id, `secondary-${operator.session.business.id}`);
    const secondary: Operator = { identity: another, session: data(await call<OperatorSession>(another, { action: 'unlock', businessId: operator.session.business.id, pin, deviceName: 'Segundo navegador sintético' })) };
    const team = data(await call<{ devices: DeviceSummary[] }>(owner, { action: 'team', ...args(operator) }));
    expect(team.devices.filter(device => device.kind === 'owner_browser' && device.active)).toHaveLength(2); expect(team.devices.filter(device => device.current)).toHaveLength(1); expect(team.devices.every(device => device.lastSeenAt)).toBe(true);
    expect(JSON.stringify(team.devices)).not.toMatch(/publicKey|key_hash|operatorToken|deviceToken/);
    const other = team.devices.find(device => device.kind === 'owner_browser' && !device.current)!;
    data(await call(owner, { action: 'revoke_device', ...args(operator), deviceId: other.id }));
    expect((await call(another, { action: 'context', ...args(secondary) })).error?.code).toBe('SESSION_INVALID');
    expect((await call(another, { action: 'unlock', businessId: operator.session.business.id, pin })).error?.code).toBe('DEVICE_REVOKED');
    expect(data(await call<{ business: BusinessContext }>(owner, { action: 'context', ...args(operator) })).business.id).toBe(operator.session.business.id);
    const current = team.devices.find(device => device.current)!; data(await call(owner, { action: 'revoke_device', ...args(operator), deviceId: current.id }));
    expect((await call(owner, { action: 'context', ...args(operator) })).error?.code).toBe('SESSION_INVALID');
  }, 30000);
});
function localConfig() {
  const url = process.env.TEST_SUPABASE_URL; if (!url) return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Restaurant integration refuses non-loopback services');
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY, serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY, container = process.env.TEST_LOCAL_DB_CONTAINER;
  if (!anonKey || !serviceRoleKey || !container || !/^supabase_db_[a-z0-9_-]+$/.test(container)) throw new Error('Explicit local restaurant integration configuration is required');
  return { url, anonKey, serviceRoleKey, container };
}
function client(key: string) { return createClient(config!.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }); }
async function identity() {
  const email = `restaurant-${randomUUID()}@example.test`, password = `Local-${randomUUID()}-Aa9!`;
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (result.error) throw new Error('Synthetic Auth creation failed'); users.push(result.data.user.id);
  return login(email, password, result.data.user.id, result.data.user.id);
}
async function login(email: string, password: string, id: string, browser: string): Promise<Identity> {
  const result = await client(config!.anonKey).auth.signInWithPassword({ email, password }); if (result.error) throw new Error('Synthetic Auth login failed');
  return { id, email, password, browser, token: result.data.session!.access_token };
}
async function business(): Promise<Operator> {
  const session = data(await call<OperatorSession>(owner, { action: 'create_business', operationId: randomUUID(), name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Hermosillo', pin,
    profile: { branchName: 'Principal', registerName: 'Caja', address: '', city: '', state: '', contactPhone: '', accountsEnabled: true, defaultVatTreatment: 'exempt', transferAccount: bank, paymentMethods: ['cash', 'transfer'] } }));
  businesses.push(session.business.id); return { identity: owner, session };
}
async function employee(operator: Operator, person: Identity, role: 'cashier' | 'kitchen', permissions: string[]): Promise<Operator> {
  const created = data(await call<{ invitation: { invitationCode: string } }>(owner, { action: 'create_employee', ...args(operator), operationId: randomUUID(), name: 'Persona sintética', role, permissions, pin: null, inviteWithGoogle: true }));
  return { identity: person, session: data(await call<OperatorSession>(person, { action: 'accept_invitation', operationId: randomUUID(), invitationCode: created.invitation.invitationCode, pin: '024680' })) };
}
function args(operator: Operator) { return { businessId: operator.session.business.id, operatorToken: operator.session.operatorToken }; }
function pos<T = unknown>(operator: Operator, command: PosCommand) { return call<T>(operator.identity, { action: 'pos', ...args(operator), ...command }); }
async function raw(person: Identity, request: Record<string, unknown>) { return fetch(`${config!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey, authorization: `Bearer ${person.token}` }, body: JSON.stringify(await signedRequest(person.browser, request)), signal: AbortSignal.timeout(15000) }); }
async function call<T = unknown>(person: Identity, request: Record<string, unknown>): Promise<Reply<T>> { const response = await raw(person, request); return { status: response.status, ...await response.json() }; }
function data<T>(reply: Reply<T>): T { expect(reply.status, JSON.stringify(reply.error)).toBe(200); expect(reply.data).toBeDefined(); return reply.data!; }
function uuid(id: string) { if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid fixture UUID'); return `'${id}'::uuid`; }
function sql(query: string) { return execFileSync('docker', ['exec', '-i', config!.container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function count(table: 'products' | 'sales', operator: Operator) { return Number(sql(`select count(*) from app_private.${table} where business_id=${uuid(operator.session.business.id)};`)); }
