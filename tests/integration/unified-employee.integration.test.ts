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

describe.skipIf(!config)('one employee with optional Google access', () => {
  beforeAll(async () => {
    admin=createClient(config!.url,config!.serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    [owner,anotherOwner,employee]=await Promise.all([newAccount(),newAccount(),newAccount()]);
  },30_000);
  afterAll(async () => {
    for(const userId of syntheticUserIds){const {error}=await admin.auth.admin.deleteUser(userId);if(error)throw error;}
    if(syntheticBusinessIds.length)sql(`delete from app_private.businesses where id in (${syntheticBusinessIds.map(sqlUuid).join(',')});`);
  },30_000);

  it('links Google to the same PIN-only employee and invalidates the old register session',async()=>{
    const business=await newBusiness(owner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const request={action:'create_employee',...args,name:'Persona única',role:'cashier',pin:null,operationId:randomUUID()};
    const person=(await account<{id:string;pinSetup:{setupCode:string}}>(owner,request)).body.data!;
    const code=(await account<{pairingCode:string}>(owner,{action:'create_pairing_code',...args,operationId:randomUUID()})).body.data!.pairingCode;
    const device=(await account<{deviceToken:string}>(null,{action:'device_pair',pairingCode:code,deviceName:'Caja sintética',operationId:randomUUID()})).body.data!;
    const old=(await account<BusinessSession>(null,{action:'device_set_employee_pin',deviceToken:device.deviceToken,setupCode:person.pinSetup.setupCode,pin:'024680',operationId:randomUUID()})).body.data!;
    const invitation=await account<{invitationCode:string}>(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()});
    expect(invitation.status).toBe(200);
    const accepted=await account<BusinessSession & {business:{employee:{id:string;name:string}}}>(employee,{action:'accept_invitation',invitationCode:invitation.body.data!.invitationCode,name:'Nombre del usuario',pin:'024680',operationId:randomUUID()});
    expect(accepted.status).toBe(200);expect(accepted.body.data?.business.employee).toMatchObject({id:person.id,name:'Persona única'});
    expect(sql(`select count(*) from app_private.employees where business_id=${sqlUuid(business.business.id)} and role<>'owner';`).trim()).toBe('1');
    expect(sql(`select count(*) from app_private.shared_employee_credentials where employee_id=${sqlUuid(person.id)};`).trim()).toBe('0');
    expect((await account(null,{action:'device_context',deviceToken:device.deviceToken,operatorToken:old.operatorToken})).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'086420'})).body.error?.code).toBe('PIN_INVALID');
    expect((await account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'024680'})).status).toBe(200);
    const replay=await account<{id:string;googleLinked:boolean}>(owner,request);expect(replay.status).toBe(200);expect(replay.body.data).toMatchObject({id:person.id,googleLinked:true});
    expect((await account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'024680'})).status).toBe(200);
  },30_000);

  it('creates Google access atomically without a temporary PIN or duplicate on concurrent retries',async()=>{
    const business=await newBusiness(owner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const request={action:'create_employee',...args,name:'Persona pendiente',role:'kitchen',pin:null,inviteWithGoogle:true,operationId:randomUUID()};
    const replies=await Promise.all([account<{id:string;pinReady:boolean;googleLinked:boolean;invitation:{invitationCode:string;invitationId:string}}>(owner,request),account<{id:string;invitation:{invitationId:string}}>(owner,request)]);
    expect(replies[0].status).toBe(200);expect(replies[1].status).toBe(200);expect(replies[0].body.data).toMatchObject({pinReady:false,googleLinked:false});expect(replies[1].body.data?.id).toBe(replies[0].body.data?.id);expect(replies[1].body.data?.invitation.invitationId).toBe(replies[0].body.data?.invitation.invitationId);
    const final=(await account<{id:string;invitation:{invitationCode:string}}>(owner,request)).body.data!;
    const pairing=(await account<{pairingCode:string}>(owner,{action:'create_pairing_code',...args,operationId:randomUUID()})).body.data!;
    const device=(await account<{deviceToken:string}>(null,{action:'device_pair',pairingCode:pairing.pairingCode,deviceName:'Caja pendiente',operationId:randomUUID()})).body.data!;
    const roster=await account<{employees:{id:string}[]}>(null,{action:'device_status',deviceToken:device.deviceToken});expect(roster.body.data?.employees.map(e=>e.id)).not.toContain(final.id);
    expect(sql(`select count(*) from app_private.shared_employee_credentials where employee_id=${sqlUuid(final.id)};`).trim()).toBe('0');
    await account(owner,{action:'update_employee',...args,employeeId:final.id,name:'Nombre vigente',role:'manager',active:true,pin:null});
    const accepted=await account<BusinessSession & {business:{employee:{id:string;name:string}}}>(employee,{action:'accept_invitation',invitationCode:final.invitation.invitationCode,name:'Nombre arbitrario',pin:'012468',operationId:randomUUID()});
    expect(accepted.status).toBe(200);expect(accepted.body.data?.business).toMatchObject({role:'manager',employee:{id:final.id,name:'Nombre vigente'}});
    const updated=await account<{id:string;pinReady:boolean;googleLinked:boolean;invitation?:unknown}>(owner,request);expect(updated.status).toBe(200);expect(updated.body.data).toMatchObject({id:final.id,pinReady:true,googleLinked:true});expect(updated.body.data?.invitation).toBeUndefined();
    expect((await account(null,{action:'device_status',deviceToken:device.deviceToken})).body.data).toMatchObject({employees:expect.arrayContaining([expect.objectContaining({id:final.id})])});
  },30_000);

  it('does not merge names and blocks the ambiguous legacy duplicate path',async()=>{
    const business=await newBusiness(owner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const make=()=>account<{id:string}>(owner,{action:'create_employee',...args,name:'Homónimo',role:'cashier',pin:null,operationId:randomUUID()});
    const first=await make(),second=await make();expect(first.status).toBe(200);expect(second.status).toBe(200);expect(first.body.data?.id).not.toBe(second.body.data?.id);
    expect((await account(owner,{action:'create_invitation',...args,name:' Homónimo ',role:'cashier',operationId:randomUUID()})).body.error?.code).toBe('OPERATION_CONFLICT');
    const legacy={action:'create_invitation',...args,name:'Persona legacy',role:'cashier',operationId:randomUUID()};
    const invitation=await account<{invitationCode:string;invitationId:string}>(owner,legacy);expect(invitation.status).toBe(200);
    const repeated=await account<{invitationCode:string;invitationId:string}>(owner,legacy);expect(repeated.status).toBe(200);expect(repeated.body.data?.invitationId).toBe(invitation.body.data?.invitationId);
    const team=(await account<{employees:{id:string;name:string}[];invitations:{id:string;employeeId:string}[]}>(owner,{action:'team',...args})).body.data!;
    expect(team.invitations.find(i=>i.id===invitation.body.data!.invitationId)?.employeeId).toBe(team.employees.find(e=>e.name==='Persona legacy')?.id);
    expect(sql(`select count(*) from app_private.employees where business_id=${sqlUuid(business.business.id)} and name='Persona legacy';`).trim()).toBe('1');
  });

  it('rejects foreign, owner, inactive and already-linked targets',async()=>{
    const business=await newBusiness(owner),other=await newBusiness(anotherOwner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const person=(await account<{id:string}>(owner,{action:'create_employee',...args,name:'Persona controlada',role:'cashier',pin:null,operationId:randomUUID()})).body.data!;
    const ownerPerson=(await account<{employees:{id:string;role:string}[]}>(owner,{action:'team',...args})).body.data!.employees.find(e=>e.role==='owner')!;
    expect((await account(owner,{action:'create_invitation',...args,employeeId:ownerPerson.id,operationId:randomUUID()})).body.error?.code).toBe('PERMISSION_DENIED');
    const foreign=(await account<{employees:{id:string}[]}>(anotherOwner,{action:'team',businessId:other.business.id,operatorToken:other.operatorToken})).body.data!.employees[0];
    expect((await account(owner,{action:'create_invitation',...args,employeeId:foreign.id,operationId:randomUUID()})).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    const invitation=(await account<{invitationCode:string}>(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()})).body.data!;
    await account(owner,{action:'update_employee',...args,employeeId:person.id,name:'Persona controlada',role:'cashier',active:false,pin:null});
    expect((await account(employee,{action:'accept_invitation',invitationCode:invitation.invitationCode,name:'Persona controlada',pin:'086420',operationId:randomUUID()})).body.error?.code).toBe('EMPLOYEE_INACTIVE');
    expect((await account(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()})).body.error?.code).toBe('EMPLOYEE_INACTIVE');
    await account(owner,{action:'update_employee',...args,employeeId:person.id,name:'Persona controlada',role:'cashier',active:true,pin:null});
    const next=(await account<{invitationCode:string}>(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()})).body.data!;
    expect((await account(employee,{action:'accept_invitation',invitationCode:next.invitationCode,name:'Persona controlada',pin:'086420',operationId:randomUUID()})).status).toBe(200);
    expect((await account(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()})).body.error?.code).toBe('INVITATION_INVALID');
  },30_000);

  it('preserves a shared PIN cooldown without consuming its Google invitation',async()=>{
    const business=await newBusiness(owner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const person=await createPinPerson(args,'Persona bloqueada');
    const invitation=(await account<{invitationCode:string;invitationId:string}>(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()})).body.data!;
    sql(`update app_private.shared_employee_credentials set failed_attempts=5,locked_until=now()+interval '15 minutes' where employee_id=${sqlUuid(person.id)};`);
    const request={action:'accept_invitation',invitationCode:invitation.invitationCode,pin:'024680',operationId:randomUUID()};
    expect((await account(employee,request)).body.error?.code).toBe('PIN_LOCKED');
    expect(sql(`select accepted_by is null from app_private.business_invitations where id=${sqlUuid(invitation.invitationId)};`).trim()).toBe('t');
    expect(sql(`select count(*) from app_private.business_memberships where business_id=${sqlUuid(business.business.id)} and role='cashier';`).trim()).toBe('0');
    expect(sql(`select count(*) from app_private.shared_employee_credentials where employee_id=${sqlUuid(person.id)};`).trim()).toBe('1');
    sql(`update app_private.shared_employee_credentials set locked_until=now()-interval '1 second' where employee_id=${sqlUuid(person.id)};`);
    const finalRequest={...request,operationId:randomUUID()};
    const accepted=await account<BusinessSession & {business:{employee:{id:string}}}>(employee,finalRequest);expect(accepted.status).toBe(200);expect(accepted.body.data?.business.employee.id).toBe(person.id);
    const wrong=await Promise.all(Array.from({length:5},()=>account(employee,{...finalRequest,pin:'999999'})));
    expect(wrong.filter(r=>r.body.error?.code==='OPERATION_CONFLICT')).toHaveLength(4);expect(wrong.filter(r=>r.body.error?.code==='PIN_LOCKED')).toHaveLength(1);
    expect((await account(employee,finalRequest)).body.error?.code).toBe('PIN_LOCKED');
  },30_000);

  it('allows one target to win when the same Google identity accepts two people concurrently',async()=>{
    const business=await newBusiness(owner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const targets=await Promise.all(['Primera persona','Segunda persona'].map(name=>account<{invitation:{invitationCode:string}}>(owner,{action:'create_employee',...args,name,role:'cashier',pin:null,inviteWithGoogle:true,operationId:randomUUID()})));
    expect(targets.every(r=>r.status===200)).toBe(true);
    const results=await Promise.all(targets.map(target=>account(employee,{action:'accept_invitation',invitationCode:target.body.data!.invitation.invitationCode,pin:'086420',operationId:randomUUID()})));
    expect(results.map(r=>r.status).sort()).toEqual([200,403]);expect(results.find(r=>r.status===403)?.body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    expect(sql(`select count(*) from app_private.employees where business_id=${sqlUuid(business.business.id)} and user_id=${sqlUuid(employee.userId)};`).trim()).toBe('1');
  },30_000);

  it('lets a pending employee choose a PIN with owner authorization without creating a second person',async()=>{
    const business=await newBusiness(owner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const person=(await account<{id:string}>(owner,{action:'create_employee',...args,name:'Persona sinPIN',role:'cashier',pin:null,inviteWithGoogle:true,operationId:randomUUID()})).body.data!;
    const setup=await account<{setupCode:string}>(owner,{action:'create_pin_setup',...args,employeeId:person.id,operationId:randomUUID()});
    expect(setup.status).toBe(200);
    const pairing=(await account<{pairingCode:string}>(owner,{action:'create_pairing_code',...args,operationId:randomUUID()})).body.data!;
    const device=(await account<{deviceToken:string}>(null,{action:'device_pair',pairingCode:pairing.pairingCode,deviceName:'Caja conPIN',operationId:randomUUID()})).body.data!;
    const chosen=await account<BusinessSession>(null,{action:'device_set_employee_pin',deviceToken:device.deviceToken,setupCode:setup.body.data!.setupCode,pin:'024680',operationId:randomUUID()});
    expect(chosen.status).toBe(200);
    const updated=(await account<{employees:{id:string;pinReady:boolean;googleLinked:boolean}[]}>(owner,{action:'team',...args})).body.data!.employees.find(e=>e.id===person.id);
    expect(updated).toMatchObject({id:person.id,pinReady:true,googleLinked:false});
    expect((await account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'024680'})).status).toBe(200);
  },30_000);

  it('allows one identity to win across two invitations for the same employee',async()=>{
    const business=await newBusiness(owner);const args={businessId:business.business.id,operatorToken:business.operatorToken};
    const person=(await account<{id:string}>(owner,{action:'create_employee',...args,name:'Una persona',role:'cashier',pin:null,operationId:randomUUID()})).body.data!;
    const invitations=await Promise.all([1,2].map(()=>account<{invitationCode:string}>(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()})));
    expect(invitations.every(i=>i.status===200)).toBe(true);
    const results=await Promise.all([employee,anotherOwner].map((identity,index)=>account<BusinessSession>(identity,{action:'accept_invitation',invitationCode:invitations[index].body.data!.invitationCode,name:'Una persona',pin:'086420',operationId:randomUUID()})));
    expect(results.map(r=>r.status).sort()).toEqual([200,400]);expect(results.find(r=>r.status===400)?.body.error?.code).toBe('INVITATION_INVALID');
    expect(sql(`select count(*) from app_private.business_memberships where business_id=${sqlUuid(business.business.id)} and role='cashier';`).trim()).toBe('1');
    expect(sql(`select count(*) from app_private.employees where business_id=${sqlUuid(business.business.id)} and role='cashier';`).trim()).toBe('1');
  });
});


async function createPinPerson(args:{businessId:string;operatorToken:string},name:string){
  const person=(await account<{id:string;pinSetup:{setupCode:string}}>(owner,{action:'create_employee',...args,name,role:'cashier',pin:null,inviteWithGoogle:false,operationId:randomUUID()})).body.data!;
  const pairing=(await account<{pairingCode:string}>(owner,{action:'create_pairing_code',...args,operationId:randomUUID()})).body.data!;
  const device=(await account<{deviceToken:string}>(null,{action:'device_pair',pairingCode:pairing.pairingCode,deviceName:'Caja PIN propio',operationId:randomUUID()})).body.data!;
  expect((await account(null,{action:'device_set_employee_pin',deviceToken:device.deviceToken,setupCode:person.pinSetup.setupCode,pin:'024680',operationId:randomUUID()})).status).toBe(200);
  return person;
}

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
