import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessContext, BusinessProfile, OperatorSession, TeamContext } from '../../src/lib/contracts';

const migration = '20261007100000_business_setup_defaults.sql';
const profile: BusinessProfile = { branchName: 'Principal', registerName: 'Caja', address: 'Privada', city: '', state: '', contactPhone: '', paymentMethods: ['cash', 'transfer'] };
// Synthetic receiving account; validation does not assert existence or ownership.
const bank = { beneficiary: 'Comercio sintético', bank: 'Banco sintético', clabe: '000000000000000000' };
type Actor = { user: string; auth: string; business: string; employee: string; token: string; key: string };
let db: PGlite; let legacy: Actor; let legacyPayload: object;

describe('private receiving instructions and persisted browser devices', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await db.exec('create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role; create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);');
    const files = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort();
    for (const file of files.filter(file => file < migration)) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    legacy = await identity();
    legacyPayload = { name: 'Negocio anterior', businessType: 'cafe', timezone: 'America/Mexico_City', profile, operationId: randomUUID(), pin: '024680' };
    const created = await command<OperatorSession>(legacy, 'create_business', legacyPayload);
    legacy.business = created.business.id; legacy.employee = created.business.employee!.id; legacy.token = created.operatorToken;
    for (const file of files.filter(file => file >= migration && file <= '20261007110000_device_visibility.sql')) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it('preserves legacy creation replay, historical tax defaults and owner signed-browser backfill', async () => {
    const retried = await command<OperatorSession>(legacy, 'create_business', legacyPayload);
    expect(retried.business.id).toBe(legacy.business); legacy.token = retried.operatorToken;
    expect((await context(legacy)).profile.defaultVatTreatment).toBe('vat_16');
    const devices = (await command<TeamContext>(legacy, 'team', args(legacy))).devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ kind: 'owner_browser', active: true, current: true });
    expect(JSON.stringify(devices)).not.toContain(legacy.key);
  });

  it('validates exact CLABE/text shape and keeps omitted bank details during older-client updates', async () => {
    const owner = await actor();
    expect((await update(owner, { transferAccount: bank })).profile.transferAccount).toEqual(bank);
    expect((await update(owner, {})).profile.transferAccount).toEqual(bank);
    for (const transferAccount of [{ ...bank, clabe: '000000000000000001' }, { ...bank, clabe: 0 }, { ...bank, clabe: '٠'.repeat(18) }, { ...bank, password: 'forbidden' }, { ...bank, beneficiary: ' ' }, { ...bank, bank: null }, ['bank']])
      await expect(db.query('select app_private.validate_profile($1::jsonb)', [JSON.stringify({ ...profile, transferAccount })])).rejects.toThrow('VALIDATION_ERROR');
    expect((await update(owner, { transferAccount: null })).profile.transferAccount).toBeNull();
    await update(owner, { transferAccount: bank });
    await expect(command(legacy, 'update_business', { ...args(legacy), businessId: owner.business, name: 'No permitido', businessType: 'cafe', timezone: 'America/Mexico_City', profile })).rejects.toThrow('BUSINESS_ACCESS_DENIED');
  });

  it('reveals receiving details only after unlock to owners and employees with live sales.create', async () => {
    const owner = await actor(); await update(owner, { transferAccount: bank });
    const cashier = await actor('cashier', owner.business, ['catalog.read', 'sales.create']);
    const kitchen = await actor('kitchen', owner.business, ['kitchen.read']);
    expect((await context(cashier)).profile.transferAccount).toEqual(bank);
    expect((await context(kitchen)).profile).not.toHaveProperty('transferAccount');
    const status = await command( owner, 'status', {});
    expect(JSON.stringify(status)).not.toContain(bank.clabe);
    await expect(command(cashier, 'team', args(cashier))).rejects.toThrow('PERMISSION_DENIED');
    await db.query('update app_private.employees set permissions=$1 where id=$2', [['catalog.read'], cashier.employee]);
    await expect(context(cashier)).rejects.toThrow('SESSION_INVALID');
    await renewed(cashier);
    expect((await context(cashier)).profile).not.toHaveProperty('transferAccount');
  });

  it('lists owner, employee and shared-register devices with activity and no credentials', async () => {
    const owner = await actor(); const cashier = await actor('cashier', owner.business, ['catalog.read', 'sales.create']);
    await context(owner); await context(cashier);
    const register = randomUUID();
    await db.query("insert into app_private.devices(id,business_id,name,register_name,token_hash) values($1,$2,'Tablet sintética','Caja 1',extensions.digest($3,'sha256'))", [register, owner.business, 'd'.repeat(64)]);
    const devices = (await command<TeamContext>(owner, 'team', args(owner))).devices;
    expect(devices.map(device => device.kind).sort()).toEqual(['employee_browser', 'owner_browser', 'register']);
    expect(devices.find(device => device.current)).toMatchObject({ kind: 'owner_browser', active: true });
    expect(devices.find(device => device.kind === 'employee_browser')!.lastSeenAt).toBeTruthy();
    expect(JSON.stringify(devices)).not.toContain('key_hash');
    expect(JSON.stringify(devices)).not.toContain('token');
    const other = await actor();
    await expect(command(other, 'revoke_device', { ...args(other), deviceId: register })).rejects.toThrow('BUSINESS_ACCESS_DENIED');
  });

  it('revokes only the selected owner browser across auth sessions and does not revive on another PIN unlock', async () => {
    const owner = await actor(); await context(owner);
    const another = { ...owner, auth: randomUUID(), key: 'b'.repeat(64), token: '' };
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [another.auth, another.user]);
    another.token = (await command<OperatorSession>(another, 'unlock', { businessId: owner.business, pin: '024680', deviceName: 'Segundo navegador' })).operatorToken;
    const devices = (await command<TeamContext>(owner, 'team', args(owner))).devices;
    const target = devices.find(device => !device.current)!;
    expect(await command(owner, 'revoke_device', { ...args(owner), deviceId: target.id })).toEqual({ revoked: true });
    expect(await command(owner, 'revoke_device', { ...args(owner), deviceId: target.id })).toEqual({ revoked: true });
    await expect(context(another)).rejects.toThrow('SESSION_INVALID');
    await expect(command(another, 'unlock', { businessId: owner.business, pin: '024680' })).rejects.toThrow('DEVICE_REVOKED');
    expect((await context(owner)).id).toBe(owner.business);
    expect((await command<TeamContext>(owner, 'team', args(owner))).devices.find(device => device.id === target.id)!.active).toBe(false);
  });

  it('revokes a personal employee until explicit approval and rejects a stale device ID after replacement', async () => {
    const owner = await actor(); const cashier = await actor('cashier', owner.business, ['catalog.read', 'sales.create']);
    await context(cashier);
    const device = (await command<TeamContext>(owner, 'team', args(owner))).devices.find(item => item.kind === 'employee_browser')!;
    await command(owner, 'revoke_device', { ...args(owner), deviceId: device.id });
    await expect(context(cashier)).rejects.toThrow('SESSION_INVALID');
    await expect(command(cashier, 'unlock', { businessId: cashier.business, pin: '024680' })).rejects.toThrow('DEVICE_APPROVAL_REQUIRED');
    const notification = (await db.query<{ id: string }>("select id from app_private.owner_notifications where business_id=$1 and employee_id=$2 and status='pending'", [owner.business, cashier.employee])).rows[0];
    expect(notification).toBeTruthy();
    await command(owner, 'review_employee_device', { ...args(owner), notificationId: notification.id, decision: 'approve' });
    cashier.token = (await command<OperatorSession>(cashier, 'unlock', { businessId: cashier.business, pin: '024680' })).operatorToken;
    expect((await context(cashier)).id).toBe(owner.business);
    await expect(command(owner, 'revoke_device', { ...args(owner), deviceId: device.id })).rejects.toThrow('BUSINESS_ACCESS_DENIED');
    const replacement = (await command<TeamContext>(owner, 'team', args(owner))).devices.find(item => item.kind === 'employee_browser')!;
    expect(replacement.id).not.toBe(device.id); expect(replacement.active).toBe(true);
  });

  it('self-revocation invalidates the current operator and browser helpers remain private', async () => {
    const owner = await actor();
    const current = (await command<TeamContext>(owner, 'team', args(owner))).devices.find(device => device.current)!;
    await command(owner, 'revoke_device', { ...args(owner), deviceId: current.id });
    await expect(context(owner)).rejects.toThrow('SESSION_INVALID');
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'app_private.owner_browser_devices','SELECT') allowed", [role])).rows[0].allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.account_manage(uuid,uuid,text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
    }
  });
});

