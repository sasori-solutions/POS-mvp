import { signedRequest } from './device-proof-fixture'
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Identity = { userId: string; sessionId: string; token: string };
type Session = { business: { id: string }; operatorToken: string; expiresAt: string };
type Setup = { setupCode: string; setupId: string; expiresAt: string };
type Employee = { id: string; pinReady: boolean; googleLinked: boolean; pinSetup?: Setup; invitation?: { invitationCode: string } };
type Reply<T> = { data?: T; error?: { code: string } };
const local = localConfig();
const users: string[] = [];
const businesses: string[] = [];
let admin: SupabaseClient;
let owner: Identity;
let employee: Identity;
let other: Identity;

describe.skipIf(!local)('employees choose their PIN and owner authorizes one-use setup', () => {
  beforeAll(async () => {
    admin = createClient(local!.url, local!.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    [owner, employee, other] = await Promise.all([identity(), identity(), identity()]);
  }, 30_000);
  afterAll(async () => {
    for (const id of users) { const result = await admin.auth.admin.deleteUser(id); if (result.error) throw result.error; }
    if (businesses.length) sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`);
  }, 30_000);

  it('rejects an owner-assigned PIN in both creation and update, including the SQL trust boundary', async () => {
    const business = await newBusiness();
    const create = { ...args(business), name: 'Persona con PIN propio', role: 'cashier', pin: '024680', inviteWithGoogle: false, operationId: randomUUID() };
    expect((await manage(owner, 'create_employee', create)).error?.code).toBe('VALIDATION_ERROR');
    const person = await createPerson(business);
    expect((await manage(owner, 'update_employee', { ...args(business), employeeId: person.id, name: 'Persona con PIN propio', role: 'cashier', active: true, pin: '024680' })).error?.code).toBe('VALIDATION_ERROR');
    expect(sql(`select count(*) from app_private.shared_employee_credentials where employee_id=${uuid(person.id)};`).trim()).toBe('0');
  }, 30_000);

  it('keeps pending employees off the register and lets the explicit employee choose PIN with a hashed one-use authorization', async () => {
    const business = await newBusiness(); const person = await createPerson(business); const device = await pair(business);
    expect(person).toMatchObject({ pinReady: false, googleLinked: false, pinSetup: { setupCode: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const setup = person.pinSetup!;
    expect(new Date(setup.expiresAt).getTime() - Date.now()).toBeLessThan(16 * 60_000);
    expect(sql(`select encode(token_hash,'hex')<>${literal(setup.setupCode)} from app_private.employee_pin_setup_codes where id=${uuid(setup.setupId)};`).trim()).toBe('t');
    expect((await deviceCall<{ employees: Employee[] }>('device_status', { deviceToken: device.deviceToken })).data!.employees.map(e => e.id)).not.toContain(person.id);
    const details = await deviceCall<{ employee: Employee; business: { id: string } }>('device_pin_setup_details', { deviceToken: device.deviceToken, setupCode: setup.setupCode });
    expect(details.data).toMatchObject({ employee: { id: person.id, pinReady: false }, business: { id: business.business.id } });
    const operationId = randomUUID(); const payload = { deviceToken: device.deviceToken, setupCode: setup.setupCode, pin: '024680', operationId };
    const chosen = await deviceCall<Session>('device_set_employee_pin', payload); expect(chosen.data!.operatorToken).toBeTruthy();
    expect((await deviceCall<Session>('device_set_employee_pin', payload)).data!.operatorToken).toBeTruthy();
    expect((await deviceCall('device_set_employee_pin', { ...payload, operationId: randomUUID() })).error?.code).toBe('PIN_SETUP_INVALID');
    expect((await deviceCall('device_unlock', { deviceToken: device.deviceToken, employeeId: person.id, pin: '024680' })).data).toBeTruthy();
    expect((await deviceCall<{ employees: Employee[] }>('device_status', { deviceToken: device.deviceToken })).data!.employees.map(e => e.id)).toContain(person.id);
  }, 30_000);

  it('retains the exact existing PIN hash and failure history when linking Google and rejects a different PIN', async () => {
    const business = await newBusiness(); const person = await createPerson(business); const device = await pair(business);
    await chooseDevice(device.deviceToken, person.pinSetup!.setupCode, '024680');
    sql(`update app_private.shared_employee_credentials set failed_attempts=2 where employee_id=${uuid(person.id)};`);
    const originalHash = sql(`select pin_hash from app_private.shared_employee_credentials where employee_id=${uuid(person.id)};`).trim();
    const invitation = await invite(business, person.id);
    const details = await manage<{ employee: Employee }>(employee, 'invitation_details', { invitationCode: invitation.invitationCode });
    expect(details.data!.employee).toMatchObject({ id: person.id, pinReady: true });
    const rejected = await manage(employee, 'accept_invitation', { invitationCode: invitation.invitationCode, pin: '086420', operationId: randomUUID() });
    expect(rejected.error?.code).toBe('PIN_INVALID');
    expect(sql(`select user_id is null from app_private.employees where id=${uuid(person.id)};`).trim()).toBe('t');
    expect(sql(`select failed_attempts from app_private.shared_employee_credentials where employee_id=${uuid(person.id)};`).trim()).toBe('3');
    const joined = await manage<Session>(employee, 'accept_invitation', { invitationCode: invitation.invitationCode, pin: '024680', operationId: randomUUID() });
    expect(joined.data!.operatorToken).toBeTruthy();
    expect(sql(`select pin_hash from app_private.operator_credentials where business_id=${uuid(business.business.id)} and user_id=${uuid(employee.userId)};`).trim()).toBe(originalHash);
    expect(sql(`select failed_attempts from app_private.operator_credentials where business_id=${uuid(business.business.id)} and user_id=${uuid(employee.userId)};`).trim()).toBe('3');
    expect(sql(`select count(*) from app_private.shared_employee_credentials where employee_id=${uuid(person.id)};`).trim()).toBe('0');
  }, 30_000);

  it('lets a PIN-less Google invitee create a PIN once and blocks other Google identities from resetting that person', async () => {
    const business = await newBusiness(); const person = await createPerson(business, true);
    const joined = await manage<Session>(employee, 'accept_invitation', { invitationCode: person.invitation!.invitationCode, pin: '086420', operationId: randomUUID() });
    expect(joined.data!.operatorToken).toBeTruthy();
    expect((await manage(employee, 'create_pin_setup', { ...args(joined.data!), employeeId: person.id, operationId: randomUUID() })).error?.code).toBe('PERMISSION_DENIED');
    const setup = (await manage<Setup>(owner, 'create_pin_setup', { ...args(business), employeeId: person.id, operationId: randomUUID() })).data!;
    expect((await manage(other, 'employee_pin_setup_details', { setupCode: setup.setupCode })).error?.code).toBe('PIN_SETUP_ACCOUNT_MISMATCH');
    expect((await manage(other, 'set_employee_pin', { setupCode: setup.setupCode, pin: '024680', operationId: randomUUID() })).error?.code).toBe('PIN_SETUP_ACCOUNT_MISMATCH');
    const reset = await manage<Session>(employee, 'set_employee_pin', { setupCode: setup.setupCode, pin: '024680', operationId: randomUUID() }); expect(reset.data!.operatorToken).toBeTruthy();
    expect((await edge(employee, { action: 'context', ...args(joined.data!) })).error?.code).toBe('SESSION_INVALID');
    expect((await edge(employee, { action: 'unlock', businessId: business.business.id, pin: '086420' })).error?.code).toBe('PIN_INVALID');
    expect((await edge(employee, { action: 'unlock', businessId: business.business.id, pin: '024680' })).data).toBeTruthy();
  }, 30_000);

  it('rotates renewal codes, preserves the current PIN until consumption, and prevents stale retries from replacing a later PIN', async () => {
    const business = await newBusiness(); const person = await createPerson(business); const device = await pair(business);
    const first = await chooseDevice(device.deviceToken, person.pinSetup!.setupCode, '024680');
    sql(`update app_private.shared_employee_credentials set failed_attempts=5,locked_until=now()+interval '15 minutes' where employee_id=${uuid(person.id)};`);
    const operationId = randomUUID();
    const setupArgs = { ...args(business), employeeId: person.id, operationId };
    const initial = (await manage<Setup>(owner, 'create_pin_setup', setupArgs)).data!;
    const retried = (await manage<Setup>(owner, 'create_pin_setup', setupArgs)).data!;
    expect(retried.setupId).toBe(initial.setupId); expect(retried.setupCode).not.toBe(initial.setupCode);
    expect((await deviceCall('device_pin_setup_details', { deviceToken: device.deviceToken, setupCode: initial.setupCode })).error?.code).toBe('PIN_SETUP_INVALID');
    expect((await deviceCall('device_context', { deviceToken: device.deviceToken, operatorToken: first.operatorToken })).data).toBeTruthy();
    expect(sql(`select failed_attempts=5 and locked_until>now() from app_private.shared_employee_credentials where employee_id=${uuid(person.id)};`).trim()).toBe('t');
    const chosen = { deviceToken: device.deviceToken, setupCode: retried.setupCode, pin: '086420', operationId: randomUUID() };
    expect((await deviceCall('device_set_employee_pin', chosen)).data).toBeTruthy();
    expect(sql(`select failed_attempts=0 and locked_until is null from app_private.shared_employee_credentials where employee_id=${uuid(person.id)};`).trim()).toBe('t');
    expect((await deviceCall('device_context', { deviceToken: device.deviceToken, operatorToken: first.operatorToken })).error?.code).toBe('SESSION_INVALID');
    const later = (await manage<Setup>(owner, 'create_pin_setup', { ...setupArgs, operationId: randomUUID() })).data!;
    await chooseDevice(device.deviceToken, later.setupCode, '135790');
    expect((await deviceCall('device_set_employee_pin', chosen)).error?.code).toBe('PIN_SETUP_INVALID');
    expect((await deviceCall('device_unlock', { deviceToken: device.deviceToken, employeeId: person.id, pin: '135790' })).data).toBeTruthy();
  }, 30_000);

  it('rejects foreign devices, owners, expired codes, and removed or deactivated people even after restoration', async () => {
    const business = await newBusiness(); const person = await createPerson(business); const device = await pair(business);
    const foreignBusiness = await newBusiness(); const foreign = await pair(foreignBusiness);
    expect((await deviceCall('device_set_employee_pin', { deviceToken: foreign.deviceToken, setupCode: person.pinSetup!.setupCode, pin: '024680', operationId: randomUUID() })).error?.code).toBe('PIN_SETUP_INVALID');
    const team = (await manage<{ employees: Employee[] }>(owner, 'team', args(business))).data!;
    const ownerId = team.employees.find(e => e.id !== person.id)!.id;
    expect((await manage(owner, 'create_pin_setup', { ...args(business), employeeId: ownerId, operationId: randomUUID() })).error?.code).toBe('PERMISSION_DENIED');
    sql(`update app_private.employee_pin_setup_codes set expires_at=now()-interval '1 second' where id=${uuid(person.pinSetup!.setupId)};`);
    expect((await deviceCall('device_pin_setup_details', { deviceToken: device.deviceToken, setupCode: person.pinSetup!.setupCode })).error?.code).toBe('PIN_SETUP_INVALID');
    const fresh = (await manage<Setup>(owner, 'create_pin_setup', { ...args(business), employeeId: person.id, operationId: randomUUID() })).data!;
    await manage(owner, 'delete_employee', { ...args(business), employeeId: person.id, operationId: randomUUID() });
    await manage(owner, 'restore_employee', { ...args(business), employeeId: person.id, operationId: randomUUID() });
    expect((await deviceCall('device_set_employee_pin', { deviceToken: device.deviceToken, setupCode: fresh.setupCode, pin: '024680', operationId: randomUUID() })).error?.code).toBe('PIN_SETUP_INVALID');
    const restored = (await manage<Setup>(owner, 'create_pin_setup', { ...args(business), employeeId: person.id, operationId: randomUUID() })).data!;
    await manage(owner, 'update_employee', { ...args(business), employeeId: person.id, name: 'Persona pausada', role: 'cashier', active: false, pin: null });
    await manage(owner, 'update_employee', { ...args(business), employeeId: person.id, name: 'Persona pausada', role: 'cashier', active: true, pin: null });
    expect((await deviceCall('device_set_employee_pin', { deviceToken: device.deviceToken, setupCode: restored.setupCode, pin: '024680', operationId: randomUUID() })).error?.code).toBe('PIN_SETUP_INVALID');
  }, 30_000);

  it('serializes two consumers of a setup authorization without creating two credentials', async () => {
    const business = await newBusiness(); const person = await createPerson(business); const one = await pair(business); const two = await pair(business);
    const attempts = await Promise.all([
      deviceCall<Session>('device_set_employee_pin', { deviceToken: one.deviceToken, setupCode: person.pinSetup!.setupCode, pin: '024680', operationId: randomUUID() }),
      deviceCall<Session>('device_set_employee_pin', { deviceToken: two.deviceToken, setupCode: person.pinSetup!.setupCode, pin: '086420', operationId: randomUUID() }),
    ]);
    expect(attempts.filter(r => r.data)).toHaveLength(1); expect(attempts.filter(r => r.error?.code === 'PIN_SETUP_INVALID')).toHaveLength(1);
    expect(sql(`select count(*) from app_private.shared_employee_credentials where employee_id=${uuid(person.id)};`).trim()).toBe('1');
  }, 30_000);

  it('serializes PIN setup against deletion and restoration without reviving its code or operator token', async () => {
    const business = await newBusiness(); const person = await createPerson(business); const device = await pair(business);
    const choosing = { deviceToken: device.deviceToken, setupCode: person.pinSetup!.setupCode, pin: '024680', operationId: randomUUID() };
    const [chosen, deleted] = await Promise.all([
      deviceCall<Session>('device_set_employee_pin', choosing),
      manage(owner, 'delete_employee', { ...args(business), employeeId: person.id, operationId: randomUUID() }),
    ]);
    expect(deleted.data).toEqual({ id: person.id, deleted: true });
    expect(chosen.data || chosen.error?.code === 'PIN_SETUP_INVALID').toBeTruthy();
    expect((await manage(owner, 'restore_employee', { ...args(business), employeeId: person.id, operationId: randomUUID() })).data).toBeTruthy();
    if (chosen.data) expect((await deviceCall('device_context', { deviceToken: device.deviceToken, operatorToken: chosen.data.operatorToken })).error?.code).toBe('SESSION_INVALID');
    expect((await deviceCall('device_set_employee_pin', choosing)).error?.code).toBe('PIN_SETUP_INVALID');
    expect(sql(`select count(*) from app_private.device_operator_sessions where employee_id=${uuid(person.id)} and revoked_at is null;`).trim()).toBe('0');
  }, 30_000);
});

function args(session: Session) { return { businessId: session.business.id, operatorToken: session.operatorToken }; }
async function createPerson(business: Session, google = false) {
  const result = await manage<Employee>(owner, 'create_employee', { ...args(business), name: `Persona ${randomUUID().slice(0, 8)}`, role: 'cashier', pin: null, inviteWithGoogle: google, operationId: randomUUID() });
  expect(result.error).toBeUndefined(); return result.data!;
}
async function invite(business: Session, employeeId: string) {
  const result = await manage<{ invitationCode: string }>(owner, 'create_invitation', { ...args(business), employeeId, operationId: randomUUID() });
  expect(result.error).toBeUndefined(); return result.data!;
}
async function pair(business: Session) {
  const pairing = (await manage<{ pairingCode: string }>(owner, 'create_pairing_code', { ...args(business), operationId: randomUUID() })).data!;
  const result = await deviceCall<{ deviceToken: string }>('device_pair', { pairingCode: pairing.pairingCode, deviceName: 'Caja PIN propio', operationId: randomUUID() });
  expect(result.error).toBeUndefined(); return result.data!;
}
async function chooseDevice(deviceToken: string, setupCode: string, pin: string) {
  const result = await deviceCall<Session>('device_set_employee_pin', { deviceToken, setupCode, pin, operationId: randomUUID() });
  expect(result.error).toBeUndefined(); return result.data!;
}
async function newBusiness() {
  const result = await edge<Session>(owner, { action: 'create_business', name: `Negocio PIN ${randomUUID().slice(0, 8)}`, businessType: 'cafe', timezone: 'America/Mexico_City', pin: '583927', operationId: randomUUID() });
  expect(result.error).toBeUndefined(); businesses.push(result.data!.business.id); return result.data!;
}
async function manage<T = unknown>(person: Identity, action: string, payload: Record<string, unknown>): Promise<Reply<T>> {
  const signed = await signedRequest(person.userId, { action, ...payload }) as { deviceProof: { publicKey: string; nonce: string } };
  const result = await admin.rpc('account_secure', { p_user_id: person.userId, p_auth_session_id: person.sessionId, p_action: action, p_payload: payload, p_device_key_hash: createHash('sha256').update(Buffer.from(signed.deviceProof.publicKey, 'base64url')).digest('hex'), p_proof_nonce: signed.deviceProof.nonce });
  return result.error ? { error: { code: result.error.message } } : result.data;
}
async function deviceCall<T = unknown>(action: string, payload: Record<string, unknown>): Promise<Reply<T>> {
  const result = await admin.rpc('account_device', { p_action: action, p_payload: payload });
  return result.error ? { error: { code: result.error.message } } : result.data;
}
async function edge<T = unknown>(person: Identity, request: Record<string, unknown>): Promise<Reply<T>> {
  const response = await fetch(`${local!.url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: local!.anonKey, authorization: `Bearer ${person.token}` }, body: JSON.stringify(await signedRequest(person.userId, request)) });
  return response.json();
}
async function identity(): Promise<Identity> {
  const email = `integration-pin-${randomUUID()}@example.test`; const password = `local-only-${randomUUID()}-Aa9!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw created.error; users.push(created.data.user.id);
  const client = createClient(local!.url, local!.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await client.auth.signInWithPassword({ email, password }); if (signed.error) throw signed.error;
  const token = signed.data.session!.access_token; const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  return { userId: created.data.user.id, sessionId: claims.session_id, token };
}
function localConfig() {
  let status: Record<string, string>;
  if (process.env.TEST_SUPABASE_URL) status = { API_URL: process.env.TEST_SUPABASE_URL, ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? '', SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '' };
  else try { status = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch { return null; }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(status.API_URL).hostname)) throw new Error('PIN integration tests refuse cloud');
  const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)![1];
  return { url: status.API_URL, anonKey: status.ANON_KEY, serviceKey: status.SERVICE_ROLE_KEY, dbContainer: process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${project}` };
}
function sql(statement: string) { return execFileSync('docker', ['exec', '-i', local!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Synthetic UUID expected'); return `'${value}'::uuid`; }
function literal(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Synthetic code expected'); return `'${value}'`; }
