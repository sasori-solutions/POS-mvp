import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessContext, BusinessProfile, OperatorSession } from '../../src/lib/contracts';
import type { OperationalOrder } from '../../src/lib/operations-contracts';
import { profileJpeg } from '../fixtures/profile-image';

const migration = '20261005011000_business_preferences_images.sql';
const profile: BusinessProfile = { branchName: 'Principal', registerName: 'Caja', address: 'Dirección privada', city: 'Ciudad', state: 'Estado', contactPhone: '', paymentMethods: ['cash', 'card_integrated'] };
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string };
let db: PGlite;
let legacy: Actor;
let legacyCreate: Record<string, unknown>;

describe('business preferences and private profile images', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`);
    const migrations = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort();
    for (const file of migrations.filter(file => file < migration)) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    legacy = await identity();
    legacyCreate = { action: 'create_business', name: 'Negocio anterior', businessType: 'cafe', timezone: 'America/Mexico_City', profile, operationId: randomUUID(), pin: '024680' };
    const created = await account<OperatorSession>(legacy, 'create_business', legacyCreate);
    legacy.businessId = created.business.id; legacy.token = created.operatorToken; legacy.employeeId = created.business.employee!.id;
    await db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'));
  }, 90_000);
  afterAll(async () => { await db?.close(); });

  it('preserves accepted creation fingerprints and defaults for legacy businesses', async () => {
    const retried = await account<OperatorSession>(legacy, 'create_business', legacyCreate);
    expect(retried.business.id).toBe(legacy.businessId);
    expect(retried.business.profile).toMatchObject({ accountsEnabled: true, defaultVatTreatment: 'vat_16' });
    expect(retried.business.logoUrl).toBeNull();
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.businesses')).rows[0].count).toBe(1);
  });

  it('validates optional preferences without changing the shape of older payloads', async () => {
    expect((await db.query<{ value: BusinessProfile }>('select app_private.validate_profile($1::jsonb) value', [JSON.stringify(profile)])).rows[0].value).toEqual(profile);
    for (const patch of [{ accountsEnabled: 'false' }, { accountsEnabled: null }, { defaultVatTreatment: 'taxable' }, { defaultVatTreatment: null }, { logoImageId: 'https://example.test/a.jpg' }, { unknown: true }])
      await expect(db.query('select app_private.validate_profile($1::jsonb)', [JSON.stringify({ ...profile, ...patch })])).rejects.toThrow('VALIDATION_ERROR');
    const owner = await actor();
    const saved = await update(owner, { accountsEnabled: false, defaultVatTreatment: 'exempt' });
    expect(saved.profile).toMatchObject({ accountsEnabled: false, defaultVatTreatment: 'exempt' });
    // A cached older client cannot erase the newer settings with a seven-key profile.
    expect((await update(owner, {})).profile).toMatchObject({ accountsEnabled: false, defaultVatTreatment: 'exempt' });
  });

  it('publishes only a fully uploaded bounded JPEG and deduplicates response-loss retries', async () => {
    const owner = await actor();
    const data = jpegEnvelope(3400), imageId = randomUUID();
    const first = upload(owner, 'business', imageId, data, 0), last = upload(owner, 'business', imageId, data, 1);
    expect(await account(owner, 'upload_profile_image', first)).toEqual({ imageId, complete: false });
    expect(await context(owner)).toMatchObject({ logoUrl: null });
    expect(await account(owner, 'upload_profile_image', first)).toEqual({ imageId, complete: false });
    const complete = await account<{ complete: boolean; business: BusinessContext }>(owner, 'upload_profile_image', last);
    expect(complete.complete).toBe(true);
    expect(complete.business.logoUrl).toBe(`data:image/jpeg;base64,${data}`);
    expect(complete.business.profile.logoImageId).toBe(imageId);
    expect(await account(owner, 'upload_profile_image', last)).toEqual(complete);
    await expect(account(owner, 'upload_profile_image', { ...last, data: last.data.replace(/^./, last.data[0] === 'A' ? 'B' : 'A') })).rejects.toThrow('OPERATION_CONFLICT');
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.profile_image_parts where image_id=$1', [imageId])).rows[0].count).toBe(0);
  });

  it('rejects foreign logos, malformed files and mismatched image ownership atomically', async () => {
    const owner = await actor(), other = await actor();
    const data = jpegEnvelope(40), imageId = randomUUID();
    await account(owner, 'upload_profile_image', upload(owner, 'business', imageId, data));
    await expect(update(other, { logoImageId: imageId })).rejects.toThrow('VALIDATION_ERROR');
    await expect(account(other, 'upload_profile_image', upload(other, 'business', imageId, data))).rejects.toThrow('OPERATION_CONFLICT');
    const invalidImage = randomUUID();
    await expect(account(owner, 'upload_profile_image', upload(owner, 'business', invalidImage, Buffer.from('not a JPEG').toString('base64')))).rejects.toThrow('VALIDATION_ERROR');
    expect((await db.query<{ count: number }>('select count(*)::integer count from app_private.profile_images where id=$1', [invalidImage])).rows[0].count).toBe(0);
    for (const patch of [{ parts: 61 }, { part: 1 }, { data: 'AAA' }, { data: '<svg></svg>' }, { url: 'https://example.test/image.jpg' }])
      await expect(account(owner, 'upload_profile_image', { ...upload(owner, 'business', randomUUID(), data), ...patch })).rejects.toThrow('VALIDATION_ERROR');
  });

  it('allows personal employees to edit only their own avatar, keeps operational preferences visible and contact private', async () => {
    const owner = await actor(), staff = await actor('cashier', owner.businessId);
    await update(owner, { accountsEnabled: false, defaultVatTreatment: 'vat_0' });
    const data = jpegEnvelope(40), imageId = randomUUID();
    const own = await account<{ business: BusinessContext }>(staff, 'upload_profile_image', upload(staff, 'account', imageId, data));
    expect(own.business.accountAvatarUrl).toBe(`data:image/jpeg;base64,${data}`);
    expect(own.business.profile).toMatchObject({ accountsEnabled: false, defaultVatTreatment: 'vat_0', address: '', contactPhone: '', paymentMethods: ['cash', 'card_integrated'] });
    expect((await context(owner)).accountAvatarUrl).toBeNull();
    await expect(account(staff, 'upload_profile_image', upload(staff, 'business', randomUUID(), data))).rejects.toThrow('PERMISSION_DENIED');
    await expect(account(owner, 'upload_profile_image', upload(owner, 'account', imageId, data))).rejects.toThrow('OPERATION_CONFLICT');
    const removal = { ...args(staff), action: 'remove_profile_image', subject: 'account', operationId: randomUUID() };
    expect(await account(staff, 'remove_profile_image', removal)).toMatchObject({ removed: true, business: { accountAvatarUrl: null } });
    await db.query('update app_private.operator_sessions set revoked_at=clock_timestamp() where user_id=$1', [staff.userId]);
    await expect(account(staff, 'remove_profile_image', removal)).rejects.toThrow('SESSION_INVALID');
  });

  it('replays image receipts with current profile and grants without reverting newer images', async () => {
    const owner = await actor(), staff = await actor('cashier', owner.businessId);
    const first = upload(staff, 'account', randomUUID(), jpegEnvelope(40));
    await account(staff, 'upload_profile_image', first);
    const removal = { ...args(staff), subject: 'account', operationId: randomUUID() };
    await account(staff, 'remove_profile_image', removal);
    const latest = upload(staff, 'account', randomUUID(), jpegEnvelope(80));
    const saved = await account<{ business: BusinessContext }>(staff, 'upload_profile_image', latest);
    await db.query('update app_private.employees set permissions=$1 where id=$2', [['catalog.read'], staff.employeeId]);
    await expect(account(staff, 'upload_profile_image', first)).rejects.toThrow('SESSION_INVALID');
    await renewedOperator(staff);
    for (const [action, command] of [['upload_profile_image', first], ['remove_profile_image', removal]] as const) {
      const replay = await account<{ business: BusinessContext }>(staff, action, { ...command, ...args(staff) });
      expect(replay.business.accountAvatarUrl).toBe(saved.business.accountAvatarUrl);
      expect(replay.business.permissions).toEqual(['catalog.read']);
    }
    expect((await context(staff)).accountAvatarUrl).toBe(saved.business.accountAvatarUrl);
  });

  it('blocks new named accounts when disabled and preserves existing accounts plus direct checkout', async () => {
    const owner = await actor();
    await pos(owner, { command: 'activate_operations', operationId: randomUUID() });
    const product = await pos<{ id: string; version: number; priceCents: number }>(owner, { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Producto sintético', category: '', priceCents: 11600 });
    const draft = { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, name: 'Cuenta anterior', tableId: null,
      items: [{ lineId: randomUUID(), productId: product.id, quantity: 1, version: product.version, unitPriceCents: product.priceCents, note: '' }] };
    const existing = await pos<OperationalOrder>(owner, draft);
    await update(owner, { accountsEnabled: false });
    await expect(pos(owner, { ...draft, operationId: randomUUID(), orderId: randomUUID(), name: 'Cuenta nueva' })).rejects.toThrow('PERMISSION_DENIED');
    expect(await pos(owner, { ...draft, operationId: randomUUID(), orderId: randomUUID(), name: 'Mostrador' })).toHaveProperty('id');
    expect(await pos(owner, { ...draft, operationId: randomUUID(), orderId: existing.id, expectedRevision: existing.revision, name: 'Cuenta anterior editada' })).toMatchObject({ id: existing.id });
    expect(await pos(owner, draft)).toMatchObject({ id: existing.id });
    const cashier = await actor('cashier', owner.businessId);
    await db.query('update app_private.employees set permissions=$1 where id=$2', [['catalog.read', 'sales.create'], cashier.employeeId]);
    await renewedOperator(cashier);
    const ownCounter = await pos<OperationalOrder>(cashier, { ...draft, operationId: randomUUID(), orderId: randomUUID(), name: 'Mostrador', items: [{ ...draft.items[0], lineId: randomUUID() }] });
    expect(ownCounter.name).toBe('Mostrador');
    expect(await pos(cashier, { ...draft, operationId: randomUUID(), orderId: ownCounter.id, expectedRevision: ownCounter.revision, name: 'Mostrador', items: [] })).toMatchObject({ id: ownCounter.id });
  });

  it('keeps image tables and helpers unavailable to browser roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['profile_images', 'profile_image_parts', 'account_profiles', 'profile_image_operations'])
        expect((await db.query<{ allowed: boolean }>('select has_table_privilege($1,$2,\'SELECT\') allowed', [role, `app_private.${table}`])).rows[0].allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,\'app_private.profile_image_manage(uuid,uuid,text,jsonb)\',\'EXECUTE\') allowed', [role])).rows[0].allowed).toBe(false);
    }
  });
});

async function identity(): Promise<Actor> {
  const value = { userId: randomUUID(), sessionId: randomUUID(), businessId: randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) };
  await db.query('insert into auth.users(id) values($1)', [value.userId]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.sessionId, value.userId]);
  return value;
}
async function actor(role = 'owner', existingBusiness?: string) {
  const value = await identity(); value.businessId = existingBusiness ?? value.businessId;
  if (!existingBusiness) await db.query("insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City',$2::jsonb)", [value.businessId, JSON.stringify(profile)]);
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [value.businessId, value.userId, role]);
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Persona sintética',$4,$5)", [value.employeeId, value.businessId, value.userId, role, role === 'owner' ? [] : ['catalog.read', 'orders.read', 'orders.manage']]);
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))", [value.businessId, value.userId, value.sessionId, value.token, value.keyHash]);
  if (role !== 'owner') await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')", [value.businessId, value.employeeId, value.keyHash]);
  return value;
}
function args(value: Actor) { return { businessId: value.businessId, operatorToken: value.token }; }
async function renewedOperator(value: Actor) {
  value.token = randomUUID().replaceAll('-', '').repeat(2);
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))", [value.businessId, value.userId, value.sessionId, value.token, value.keyHash]);
}
async function account<T = unknown>(value: Actor, action: string, payload: object): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>('select public.account_secure($1,$2,$3,$4::jsonb,$5,$6) result', [value.userId, value.sessionId, action, JSON.stringify({ action, ...payload }), value.keyHash, randomUUID()])).rows[0].result;
  if (result.error) throw new Error(result.error.code); return result.data;
}
async function context(value: Actor) { return (await account<{ business: BusinessContext }>(value, 'context', args(value))).business; }
function update(value: Actor, patch: Partial<BusinessProfile>) { return account<BusinessContext>(value, 'update_business', { ...args(value), name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', profile: { ...profile, ...patch } }); }
function pos<T = unknown>(value: Actor, command: object) { return account<T>(value, 'pos', { ...args(value), ...command }); }
function jpegEnvelope(size: number) { return profileJpeg(size); }
function upload(value: Actor, subject: 'business' | 'account', imageId: string, data: string, part = 0) {
  return { action: 'upload_profile_image', ...args(value), subject, imageId, operationId: randomUUID(), part, parts: Math.ceil(data.length / 4096), data: data.slice(part * 4096, (part + 1) * 4096) };
}
