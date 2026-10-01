import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Config = { url: string; anonKey: string; serviceRoleKey: string; dbContainer: string };
type Identity = { userId: string; token: string; sessionId: string; email: string; password: string };
type Session = { business: { id: string; role: string; employee: { id: string } }; operatorToken: string; expiresAt: string };
type Reply<T = unknown> = { status: number; body: { data?: T; error?: { code: string; retryAfterSeconds?: number } } };
const config = localConfig();
const userIds: string[] = [];
const businessIds: string[] = [];
const pin = '583927';
let admin: SupabaseClient;
let owner: Identity;
let employee: Identity;
let otherOwner: Identity;

describe.skipIf(!config)('owner PIN security against real local Auth/Edge/Postgres', () => {
  beforeAll(async () => {
    admin = createClient(config!.url, config!.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    [owner, employee, otherOwner] = await Promise.all([newIdentity(), newIdentity(), newIdentity()]);
    expect((await account(owner, { action: 'status' })).status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    for (const id of userIds) { const { error } = await admin.auth.admin.deleteUser(id); if (error) throw error; }
    if (businessIds.length) sql(`delete from app_private.businesses where id in (${businessIds.map(uuid).join(',')});`);
  }, 30_000);

  it('offers recovery only to the owner and never enrolls legacy businesses using Google alone', async () => {
    const business = await newBusiness();
    const status = await account<{ businesses: { id: string; canRecoverPin: boolean; recoveryReady: boolean }[] }>(owner, { action: 'status' });
    expect(status.body.data!.businesses.find(b => b.id === business.business.id)).toMatchObject({ canRecoverPin: true, recoveryReady: false });
    const reset = await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode: 'a'.repeat(64), operationId: randomUUID() });
    expect(reset.body.error?.code).toBe('RECOVERY_UNAVAILABLE');
    expect((await account(owner, { action: 'context', ...args(business) })).status).toBe(200);
  });

  it('requires owner operator plus current PIN to enroll, scopes the code to its owner/business and redacts employee recovery', async () => {
    const business = await newBusiness(); const other = await newBusiness(otherOwner);
    const request = { action: 'create_recovery_code', ...args(business), currentPin: pin, operationId: randomUUID() };
    expect((await account(owner, { ...request, operatorToken: '0'.repeat(64) })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner, { ...request, currentPin: '111111' })).body.error?.code).toBe('PIN_INVALID');
    expect((await account(otherOwner, request)).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    const enrolled = await account<{ recoveryCode: string }>(owner, request); expect(enrolled.status).toBe(200);
    const recoveryCode = enrolled.body.data!.recoveryCode; expect(recoveryCode).toMatch(/^[a-f0-9]{64}$/);
    expect(sql(`select octet_length(code_hash)=32 and code_hash=extensions.digest('${recoveryCode}','sha256') from app_private.owner_pin_recovery_credentials where business_id=${uuid(business.business.id)};`).trim()).toBe('t');
    expect((await account<{ businesses: unknown[] }>(owner, { action: 'status' })).body.data!.businesses).toContainEqual(expect.objectContaining({ id: business.business.id, canRecoverPin: true, recoveryReady: true }));
    const member = await invitedEmployee(business);
    const memberStatus = await account<{ businesses: { id: string; canRecoverPin: boolean; recoveryReady: boolean }[] }>(employee, { action: 'status' });
    expect(memberStatus.body.data!.businesses.find(b => b.id === business.business.id)).toMatchObject({ canRecoverPin: false, recoveryReady: false });
    expect((await account(employee, { action: 'create_recovery_code', ...args(member), currentPin: '024681', operationId: randomUUID() })).body.error?.code).toBe('PERMISSION_DENIED');
    expect((await account(employee, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode, operationId: randomUUID() })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    const otherCode = await enroll(other, otherOwner);
    expect((await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode: otherCode, operationId: randomUUID() })).body.error?.code).toBe('RECOVERY_INVALID');
    expect((await account(otherOwner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode, operationId: randomUUID() })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
  });

  it('cannot bypass the shared PIN lockout while enrolling an independent recovery factor', async () => {
    const business = await newBusiness();
    const wrong = await Promise.all(Array.from({ length: 5 }, () => account(owner, { action: 'create_recovery_code', ...args(business), currentPin: '111111', operationId: randomUUID() })));
    expect(wrong.filter(r => r.body.error?.code === 'PIN_INVALID')).toHaveLength(4);
    expect(wrong.filter(r => r.body.error?.code === 'PIN_LOCKED')).toHaveLength(1);
    expect((await account(owner, { action: 'create_recovery_code', ...args(business), currentPin: pin, operationId: randomUUID() })).body.error?.code).toBe('PIN_LOCKED');
    expect(sql(`select count(*) from app_private.owner_pin_recovery_credentials where business_id=${uuid(business.business.id)};`).trim()).toBe('0');
  });

  it('requires original fresh owner authentication even with the independent code', async () => {
    const business = await newBusiness(); const recoveryCode = await enroll(business);
    const request = { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode, operationId: randomUUID() };
    sql(`update auth.sessions set created_at=now()-interval '6 minutes' where id=${uuid(owner.sessionId)};`);
    expect((await account(owner, request)).body.error?.code).toBe('REAUTH_REQUIRED');
    expect((await account(owner, { action: 'context', ...args(business) })).status).toBe(200);
    sql(`update auth.sessions set created_at=now() where id=${uuid(owner.sessionId)};`);
    expect((await account(owner, request)).status).toBe(200);
    sql(`delete from auth.sessions where id=${uuid(otherOwner.sessionId)};`);
    expect((await account(otherOwner, { action: 'status' })).body.error?.code).toBe('AUTH_REQUIRED');
    otherOwner = await newIdentity();
  });

  it('consumes recovery atomically, replaces its code, clears PIN cooldown and closes every personal/shared operator for that owner', async () => {
    const business = await newBusiness(); const recoveryCode = await enroll(business);
    const anotherSession = await login(owner); const second = await account<Session>(anotherSession, { action: 'unlock', businessId: business.business.id, pin }); expect(second.status).toBe(200);
    const device = await pairedOwner(business);
    sql(`update app_private.operator_credentials set failed_attempts=5,locked_until=now()+interval '15 minutes' where business_id=${uuid(business.business.id)} and user_id=${uuid(owner.userId)};`);
    const result = await account<Session & { recoveryCode: string }>(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode, operationId: randomUUID() });
    expect(result.status).toBe(200); const recovered = result.body.data!; expect(recovered.recoveryCode).toMatch(/^[a-f0-9]{64}$/); expect(recovered.recoveryCode).not.toBe(recoveryCode);
    for (const [identity, token] of [[owner, business.operatorToken], [anotherSession, second.body.data!.operatorToken]] as const) expect((await account(identity, { action: 'context', businessId: business.business.id, operatorToken: token })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(null, { action: 'device_context', deviceToken: device.deviceToken, operatorToken: device.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner, { action: 'context', ...args(recovered) })).status).toBe(200);
    expect(sql(`select failed_attempts=0 and locked_until is null from app_private.operator_credentials where business_id=${uuid(business.business.id)} and user_id=${uuid(owner.userId)};`).trim()).toBe('t');
    expect((await account(owner, { action: 'unlock', businessId: business.business.id, pin })).body.error?.code).toBe('PIN_INVALID');
    expect((await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '246802', recoveryCode, operationId: randomUUID() })).body.error?.code).toBe('RECOVERY_INVALID');
    expect((await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '246802', recoveryCode: recovered.recoveryCode, operationId: randomUUID() })).status).toBe(200);
  });

  it('commits concurrent failed recovery attempts and prevents valid recovery during its bounded cooldown', async () => {
    const business = await newBusiness(); const recoveryCode = await enroll(business);
    const wrong = await Promise.all(Array.from({ length: 5 }, () => account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode: '0'.repeat(64), operationId: randomUUID() })));
    expect(wrong.filter(r => r.body.error?.code === 'RECOVERY_INVALID')).toHaveLength(4); expect(wrong.filter(r => r.body.error?.code === 'RECOVERY_LOCKED')).toHaveLength(1);
    const blocked = await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode, operationId: randomUUID() });
    expect(blocked.body.error?.code).toBe('RECOVERY_LOCKED'); expect(blocked.body.error?.retryAfterSeconds).toBeGreaterThan(0); expect(blocked.body.error?.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(sql(`select failed_attempts=5 and locked_until>now() from app_private.owner_pin_recovery_credentials where business_id=${uuid(business.business.id)};`).trim()).toBe('t');
    sql(`update app_private.owner_pin_recovery_credentials set locked_until=now()-interval '1 second' where business_id=${uuid(business.business.id)};`);
    expect((await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode, operationId: randomUUID() })).status).toBe(200);
  });

  it('recovers lost responses without storing raw codes and rejects stale generation/credential replays', async () => {
    const business = await newBusiness();
    const enrollment = { action: 'create_recovery_code', ...args(business), currentPin: pin, operationId: randomUUID() };
    const first = await account<{ recoveryCode: string }>(owner, enrollment); const replay = await account<{ recoveryCode: string }>(owner, enrollment);
    expect(first.status).toBe(200); expect(replay.status).toBe(200); expect(first.body.data!.recoveryCode).not.toBe(replay.body.data!.recoveryCode);
    const recovery = { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode: replay.body.data!.recoveryCode, operationId: randomUUID() };
    const reset = await account<Session & { recoveryCode: string }>(owner, recovery); const retry = await account<Session & { recoveryCode: string }>(owner, recovery);
    expect(reset.status).toBe(200); expect(retry.status).toBe(200); expect(retry.body.data!.recoveryCode).not.toBe(reset.body.data!.recoveryCode);
    expect((await account(owner, { action: 'context', ...args(reset.body.data!) })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '246802', recoveryCode: reset.body.data!.recoveryCode, operationId: randomUUID() })).body.error?.code).toBe('RECOVERY_INVALID');
    const changed = await account<Session>(owner, { action: 'change_pin', ...args(retry.body.data!), currentPin: '135790', pin: '246802', operationId: randomUUID() }); expect(changed.status).toBe(200);
    expect((await account(owner, recovery)).body.error?.code).toBe('OPERATION_CONFLICT');
    expect((await account(owner, { ...enrollment, ...args(changed.body.data!), currentPin: '246802' })).body.error?.code).toBe('OPERATION_CONFLICT');
    expect((await account(owner, { action: 'context', ...args(changed.body.data!) })).status).toBe(200);
  });

  it('allows only one competing recovery operation to consume a code', async () => {
    const business = await newBusiness(); const recoveryCode = await enroll(business);
    const results = await Promise.all(['135790', '246802'].map(nextPin => account<Session & { recoveryCode: string }>(owner, { action: 'reset_pin', businessId: business.business.id, pin: nextPin, recoveryCode, operationId: randomUUID() })));
    expect(results.filter(r => r.status === 200)).toHaveLength(1); expect(results.filter(r => r.body.error?.code === 'RECOVERY_INVALID')).toHaveLength(1);
    const success = results.find(r => r.status === 200)!.body.data!;
    expect((await account(owner, { action: 'context', ...args(success) })).status).toBe(200);
    expect(sql(`select count(*) from app_private.pin_security_operations where business_id=${uuid(business.business.id)} and action='reset_pin';`).trim()).toBe('1');
  });

  it('serializes recovery against personal/device unlock and original creation replay so no old-PIN token survives', async () => {
    const creation = createRequest(); const first = await account<Session>(owner, creation); expect(first.status).toBe(200);
    const business = first.body.data!; businessIds.push(business.business.id); const recoveryCode = await enroll(business); const device = await pairedOwner(business);
    const [recovered, personal, shared, replay] = await Promise.all([
      account<Session & { recoveryCode: string }>(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790', recoveryCode, operationId: randomUUID() }),
      account<Session>(owner, { action: 'unlock', businessId: business.business.id, pin }),
      account<Session>(null, { action: 'device_unlock', deviceToken: device.deviceToken, employeeId: business.business.employee.id, pin }),
      account<Session>(owner, creation),
    ]);
    expect(recovered.status).toBe(200);
    for (const reply of [personal, replay]) {
      expect([200, 401, 409]).toContain(reply.status);
      if (reply.status === 200) expect((await account(owner, { action: 'context', ...args(reply.body.data!) })).body.error?.code).toBe('SESSION_INVALID');
    }
    expect([200, 401]).toContain(shared.status);
    if (shared.status === 200) expect((await account(null, { action: 'device_context', deviceToken: device.deviceToken, operatorToken: shared.body.data!.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner, { action: 'context', ...args(recovered.body.data!) })).status).toBe(200);
    expect((await account(owner, { action: 'unlock', businessId: business.business.id, pin })).body.error?.code).toBe('PIN_INVALID');
  });

  it('changes only the signed-in person’s PIN with its current PIN, preserves recovery and invalidates stale change/creation retries', async () => {
    const creation = createRequest(); const first = await account<Session>(owner, creation); expect(first.status).toBe(200); const business = first.body.data!; businessIds.push(business.business.id);
    const recoveryCode = await enroll(business); const device = await pairedOwner(business);
    const request = { action: 'change_pin', ...args(business), currentPin: pin, pin: '135790', operationId: randomUUID() };
    expect((await account(owner, { ...request, currentPin: '111111' })).body.error?.code).toBe('PIN_INVALID');
    expect((await account(owner, { ...request, operatorToken: '0'.repeat(64) })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(otherOwner, request)).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    const changed = await account<Session>(owner, request); expect(changed.status).toBe(200);
    expect((await account(null, { action: 'device_context', deviceToken: device.deviceToken, operatorToken: device.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    const replay = await account<Session>(owner, request); expect(replay.status).toBe(200); expect(replay.body.data!.operatorToken).not.toBe(changed.body.data!.operatorToken);
    expect((await account(owner, creation)).body.error?.code).toBe('OPERATION_CONFLICT');
    const later = await account<Session>(owner, { action: 'change_pin', ...args(replay.body.data!), currentPin: '135790', pin: '246802', operationId: randomUUID() }); expect(later.status).toBe(200);
    expect((await account(owner, request)).body.error?.code).toBe('OPERATION_CONFLICT');
    expect((await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '357913', recoveryCode, operationId: randomUUID() })).status).toBe(200);
  });

  it('uses the existing bounded PIN counter for normal changes and exact lost-response change retries', async () => {
    const business = await newBusiness();
    const wrong = await Promise.all(Array.from({ length: 5 }, () => account(owner, { action: 'change_pin', ...args(business), currentPin: '111111', pin: '135790', operationId: randomUUID() })));
    expect(wrong.filter(r => r.body.error?.code === 'PIN_INVALID')).toHaveLength(4); expect(wrong.filter(r => r.body.error?.code === 'PIN_LOCKED')).toHaveLength(1);
    const request = { action: 'change_pin', ...args(business), currentPin: pin, pin: '135790', operationId: randomUUID() };
    expect((await account(owner, request)).body.error?.code).toBe('PIN_LOCKED');
    sql(`update app_private.operator_credentials set locked_until=now()-interval '1 second' where business_id=${uuid(business.business.id)} and user_id=${uuid(owner.userId)};`);
    const changed = await account<Session>(owner, request); expect(changed.status).toBe(200);
    const badRetries = await Promise.all(Array.from({ length: 5 }, () => account(owner, { ...request, currentPin: '111111' })));
    expect(badRetries.filter(r => r.body.error?.code === 'OPERATION_CONFLICT')).toHaveLength(4); expect(badRetries.filter(r => r.body.error?.code === 'PIN_LOCKED')).toHaveLength(1);
    expect((await account(owner, request)).body.error?.code).toBe('PIN_LOCKED');
    expect((await account(owner, { action: 'context', ...args(changed.body.data!) })).status).toBe(200);
    expect(sql(`select failed_attempts=5 from app_private.operator_credentials where business_id=${uuid(business.business.id)} and user_id=${uuid(owner.userId)};`).trim()).toBe('t');
  });

  it('lets Google employees change only their own PIN and keeps accepted invitation retries bound to the current credential', async () => {
    const business = await newBusiness(); const invitation = await invite(business);
    const acceptance = { action: 'accept_invitation', invitationCode: invitation, pin: '024681', operationId: randomUUID() };
    const joined = await account<Session>(employee, acceptance); expect(joined.status).toBe(200);
    const changed = await account<Session>(employee, { action: 'change_pin', ...args(joined.body.data!), currentPin: '024681', pin: '135790', operationId: randomUUID() }); expect(changed.status).toBe(200);
    expect(changed.body.data!.business.role).toBe('cashier');
    expect((await account(employee, acceptance)).body.error?.code).toBe('OPERATION_CONFLICT');
    expect((await account(employee, { action: 'change_pin', businessId: business.business.id, operatorToken: business.operatorToken, currentPin: pin, pin: '246802', operationId: randomUUID() })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner, { action: 'unlock', businessId: business.business.id, pin })).status).toBe(200);
  });

  it('keeps new security tables and private wrappers inaccessible to browser roles and exposes no raw code in storage/audit', async () => {
    for (const table of ['owner_pin_recovery_credentials', 'pin_security_operations', 'pin_security_audit_events']) {
      expect(sql(`select relrowsecurity from pg_class where oid='app_private.${table}'::regclass;`).trim()).toBe('t');
      const direct = await fetch(`${config!.url}/rest/v1/${table}?select=*`, { headers: { apikey: config!.anonKey, authorization: `Bearer ${owner.token}`, 'accept-profile': 'app_private' } }); expect(direct.status).toBeGreaterThanOrEqual(400); expect(direct.status).toBeLessThan(500);
      expect(sql(`select has_table_privilege('anon','app_private.${table}','select') or has_table_privilege('authenticated','app_private.${table}','select');`).trim()).toBe('f');
    }
    expect(sql("select count(*) from information_schema.columns where table_schema='app_private' and table_name in ('owner_pin_recovery_credentials','pin_security_operations','pin_security_audit_events') and column_name in ('pin','recovery_code','code','operator_token');").trim()).toBe('0');
    expect(sql("select has_function_privilege('anon','public.account_manage(uuid,uuid,text,jsonb)','execute') or has_function_privilege('authenticated','app_private.recover_owner_pin(uuid,uuid,jsonb)','execute');").trim()).toBe('f');
  });
});

function localConfig(): Config | null {
  let status: Record<string, string>;
  if (process.env.TEST_SUPABASE_URL) status = { API_URL: process.env.TEST_SUPABASE_URL, ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? '', SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '' };
  else { try { status = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch { return null; } }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(status.API_URL).hostname)) throw new Error('PIN tests refuse non-loopback Supabase.');
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Missing local test credentials.');
  const projectId = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1];
  if (!projectId) throw new Error('Missing local project ID.');
  return { url: status.API_URL, anonKey: status.ANON_KEY, serviceRoleKey: status.SERVICE_ROLE_KEY, dbContainer: process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${projectId}` };
}
async function newIdentity(): Promise<Identity> {
  const email = `pin-security-${randomUUID()}@example.test`; const password = `local-only-${randomUUID()}-Aa9!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw created.error;
  userIds.push(created.data.user.id);
  return login({ userId: created.data.user.id, email, password });
}
async function login(identity: Pick<Identity, 'userId' | 'email' | 'password'>): Promise<Identity> {
  const client = createClient(config!.url, config!.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email: identity.email, password: identity.password }); if (signedIn.error) throw signedIn.error;
  const token = signedIn.data.session!.access_token; const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  return { ...identity, token, sessionId: claims.session_id };
}
function createRequest() { return { action: 'create_business', operationId: randomUUID(), name: `Synthetic PIN business ${randomUUID().slice(0, 8)}`, businessType: 'cafe', timezone: 'America/Mexico_City', pin }; }
async function newBusiness(identity = owner): Promise<Session> {
  const response = await account<Session>(identity, createRequest()); expect(response.status).toBe(200); const result = response.body.data!; businessIds.push(result.business.id); return result;
}
function args(session: Session) { return { businessId: session.business.id, operatorToken: session.operatorToken }; }
async function enroll(session: Session, identity = owner) { const response = await account<{ recoveryCode: string }>(identity, { action: 'create_recovery_code', ...args(session), currentPin: pin, operationId: randomUUID() }); expect(response.status).toBe(200); return response.body.data!.recoveryCode; }
async function invite(session: Session) { const result = await account<{ invitationCode: string }>(owner, { action: 'create_invitation', ...args(session), name: 'Persona sintética', role: 'cashier', operationId: randomUUID() }); expect(result.status).toBe(200); return result.body.data!.invitationCode; }
async function invitedEmployee(session: Session) { const response = await account<Session>(employee, { action: 'accept_invitation', invitationCode: await invite(session), pin: '024681', operationId: randomUUID() }); expect(response.status).toBe(200); return response.body.data!; }
async function pairedOwner(session: Session) {
  const pairing = await account<{ pairingCode: string }>(owner, { action: 'create_pairing_code', ...args(session), operationId: randomUUID() }); expect(pairing.status).toBe(200);
  const paired = await account<{ deviceToken: string }>(null, { action: 'device_pair', pairingCode: pairing.body.data!.pairingCode, deviceName: 'Caja sintética de dueño', operationId: randomUUID() }); expect(paired.status).toBe(200);
  const unlocked = await account<Session>(null, { action: 'device_unlock', deviceToken: paired.body.data!.deviceToken, employeeId: session.business.employee.id, pin }); expect(unlocked.status).toBe(200);
  return { deviceToken: paired.body.data!.deviceToken, operatorToken: unlocked.body.data!.operatorToken };
}
async function account<T = unknown>(identity: Identity | null, request: Record<string, unknown>): Promise<Reply<T>> {
  const response = await fetch(`${config!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey, ...(identity ? { authorization: `Bearer ${identity.token}` } : {}) }, body: JSON.stringify(request) });
  return { status: response.status, body: await response.json() };
}
function sql(statement: string) { return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Expected synthetic UUID.'); return `'${value}'::uuid`; }
