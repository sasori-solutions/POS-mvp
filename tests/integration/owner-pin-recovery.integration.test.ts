import { signedRequest } from './device-proof-fixture'
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

describe.skipIf(!config)('email recovery and PIN security against real local Auth/Edge/Postgres/Mailpit', () => {
  beforeAll(async () => {
    admin = createClient(config!.url, config!.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    [owner, employee, otherOwner] = await Promise.all([newIdentity(), newIdentity(), newIdentity()]);
    expect((await account(owner, { action: 'status' })).status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    for (const id of userIds) { const { error } = await admin.auth.admin.deleteUser(id); if (error) throw error; }
    if (businessIds.length) sql(`delete from app_private.businesses where id in (${businessIds.map(uuid).join(',')});`);
  }, 30_000);

  it('sends a scoped email to the confirmed identity and never exposes the link in the API response', async () => {
    const business = await newBusiness();
    const result = await requestMail(business);
    expect(result.response.body.data).toEqual({ sent: true, retryAfterSeconds: 60 });
    expect(result.mail.To.map((to: { Address: string }) => to.Address)).toEqual([owner.email]);
    expect(result.mail.Text).toContain('El enlace vence en 15 minutos');
    expect(result.mail.Text).not.toContain('Google');
    expect(sql(`select token_hash=extensions.digest('${result.token}','sha256') and delivered_at is not null from app_private.pin_email_recoveries where business_id=${uuid(business.business.id)};`).trim()).toBe('t');
    expect((await account(null, { action: 'pin_email_details', recoveryToken: result.token })).status).toBe(200);
    expect((await account(null, { action: 'request_pin_email', businessId: business.business.id })).body.error?.code).toBe('AUTH_REQUIRED');
    expect((await account(otherOwner, { action: 'request_pin_email', businessId: business.business.id })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    for (const action of ['reset_pin', 'create_recovery_code']) expect((await account(owner, { action, ...args(business), pin, recoveryCode: 'a'.repeat(64), operationId: randomUUID() })).body.error?.code).toBe('VALIDATION_ERROR');
    expect(() => sql(`select public.account_manage(${uuid(owner.userId)},${uuid(owner.sessionId)},'reset_pin','{}');`)).toThrow();
  });

  it('enforces per-account send cooldown and only the latest delivered link works', async () => {
    const business = await newBusiness(); const first = await requestMail(business);
    const rate = await account(owner, { action: 'request_pin_email', businessId: business.business.id });
    expect(rate.body.error?.code).toBe('RECOVERY_LOCKED'); expect(rate.body.error?.retryAfterSeconds).toBeGreaterThan(0);
    const next = await requestMail(business);
    expect((await account(null, { action: 'pin_email_details', recoveryToken: first.token })).body.error?.code).toBe('RECOVERY_INVALID');
    expect((await account(null, { action: 'pin_email_details', recoveryToken: next.token })).status).toBe(200);
  });

  it('recovers without Google, clears PIN lockout, revokes personal/register operators and makes the link one-use', async () => {
    const business = await newBusiness(); const device = await pairedOwner(business); const mail = await requestMail(business);
    sql(`update app_private.operator_credentials set failed_attempts=5,locked_until=now()+interval '15 minutes' where business_id=${uuid(business.business.id)};`);
    const payload = { action: 'confirm_pin_email', recoveryToken: mail.token, pin: '135790', operationId: randomUUID() };
    const result = await account(null, payload); expect(result.status).toBe(200); expect(result.body.data).toEqual({ updated: true });
    expect((await account(owner, { action: 'context', ...args(business) })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(null, { action: 'device_context', ...device })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(null, { action: 'pin_email_details', recoveryToken: mail.token })).body.error?.code).toBe('RECOVERY_INVALID');
    expect((await account(null, { ...payload, operationId: randomUUID() })).body.error?.code).toBe('RECOVERY_INVALID');
    expect((await account(null, payload)).status).toBe(200);
    expect((await account(owner, { action: 'unlock', businessId: business.business.id, pin })).body.error?.code).toBe('PIN_INVALID');
    const current = await account<Session>(owner, { action: 'unlock', businessId: business.business.id, pin: '135790' }); expect(current.status).toBe(200);
    const changed = await account(owner, { action: 'change_pin', ...args(current.body.data!), currentPin: '135790', pin: '246802', operationId: randomUUID() }); expect(changed.status).toBe(200);
    expect((await account(null, payload)).body.error?.code).toBe('RECOVERY_INVALID');
  });

  it('does not consume the link when read, rejects expiry and binds it to the unchanged account email and PIN', async () => {
    const business = await newBusiness(); const mail = await requestMail(business);
    for (let i=0;i<2;i++) expect((await account(null, { action: 'pin_email_details', recoveryToken: mail.token })).status).toBe(200);
    sql(`update app_private.pin_email_recoveries set expires_at=now()-interval '1 second' where business_id=${uuid(business.business.id)};`);
    expect((await account(null, { action: 'confirm_pin_email', recoveryToken: mail.token, pin: '135790', operationId: randomUUID() })).body.error?.code).toBe('RECOVERY_INVALID');
    const second = await requestMail(business);
    const changed = await account(owner, { action: 'change_pin', ...args(business), currentPin: pin, pin: '246802', operationId: randomUUID() }); expect(changed.status).toBe(200);
    expect((await account(null, { action: 'pin_email_details', recoveryToken: second.token })).body.error?.code).toBe('RECOVERY_INVALID');
    const third = await requestMail(business);
    sql(`update app_private.pin_email_recoveries set email='changed@example.test' where business_id=${uuid(business.business.id)};`);
    expect((await account(null, { action: 'pin_email_details', recoveryToken: third.token })).body.error?.code).toBe('RECOVERY_INVALID');
  });

  it('allows a linked employee to request their own recovery from a paired register, without disclosing their email', async () => {
    const business = await newBusiness(); const member = await invitedEmployee(business); const device = await pairedOwner(business);
    const mail = await requestMail(business, employee, { action: 'device_request_pin_email', deviceToken: device.deviceToken, employeeId: member.business.employee.id });
    expect(mail.mail.To.map((to: { Address: string }) => to.Address)).toEqual([employee.email]);
    expect((await account(null, { action: 'confirm_pin_email', recoveryToken: mail.token, pin: '135790', operationId: randomUUID() })).status).toBe(200);
    expect((await account(employee, { action: 'unlock', businessId: business.business.id, pin: '135790' })).status).toBe(200);
    expect((await account(owner, { action: 'unlock', businessId: business.business.id, pin })).status).toBe(200);
    expect((await account(null, { action: 'device_request_pin_email', deviceToken: '0'.repeat(64), employeeId: member.business.employee.id })).body.error?.code).toBe('DEVICE_REVOKED');
  });

  it('cannot revive a recovery after employee removal and restoration, or use one after a ban', async () => {
    const business = await newBusiness(); const member = await invitedEmployee(business); const mail = await requestMail(business, employee);
    expect((await account(owner, { action: 'delete_employee', ...args(business), employeeId: member.business.employee.id, operationId: randomUUID() })).status).toBe(200);
    expect((await account(owner, { action: 'restore_employee', ...args(business), employeeId: member.business.employee.id, operationId: randomUUID() })).status).toBe(200);
    expect((await account(null, { action: 'pin_email_details', recoveryToken: mail.token })).body.error?.code).toBe('RECOVERY_INVALID');
    const fresh = await requestMail(business, employee);
    sql(`update auth.users set banned_until=now()+interval '1 hour' where id=${uuid(employee.userId)};`);
    expect((await account(null, { action: 'pin_email_details', recoveryToken: fresh.token })).body.error?.code).toBe('RECOVERY_INVALID');
    sql(`update auth.users set banned_until=null where id=${uuid(employee.userId)};`);
  });

  it('serializes competing confirmations and old-PIN unlocks without leaving an old operator active', async () => {
    const business = await newBusiness(); const mail = await requestMail(business);
    const results = await Promise.all(['135790','246802'].map(nextPin => account(null, { action: 'confirm_pin_email', recoveryToken: mail.token, pin: nextPin, operationId: randomUUID() })));
    expect(results.filter(r => r.status===200)).toHaveLength(1); expect(results.filter(r => r.body.error?.code==='RECOVERY_INVALID')).toHaveLength(1);
    expect((await account(owner, { action: 'context', ...args(business) })).body.error?.code).toBe('SESSION_INVALID');
    expect(sql(`select count(*) from app_private.pin_security_audit_events where business_id=${uuid(business.business.id)} and event='pin_recovered';`).trim()).toBe('1');
  });

  it('keeps recovery storage and RPCs inaccessible to browser roles', async () => {
    expect(sql("select relrowsecurity from pg_class where oid='app_private.pin_email_recoveries'::regclass;").trim()).toBe('t');
    expect(sql("select has_table_privilege('anon','app_private.pin_email_recoveries','select') or has_table_privilege('authenticated','app_private.pin_email_recoveries','select');").trim()).toBe('f');
    for (const fn of ['account_request_pin_email(uuid,uuid,uuid)','account_device_request_pin_email(text,uuid)','account_confirm_pin_email(text,jsonb)','account_pin_email_delivery(uuid,boolean)']) expect(sql(`select has_function_privilege('anon','public.${fn}','execute') or has_function_privilege('authenticated','public.${fn}','execute');`).trim()).toBe('f');
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
async function invite(session: Session) { const result = await account<{ invitationCode: string }>(owner, { action: 'create_invitation', ...args(session), name: 'Persona sintética', role: 'cashier', operationId: randomUUID() }); expect(result.status).toBe(200); return result.body.data!.invitationCode; }
async function invitedEmployee(session: Session) { const response = await account<Session>(employee, { action: 'accept_invitation', invitationCode: await invite(session), pin: '024681', operationId: randomUUID() }); expect(response.status).toBe(200); return response.body.data!; }
async function pairedOwner(session: Session) {
  const pairing = await account<{ pairingCode: string }>(owner, { action: 'create_pairing_code', ...args(session), operationId: randomUUID() }); expect(pairing.status).toBe(200);
  const paired = await account<{ deviceToken: string }>(null, { action: 'device_pair', pairingCode: pairing.body.data!.pairingCode, deviceName: 'Caja sintética de dueño', operationId: randomUUID() }); expect(paired.status).toBe(200);
  const unlocked = await account<Session>(null, { action: 'device_unlock', deviceToken: paired.body.data!.deviceToken, employeeId: session.business.employee.id, pin }); expect(unlocked.status).toBe(200);
  return { deviceToken: paired.body.data!.deviceToken, operatorToken: unlocked.body.data!.operatorToken };
}
async function account<T = unknown>(identity: Identity | null, request: Record<string, unknown>): Promise<Reply<T>> {
  const response = await fetch(`${config!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: config!.anonKey, ...(identity ? { authorization: `Bearer ${identity.token}` } : {}) }, body: JSON.stringify(await signedRequest(identity?.userId, request)) });
  return { status: response.status, body: await response.json() };
}
function sql(statement: string) { return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Expected synthetic UUID.'); return `'${value}'::uuid`; }

async function requestMail(business: Session, identity = owner, request?: Record<string, unknown>) {
  // Each test isolates the rate window for this synthetic account; the cooldown test checks the real rejection.
  sql(`update app_private.pin_email_recoveries set created_at=now()-interval '2 hours' where user_id=${uuid(identity.userId)};`);
  const response = await account(request ? null : identity, request ?? { action: 'request_pin_email', businessId: business.business.id });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const mailpitUrl = process.env.TEST_MAILPIT_URL ?? 'http://127.0.0.1:54324';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(mailpitUrl).hostname)) throw new Error('Local inbox only');
  const inbox = await (await fetch(`${mailpitUrl}/api/v1/messages`)).json();
  const found = inbox.messages.find((message: { To: { Address: string }[] }) => message.To.some(to => to.Address===identity.email));
  expect(found).toBeTruthy();
  const mail = await (await fetch(`${mailpitUrl}/api/v1/message/${found.ID}`)).json();
  const token = mail.Text.match(/#recovery=([a-f0-9]{64})/)?.[1]; expect(token).toBeTruthy();
  return { response, mail, token: token as string };
}