async function identity(): Promise<Actor> {
  const actor = { user: randomUUID(), auth: randomUUID(), business: randomUUID(), employee: randomUUID(), token: '', key: randomUUID().replaceAll('-', '').repeat(2) };
  await db.query('insert into auth.users(id) values($1)', [actor.user]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.auth, actor.user]); return actor;
}
async function actor(role = 'owner', business?: string, permissions: string[] = []) {
  const value = await identity(); if (business) value.business = business;
  if (!business) await db.query("insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Comercio sintético','cafe','America/Mexico_City',$2::jsonb)", [value.business, JSON.stringify(profile)]);
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [value.business, value.user, role]);
  await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Persona sintética',$4,$5)", [value.employee, value.business, value.user, role, permissions]);
  await db.query("insert into app_private.operator_credentials(business_id,user_id,pin_hash) values($1,$2,extensions.crypt('024680',extensions.gen_salt('bf',12)))", [value.business, value.user]);
  await renewed(value); return value;
}
async function renewed(value: Actor) { value.token = (await command<OperatorSession>(value, 'unlock', { businessId: value.business, pin: '024680', deviceName: 'Navegador sintético' })).operatorToken; }
function args(value: Actor) { return { businessId: value.business, operatorToken: value.token }; }
async function command<T = unknown>(value: Actor, action: string, payload: object): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>('select public.account_secure($1,$2,$3,$4::jsonb,$5,$6) result', [value.user, value.auth, action, JSON.stringify({ action, ...payload }), value.key, randomUUID()])).rows[0].result;
  if (result.error) throw new Error(result.error.code); return result.data;
}
async function context(value: Actor) { return (await command<{ business: BusinessContext }>(value, 'context', args(value))).business; }
function update(value: Actor, patch: Partial<BusinessProfile>) { return command<BusinessContext>(value, 'update_business', { ...args(value), name: 'Comercio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', profile: { ...profile, ...patch } }); }
