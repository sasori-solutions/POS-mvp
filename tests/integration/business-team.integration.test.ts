import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type LocalConfig = { url: string; anonKey: string; serviceRoleKey: string; dbContainer: string };
type TestAccount = { userId: string; token: string; sessionId: string; client: SupabaseClient };
type BusinessSession = {
  business: { id: string; name: string; businessType: string; timezone: string; currency: string; role: string };
  operatorToken: string;
  expiresAt: string;
};
type ApiReply<T> = { status: number; body: { data?: T; error?: { code: string; message: string; retryAfterSeconds?: number } } };

const config = loadLocalConfig();
const syntheticUserIds: string[] = [];
const syntheticBusinessIds: string[] = [];
const validPin = '583927';
let admin: SupabaseClient;
let owner: TestAccount;
let anotherOwner: TestAccount;
let employee: TestAccount;

describe.skipIf(!config)('business profile, personal employees and shared device security', () => {
  beforeAll(async () => {
    admin = createClient(config!.url, config!.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    [owner, anotherOwner, employee] = await Promise.all([newAccount(), newAccount(), newAccount()]);
  }, 30_000);
  afterAll(async () => {
    for (const userId of syntheticUserIds) { const { error } = await admin.auth.admin.deleteUser(userId); if (error) throw error; }
    if (syntheticBusinessIds.length) sql(`delete from app_private.businesses where id in (${syntheticBusinessIds.map(sqlUuid).join(',')});`);
  }, 30_000);

  it('persists progressive configuration and accepts old creation payloads', async () => {
    const profile = { branchName: 'Principal', registerName: 'Caja 1', address: 'Calle sintética 123', city: 'Guadalajara', state: 'Jalisco', contactPhone: '', paymentMethods: ['cash', 'card_external'] };
    const request = createRequest({ profile });
    const created = await account<BusinessSession & { business: { profile: typeof profile } }>(owner, request);
    expect(created.status).toBe(200);
    const session = created.body.data!; rememberBusiness(session.business.id);
    expect(session.business.profile).toEqual(profile);
    const changed = await account(owner, { action: 'update_business', businessId: session.business.id, operatorToken: session.operatorToken, name: 'Perfil actualizado', businessType: 'restaurant', timezone: 'America/Cancun', profile: { ...profile, paymentMethods: ['transfer'] } });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ name: 'Perfil actualizado', timezone: 'America/Cancun', profile: { paymentMethods: ['transfer'] } });
    expect((await account(owner, { ...request, profile: { ...profile, city: 'Otro' } })).body.error?.code).toBe('OPERATION_CONFLICT');
    expect((await newBusiness(owner)).business.role).toBe('owner');
  });

  it('consumes an invitation once, grants server role and redacts profile from employees', async () => {
    const business = await newBusiness(owner);
    const ownerArgs = { businessId: business.business.id, operatorToken: business.operatorToken };
    const inviteRequest = { action: 'create_invitation', ...ownerArgs, name: 'Operador sintético', role: 'cashier', operationId: randomUUID() };
    const [invite, replay] = await Promise.all([account<{ invitationCode: string; invitationId: string }>(owner, inviteRequest), account<{ invitationCode: string; invitationId: string }>(owner, inviteRequest)]);
    expect(invite.status).toBe(200); expect(replay.status).toBe(200);
    expect(invite.body.data?.invitationId).toBe(replay.body.data?.invitationId);
    const finalInvite = await account<{ invitationCode: string }>(owner, inviteRequest);
    const request = { action: 'accept_invitation', invitationCode: finalInvite.body.data!.invitationCode, name: 'Cajero sintético', pin: '024681', operationId: randomUUID() };
    const accepted = await account<BusinessSession & { business: { employee: { id: string }; profile: { address: string } } }>(employee, request);
    expect(accepted.status).toBe(200); const member = accepted.body.data!;
    expect(member.business.role).toBe('cashier'); expect(member.business.profile.address).toBe('');
    const duplicate = await account<BusinessSession>(employee, request); expect(duplicate.status).toBe(200); expect(duplicate.body.data?.business.id).toBe(business.business.id);
    const stolen = await account(anotherOwner, { ...request, operationId: randomUUID() }); expect(stolen.body.error?.code).toBe('INVITATION_INVALID');
    const status = await account<{ businesses: { id: string }[] }>(employee, { action: 'status' }); expect(status.body.data?.businesses.map(b => b.id)).toContain(business.business.id);
    const refreshed = await account<BusinessSession>(employee, { action: 'unlock', businessId: business.business.id, pin: '024681' }); expect(refreshed.status).toBe(200);
    for (const action of ['team', 'create_pairing_code']) {
      const denied = await account(employee, { action, businessId: business.business.id, operatorToken: refreshed.body.data!.operatorToken, ...(action === 'create_pairing_code' ? { operationId: randomUUID() } : {}) });
      expect(denied.status).toBe(403); expect(denied.body.error?.code).toBe('PERMISSION_DENIED');
    }
    const edited = await account(owner, { action: 'update_employee', ...ownerArgs, employeeId: member.business.employee.id, name: 'Cajero sintético', role: 'kitchen', active: false, pin: null }); expect(edited.status).toBe(200);
    expect((await account(employee, { action: 'context', businessId: business.business.id, operatorToken: refreshed.body.data!.operatorToken })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    expect((await account(employee, { action: 'unlock', businessId: business.business.id, pin: '024681' })).status).toBe(403);
  });

  it('pairs restricted device, switches operators atomically, locks and denies revoked devices', async () => {
    const business = await newBusiness(owner); const ownerArgs = { businessId: business.business.id, operatorToken: business.operatorToken };
    const create = { action: 'create_employee', ...ownerArgs, name: 'Cajero de caja', role: 'cashier', pin: '002468', operationId: randomUUID() };
    const person = await account<{ id: string }>(owner, create); expect(person.status).toBe(200);
    expect((await account<{ id: string }>(owner, create)).body.data?.id).toBe(person.body.data?.id);
    const pairCode = await account<{ pairingCode: string }>(owner, { action: 'create_pairing_code', ...ownerArgs, operationId: randomUUID() }); expect(pairCode.status).toBe(200);
    const pairing = { action: 'device_pair', pairingCode: pairCode.body.data!.pairingCode, deviceName: 'Tablet sintética', operationId: randomUUID() };
    const paired = await account<{ deviceId: string; deviceToken: string }>(null, pairing); expect(paired.status).toBe(200); let deviceToken = paired.body.data!.deviceToken;
    const repeated = await account<{ deviceId: string; deviceToken: string }>(null, pairing); expect(repeated.status).toBe(200); expect(repeated.body.data!.deviceId).toBe(paired.body.data!.deviceId); deviceToken = repeated.body.data!.deviceToken;
    expect((await account(null, { ...pairing, operationId: randomUUID() })).body.error?.code).toBe('PAIRING_INVALID');
    const status = await account<{ employees: { id: string; role: string }[] }>(null, { action: 'device_status', deviceToken }); expect(status.status).toBe(200);
    const ownerEmployee = status.body.data!.employees.find(e => e.role === 'owner')!;
    const first = await account<BusinessSession>(null, { action: 'device_unlock', deviceToken, employeeId: person.body.data!.id, pin: '002468' }); expect(first.status).toBe(200); expect(first.body.data?.business.role).toBe('cashier');
    const second = await account<BusinessSession>(null, { action: 'device_unlock', deviceToken, employeeId: ownerEmployee.id, pin: validPin }); expect(second.status).toBe(200);
    expect((await account(null, { action: 'device_context', deviceToken, operatorToken: first.body.data!.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(null, { action: 'device_lock', deviceToken, operatorToken: second.body.data!.operatorToken })).status).toBe(200);
    expect((await account(null, { action: 'device_context', deviceToken, operatorToken: second.body.data!.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner, { action: 'revoke_device', ...ownerArgs, deviceId: paired.body.data!.deviceId })).status).toBe(200);
    expect((await account(null, { action: 'device_status', deviceToken })).body.error?.code).toBe('DEVICE_REVOKED');
    expect((await account(null, { action: 'device_unlock', deviceToken, employeeId: person.body.data!.id, pin: '002468' })).body.error?.code).toBe('DEVICE_REVOKED');
  }, 30_000);


  it('rejects expired/revoked invitations and accepts only one competing identity', async () => {
    const business = await newBusiness(owner); const ownerArgs = { businessId: business.business.id, operatorToken: business.operatorToken };
    const invite = () => account<{ invitationCode: string; invitationId: string }>(owner, { action: 'create_invitation', ...ownerArgs, name: `Encargado sintético ${randomUUID().slice(0, 8)}`, role: 'manager', operationId: randomUUID() });
    const expired = (await invite()).body.data!;
    sql(`update app_private.business_invitations set expires_at=now()-interval '1 second' where id=${sqlUuid(expired.invitationId)};`);
    expect((await account(employee, { action: 'accept_invitation', invitationCode: expired.invitationCode, name: 'Persona sintética', pin: '246802', operationId: randomUUID() })).body.error?.code).toBe('INVITATION_INVALID');
    const revoked = (await invite()).body.data!;
    expect((await account(owner, { action: 'revoke_invitation', ...ownerArgs, invitationId: revoked.invitationId })).status).toBe(200);
    expect((await account(employee, { action: 'accept_invitation', invitationCode: revoked.invitationCode, name: 'Persona sintética', pin: '246802', operationId: randomUUID() })).body.error?.code).toBe('INVITATION_INVALID');
    const live = (await invite()).body.data!;
    const concurrent = await Promise.all([employee, anotherOwner].map(identity => account(identity, { action: 'accept_invitation', invitationCode: live.invitationCode, name: 'Persona sintética', pin: '246802', operationId: randomUUID() })));
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 400]);
    expect(concurrent.find(r => r.status === 400)?.body.error?.code).toBe('INVITATION_INVALID');
    expect(sql(`select count(*) from app_private.employees where business_id=${sqlUuid(business.business.id)} and role='manager' and user_id is not null;`).trim()).toBe('1');
  });

  it('enforces shared employee PIN lockout under concurrency and removes inactive operators', async () => {
    const business = await newBusiness(owner); const ownerArgs = { businessId: business.business.id, operatorToken: business.operatorToken };
    const request = { action: 'create_employee', ...ownerArgs, name: 'Cocina sintética', role: 'kitchen', pin: '086420', operationId: randomUUID() };
    const people = await Promise.all([account<{ id: string }>(owner, request), account<{ id: string }>(owner, request)]);
    expect(people[0].status).toBe(200); expect(people[1].body.data?.id).toBe(people[0].body.data?.id); const employeeId=people[0].body.data!.id;
    expect((await account(owner, { ...request, role: 'manager' })).body.error?.code).toBe('OPERATION_CONFLICT');
    const code=(await account<{ pairingCode: string }>(owner, { action: 'create_pairing_code', ...ownerArgs, operationId: randomUUID() })).body.data!.pairingCode;
    const device=(await account<{ deviceId: string; deviceToken: string }>(null, { action: 'device_pair', pairingCode: code, deviceName: 'Caja de cocina', operationId: randomUUID() })).body.data!;
    const login={ action: 'device_unlock', deviceToken: device.deviceToken, employeeId, pin: '086420' };
    const locked=await Promise.all(Array.from({length:5},()=>account(null, {...login,pin:'999999'})));
    expect(locked.filter(r=>r.body.error?.code==='PIN_INVALID')).toHaveLength(4); expect(locked.filter(r=>r.body.error?.code==='PIN_LOCKED')).toHaveLength(1);
    expect((await account(null,login)).body.error?.code).toBe('PIN_LOCKED');
    sql(`update app_private.shared_employee_credentials set locked_until=now()-interval '1 second' where employee_id=${sqlUuid(employeeId)};`);
    const unlocked=await account<BusinessSession>(null,login); expect(unlocked.status).toBe(200); expect(unlocked.body.data?.business.role).toBe('kitchen');
    expect((await account(owner,{ action:'team',businessId:business.business.id,operatorToken:unlocked.body.data!.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner,{ action:'update_employee',...ownerArgs,employeeId,name:'Cocina sintética',role:'kitchen',active:false,pin:null })).status).toBe(200);
    expect((await account(null,{ action:'device_context',deviceToken:device.deviceToken,operatorToken:unlocked.body.data!.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    const roster=await account<{employees:{id:string}[]}>(null,{action:'device_status',deviceToken:device.deviceToken}); expect(roster.body.data?.employees.map(e=>e.id)).not.toContain(employeeId);
    expect((await account(null,login)).body.error?.code).toBe('EMPLOYEE_INACTIVE');
  },30_000);

  it('shares lockout for personal and device PINs and revokes device operators when owner PIN changes', async () => {
    const business=await newBusiness(owner);const ownerArgs={businessId:business.business.id,operatorToken:business.operatorToken};
    const pairing=(await account<{pairingCode:string}>(owner,{action:'create_pairing_code',...ownerArgs,operationId:randomUUID()})).body.data!;
    const device=(await account<{deviceToken:string}>(null,{action:'device_pair',pairingCode:pairing.pairingCode,deviceName:'Caja de dueño',operationId:randomUUID()})).body.data!;
    const roster=(await account<{employees:{id:string;role:string}[]}>(null,{action:'device_status',deviceToken:device.deviceToken})).body.data!;
    const ownerId=roster.employees.find(e=>e.role==='owner')!.id;
    const session=await account<BusinessSession & {business:{profile:{address:string}}}>(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:ownerId,pin:validPin});expect(session.status).toBe(200);expect(session.body.data?.business.profile.address).toBe('');
    sql(`update auth.sessions set created_at=now() where id=${sqlUuid(owner.sessionId)};`);
    expect((await account(owner,{action:'reset_pin',businessId:business.business.id,pin:'901234'})).status).toBe(200);
    expect((await account(null,{action:'device_context',deviceToken:device.deviceToken,operatorToken:session.body.data!.operatorToken})).body.error?.code).toBe('SESSION_INVALID');
    const wrong=await Promise.all([
      account(owner,{action:'unlock',businessId:business.business.id,pin:validPin}),
      ...Array.from({length:4},()=>account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:ownerId,pin:validPin}))
    ]);
    expect(wrong.filter(r=>r.body.error?.code==='PIN_INVALID')).toHaveLength(4);expect(wrong.filter(r=>r.body.error?.code==='PIN_LOCKED')).toHaveLength(1);
    expect((await account(owner,{action:'unlock',businessId:business.business.id,pin:'901234'})).body.error?.code).toBe('PIN_LOCKED');
  },30_000);

  it('rejects expired pairing codes, cross-tenant employees and direct browser access', async () => {
    const business=await newBusiness(owner);const other=await newBusiness(anotherOwner);const ownerArgs={businessId:business.business.id,operatorToken:business.operatorToken};
    const code=async()=> (await account<{pairingCode:string}>(owner,{action:'create_pairing_code',...ownerArgs,operationId:randomUUID()})).body.data!.pairingCode;
    const expired=await code();
    sql(`update app_private.device_pairing_codes set expires_at=now()-interval '1 second' where business_id=${sqlUuid(business.business.id)};`);
    expect((await account(null,{action:'device_pair',pairingCode:expired,deviceName:'Caja expirada',operationId:randomUUID()})).body.error?.code).toBe('PAIRING_INVALID');
    const device=(await account<{deviceToken:string}>(null,{action:'device_pair',pairingCode:await code(),deviceName:'Caja aislada',operationId:randomUUID()})).body.data!;
    const foreignEmployee=(await account<{employees:{id:string}[]}>(anotherOwner,{action:'team',businessId:other.business.id,operatorToken:other.operatorToken})).body.data!.employees[0].id;
    expect((await account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:foreignEmployee,pin:validPin})).body.error?.code).toBe('EMPLOYEE_INACTIVE');
    const projection=await account<Record<string,unknown>>(null,{action:'device_status',deviceToken:device.deviceToken});expect(Object.keys(projection.body.data!).sort()).toEqual(['business','employees','registerName']);
    expect((await account(null,{action:'device_status',deviceToken:'0'.repeat(64)})).body.error?.code).toBe('DEVICE_REVOKED');
    for(const table of ['employees','shared_employee_credentials','employee_create_operations','business_invitations','devices','device_pairing_codes','device_operator_sessions']) {
      const direct=await fetch(`${config!.url}/rest/v1/${table}?select=*`,{headers:{apikey:config!.anonKey,authorization:`Bearer ${owner.token}`,'accept-profile':'app_private'}});expect(direct.status).toBeGreaterThanOrEqual(400);expect(direct.status).toBeLessThan(500);
      expect(sql(`select relrowsecurity from pg_class where oid='app_private.${table}'::regclass;`).trim()).toBe('t');
    }
    for(const [name,args] of Object.entries({account_manage:{p_user_id:owner.userId,p_auth_session_id:owner.sessionId,p_action:'team',p_payload:ownerArgs},account_device:{p_action:'device_status',p_payload:{deviceToken:device.deviceToken}},account_create_business:{p_user_id:owner.userId,p_auth_session_id:owner.sessionId,p_name:'Direct bypass',p_business_type:'cafe',p_timezone:'America/Mexico_City',p_operation_id:randomUUID(),p_pin:validPin,p_profile:null}})) {
      const direct=await fetch(`${config!.url}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:config!.anonKey,authorization:`Bearer ${owner.token}`,'content-type':'application/json'},body:JSON.stringify(args)});expect(direct.status).toBe(403);
    }
    expect((await account(null,{action:'device_forget',deviceToken:device.deviceToken})).status).toBe(200);
    expect((await account(null,{action:'device_status',deviceToken:device.deviceToken})).body.error?.code).toBe('DEVICE_REVOKED');
  },30_000);

  it('requires fresh owner authentication to reset PIN and revokes all old operator tokens', async () => {
    const business = await newBusiness(owner);
    sql(`update auth.sessions set created_at = now() - interval '6 minutes' where id = ${sqlUuid(owner.sessionId)};`);
    expect((await account(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790' })).body.error?.code).toBe('REAUTH_REQUIRED');
    sql(`update auth.sessions set created_at = now() where id = ${sqlUuid(owner.sessionId)};`);
    const reset = await account<BusinessSession>(owner, { action: 'reset_pin', businessId: business.business.id, pin: '135790' }); expect(reset.status).toBe(200);
    expect((await account(owner, { action: 'context', businessId: business.business.id, operatorToken: business.operatorToken })).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner, { action: 'unlock', businessId: business.business.id, pin: validPin })).body.error?.code).toBe('PIN_INVALID');
    expect((await account(owner, { action: 'unlock', businessId: business.business.id, pin: '135790' })).status).toBe(200);
  });
});

function loadLocalConfig(): LocalConfig | null {
  let status: Record<string, string>;
  if (process.env.TEST_SUPABASE_URL) {
    status = {
      API_URL: process.env.TEST_SUPABASE_URL,
      ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? '',
      SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '',
    };
  } else {
    try {
      status = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch {
      return null;
    }
  }
  const url = new URL(status.API_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Integration tests refuse non-loopback Supabase URLs. No cloud accounts will be created.');
  }
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Local integration credentials are incomplete.');
  const toml = readFileSync('supabase/config.toml', 'utf8');
  const projectId = toml.match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1];
  if (!projectId) throw new Error('Local Supabase project_id is missing.');
  return {
    url: status.API_URL,
    anonKey: status.ANON_KEY,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    dbContainer: process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${projectId}`,
  };
}

async function newAccount(): Promise<TestAccount> {
  const email = `integration-${randomUUID()}@example.test`;
  const password = `local-only-${randomUUID()}-Aa9!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  syntheticUserIds.push(created.data.user.id);
  const client = createClient(config!.url, config!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const token = signedIn.data.session!.access_token;
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  return { userId: created.data.user.id, token, sessionId: claims.session_id, client };
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    action: 'create_business',
    operationId: randomUUID(),
    name: `Synthetic test business ${randomUUID().slice(0, 8)}`,
    businessType: 'cafe',
    timezone: 'America/Mexico_City',
    pin: validPin,
    ...overrides,
  };
}

async function newBusiness(accountOwner: TestAccount): Promise<BusinessSession> {
  const reply = await account<BusinessSession>(accountOwner, createRequest());
  expect(reply.status).toBe(200);
  const data = reply.body.data!;
  rememberBusiness(data.business.id);
  return data;
}

function rememberBusiness(id: string) {
  if (!syntheticBusinessIds.includes(id)) syntheticBusinessIds.push(id);
}

async function account<T = unknown>(identity: TestAccount | null, request: Record<string, unknown>): Promise<ApiReply<T>> {
  const response = await fetch(`${config!.url}/functions/v1/account`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: config!.anonKey,
      ...(identity ? { authorization: `Bearer ${identity.token}` } : {}),
    },
    body: JSON.stringify(request),
  });
  return { status: response.status, body: await response.json() };
}

function sql(statement: string) {
  return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sqlUuid(value: string) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Expected a synthetic UUID for local SQL.');
  return `'${value}'::uuid`;
}
