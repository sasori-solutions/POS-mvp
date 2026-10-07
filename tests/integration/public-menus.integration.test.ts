import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OperatorSession } from '../../src/lib/contracts';
import type { Product, PosCommand } from '../../src/lib/pos-contracts';
import type { MenuConfiguration, PublicMenuDocument } from '../../src/lib/menu-contracts';
import { emptyDetails } from '../../src/lib/product-details';
import { signedRequest } from './device-proof-fixture';
const config = localConfig();
const users: string[] = [], businesses: string[] = []; let identity: { id: string; token: string }, operator: OperatorSession;
const admin = config ? client(config.serviceRoleKey) : null;
describe.skipIf(!config)('published menu through real signed owner Edge and anonymous public Edge/PostgreSQL', () => {
  beforeAll(async () => {
    const email = `public-menu-${randomUUID()}@example.test`, password = `Local-${randomUUID()}-Aa9!`;
    const created = await admin!.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw new Error('Synthetic menu Auth creation failed'); users.push(created.data.user.id);
    const signed = await client(config!.anonKey).auth.signInWithPassword({ email, password }); if (signed.error) throw new Error('Synthetic menu Auth login failed');
    identity = { id: created.data.user.id, token: signed.data.session!.access_token };
    operator = data(await call<OperatorSession>({ action: 'create_business', operationId: randomUUID(), name: 'Menú sintético', businessType: 'cafe', timezone: 'America/Hermosillo', pin: '583927',
      profile: { branchName: 'PRIVATE BRANCH', registerName: 'PRIVATE REGISTER', address: 'PRIVATE ADDRESS', city: '', state: '', contactPhone: '', defaultVatTreatment: 'exempt', paymentMethods: ['cash', 'transfer'], transferAccount: { beneficiary: 'PRIVATE RECEIVER', bank: 'PRIVATE BANK', clabe: '000000000000000000' } } })); businesses.push(operator.business.id);
  }, 60000);
  afterAll(async () => {
    if (!admin) return;
    if (businesses.length) { sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`); expect(sql(`select count(*) from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)).toBe('0'); }
    for (const id of users) { const result = await admin.auth.admin.deleteUser(id); if (result.error) throw new Error('Synthetic menu Auth cleanup failed'); }
  }, 60000);
  it('publishes a reviewed live menu with safe photos and conditional/combo availability, recovers its UUID, enforces tenant/CORS and closes the same QR on unpublish', async () => {
    const imageId = randomUUID(), image = readFileSync('tests/fixtures/profile-pixel.jpg').toString('base64'); expect(image.length).toBeLessThan(4096);
    data(await pos({ command: 'upload_product_image', operationId: randomUUID(), imageId, part: 0, parts: 1, data: image }));
    const parent = randomUUID(), child = randomUUID(), variation = randomUUID();
    const details = { ...emptyDetails(), imageId, customerName: 'Café público', kitchenName: 'PRIVATE PREPARATION', costCents: 321, stock: 12, sku: 'PRIVATE SKU', barcode: 'PRIVATE BARCODE', customAttributes: [{ name: 'PRIVATE NAME', value: 'PRIVATE VALUE' }], variations: [{ id: variation, name: 'Grande', priceCents: 1201, sku: 'PRIVATE VARIATION SKU', barcode: '', soldOut: false }], modifierSets: [
      { id: randomUUID(), name: 'Preparación', min: 1, max: 1, options: [{ id: parent, name: 'Con leche', priceCents: 0 }] },
      { id: randomUUID(), name: 'Leche', parentOptionId: parent, min: 1, max: 1, options: [{ id: child, name: 'Avena', priceCents: -25 }] },
    ] };
    const component = data(await pos<Product>({ command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'PRIVATE INTERNAL TITLE', category: 'Bebidas', priceCents: 1001, details }));
    const combo = data(await pos<Product>({ command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Desayuno', category: '', priceCents: 1800, details: { ...emptyDetails(), comboComponents: [{ productId: component.id, version: component.version, quantity: 2, selection: { variationId: variation, modifierIds: [parent, child].sort(), variablePriceCents: null } }] } }));
    const command = { command: 'save_menu', operationId: randomUUID(), menuId: randomUUID(), expectedRevision: null, name: 'Desayunos', locationLabel: 'Terraza', productIds: [component.id, combo.id], schedules: [], published: true } as const;
    const lost = await raw({ action: 'pos', ...args(), ...command }); expect(lost.status).toBe(200); await lost.body?.cancel();
    const menu = data(await pos<MenuConfiguration>(command)); expect(data(await pos(command))).toEqual(menu);
    const pairing = data(await call<{ pairingCode: string }>({ action: 'create_pairing_code', ...args(), operationId: randomUUID() }));
    const paired = data(await deviceCall<{ deviceToken: string }>({ action: 'device_pair', pairingCode: pairing.pairingCode, deviceName: 'Caja sintética', operationId: randomUUID() }));
    const pairedOwner = data(await deviceCall<OperatorSession>({ action: 'device_unlock', deviceToken: paired.deviceToken, employeeId: operator.business.employee!.id, pin: '583927' }));
    for (const deviceCommand of [{ command: 'menus' }, command]) expect((await deviceCall({ action: 'device_pos', deviceToken: paired.deviceToken, operatorToken: pairedOwner.operatorToken, ...deviceCommand })).error?.code).toBe('PERMISSION_DENIED');
    const foreign = data(await call<OperatorSession>({ action: 'create_business', operationId: randomUUID(), name: 'Otro menú sintético', businessType: 'cafe', timezone: 'America/Hermosillo', pin: '583927' })); businesses.push(foreign.business.id);
    const foreignProduct = data(await call<Product>({ action: 'pos', businessId: foreign.business.id, operatorToken: foreign.operatorToken, command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Otro producto', category: '', priceCents: 1 }));
    expect((await pos({ ...command, operationId: randomUUID(), menuId: randomUUID(), productIds: [foreignProduct.id] })).error?.code).toBe('PRODUCT_CHANGED');
    const first = await publicRead(menu.publicId); expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store');
    const document: PublicMenuDocument = (await first.json()).data;
    expect(document).toMatchObject({ businessName: 'Menú sintético', locationLabel: 'Terraza', availability: 'open', products: [{ name: 'Café público', image: `data:image/jpeg;base64,${image}`, available: true }, { name: 'Desayuno', available: true, comboComponents: [{ name: 'Café público', quantity: 2 }] }] });
    expect(JSON.stringify(document)).not.toMatch(/PRIVATE|costCents|stock|transferAccount|operatorToken|deviceToken|kitchenName|sku|barcode|customAttributes|comboUnavailableReason|businessId|permissions|version/);
    const changed = data(await pos<Product>({ command: 'save_product', operationId: randomUUID(), productId: component.id, expectedVersion: component.version, name: component.name, category: 'Bebidas', priceCents: 1111 }));
    const current: PublicMenuDocument = (await (await publicRead(menu.publicId)).json()).data; expect(current.products[0].priceCents).toBe(1111); expect(current.products[1].comboComponents).toEqual(document.products[1].comboComponents);
    data(await pos({ command: 'set_modifier_option_sold_out', operationId: randomUUID(), productId: component.id, expectedVersion: changed.version, modifierId: child, soldOut: true }));
    const unavailable: PublicMenuDocument = (await (await publicRead(menu.publicId)).json()).data; expect(unavailable.products.map(product => product.available)).toEqual([false, false]); expect(JSON.stringify(unavailable)).not.toContain('PRIVATE');
    const invalid = await fetch(`${config!.url}/functions/v1/public-menu?menuId=${menu.publicId}&businessId=${operator.business.id}`, { headers: { apikey: config!.anonKey } }); expect(invalid.status).toBe(400);
    expect((await publicRead(menu.publicId, 'https://wrong.example.test')).status).toBe(403);
    const unavailableLink = await publicRead(randomUUID()); expect(unavailableLink.status).toBe(404);
    const hidden = data(await pos<MenuConfiguration>({ ...command, operationId: randomUUID(), expectedRevision: menu.revision, published: false })); expect(hidden.publicId).toBe(menu.publicId);
    const revoked = await publicRead(menu.publicId); expect(revoked.status).toBe(404); expect(await revoked.json()).toEqual(await unavailableLink.json());
    expect(data(await pos(command))).toEqual(menu); expect((await publicRead(menu.publicId)).status).toBe(404);
  }, 30000);
});
function localConfig() {
  const url = process.env.TEST_SUPABASE_URL; if (!url) return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Public-menu integration refuses non-loopback services');
  const anonKey = process.env.TEST_SUPABASE_ANON_KEY, serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY, container = process.env.TEST_LOCAL_DB_CONTAINER;
  if (!anonKey || !serviceRoleKey || !container || !/^supabase_db_[a-z0-9_-]+$/.test(container)) throw new Error('Explicit local menu integration configuration is required');
  return { url, anonKey, serviceRoleKey, container };
}
function client(key: string) { return createClient(config!.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }); }
function args() { return { businessId: operator.business.id, operatorToken: operator.operatorToken }; }
function pos<T = unknown>(command: PosCommand | object) { return call<T>({ action: 'pos', ...args(), ...command }); }
async function raw(request: Record<string, unknown>) { return fetch(`${config!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey, authorization: `Bearer ${identity.token}` }, body: JSON.stringify(await signedRequest(identity.id, request)), signal: AbortSignal.timeout(15000) }); }
async function call<T = unknown>(request: Record<string, unknown>): Promise<{ status: number; data?: T; error?: { code: string } }> { const response = await raw(request); return { status: response.status, ...await response.json() }; }
async function deviceCall<T = unknown>(request: Record<string, unknown>): Promise<{ status: number; data?: T; error?: { code: string } }> {
  const response = await fetch(`${config!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
  return { status: response.status, ...await response.json() };
}
function publicRead(id: string, origin = 'http://127.0.0.1:5173') { return fetch(`${config!.url}/functions/v1/public-menu?menuId=${id}`, { headers: { apikey: config!.anonKey, origin }, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000) }); }
function data<T>(reply: { status: number; data?: T; error?: { code: string } }): T { expect(reply.status, JSON.stringify(reply.error)).toBe(200); expect(reply.data).toBeDefined(); return reply.data!; }
function uuid(id: string) { if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid fixture UUID'); return `'${id}'::uuid`; }
function sql(query: string) { return execFileSync('docker', ['exec', '-i', config!.container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atq'], { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
