import { signedRequest } from './device-proof-fixture'
import { execFileSync, spawn } from 'node:child_process';
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

describe.skipIf(!config)('employee lifecycle and truthful invitation status', () => {
  beforeAll(async () => {
    admin=createClient(config!.url,config!.serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    [owner,anotherOwner,employee]=await Promise.all([newAccount(),newAccount(),newAccount()]);
  },30_000);
  afterAll(async () => {
    for(const userId of syntheticUserIds){const {error}=await admin.auth.admin.deleteUser(userId);if(error)throw error;}
    if(syntheticBusinessIds.length)sql(`delete from app_private.businesses where id in (${syntheticBusinessIds.map(sqlUuid).join(',')});`);
  },30_000);

  it('reports accepted, cancelled, expired and unavailable invitations independently',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);
    const acceptedPerson=await makePerson(args,'Persona aceptada');
    const acceptedInvite=await invite(args,acceptedPerson.id);
    expect((await account(employee,{action:'accept_invitation',invitationCode:acceptedInvite.invitationCode,pin:'086420',operationId:randomUUID()})).status).toBe(200);
    // Characterize a real legacy cancellation applied after acceptance: the historical event must remain accepted.
    sql(`update app_private.business_invitations set revoked_at=now() where id=${sqlUuid(acceptedInvite.invitationId)};`);
    const cancelledPerson=await makePerson(args,'Persona cancelada');const cancelled=await invite(args,cancelledPerson.id);
    expect((await account(owner,{action:'revoke_invitation',...args,invitationId:cancelled.invitationId})).status).toBe(200);
    const expiredPerson=await makePerson(args,'Persona vencida');const expired=await invite(args,expiredPerson.id);
    sql(`update app_private.business_invitations set expires_at=now()-interval '1 second' where id=${sqlUuid(expired.invitationId)};`);
    const inactivePerson=await makePerson(args,'Persona pausada');const unavailable=await invite(args,inactivePerson.id);
    await account(owner,{action:'update_employee',...args,employeeId:inactivePerson.id,name:'Persona pausada',role:'cashier',active:false,pin:null});
    const team=(await account<Team>(owner,{action:'team',...args})).body.data!;
    expect(team.invitations.find(i=>i.id===acceptedInvite.invitationId)).toMatchObject({status:'accepted',active:false,acceptedAt:expect.any(String)});
    expect(team.invitations.find(i=>i.id===cancelled.invitationId)).toMatchObject({status:'revoked',active:false,revokeReason:'user_cancelled',revokedAt:expect.any(String),acceptedAt:null});
    expect(team.invitations.find(i=>i.id===expired.invitationId)).toMatchObject({status:'expired',active:false,revokedAt:null});
    expect(team.invitations.find(i=>i.id===unavailable.invitationId)).toMatchObject({status:'unavailable',active:false,revokedAt:null});
    expect((await account(owner,{action:'revoke_invitation',...args,invitationId:acceptedInvite.invitationId})).body.error?.code).toBe('INVITATION_INVALID');
    await account(owner,{action:'revoke_invitation',...args,invitationId:expired.invitationId});
    expect(sql(`select revoked_at is null from app_private.business_invitations where id=${sqlUuid(expired.invitationId)};`).trim()).toBe('t');
  },30_000);

  it('replaces the prior pending link while keeping one employee and stable issuance retries',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);const person=await makePerson(args,'Persona con enlace');
    const previous=await invite(args,person.id);const operationId=randomUUID();const latest=await invite(args,person.id,operationId);
    const retried=await invite(args,person.id,operationId);expect(retried.invitationId).toBe(latest.invitationId);
    const team=(await account<Team>(owner,{action:'team',...args})).body.data!;
    expect(team.invitations.find(i=>i.id===previous.invitationId)).toMatchObject({status:'revoked',revokeReason:'replaced',revokedAt:expect.any(String)});
    expect(team.invitations.filter(i=>i.status==='pending').map(i=>i.id)).toEqual([latest.invitationId]);
    expect((await account(employee,{action:'accept_invitation',invitationCode:previous.invitationCode,pin:'086420',operationId:randomUUID()})).body.error?.code).toBe('INVITATION_INVALID');
    expect((await account(employee,{action:'accept_invitation',invitationCode:retried.invitationCode,pin:'086420',operationId:randomUUID()})).status).toBe(200);
    expect(team.employees.filter(e=>e.role!=='owner')).toHaveLength(1);
  },30_000);

  it('removes PIN staff, invalidates access, and requires explicit restoration without replaying a later lifecycle change',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);
    const creation={action:'create_employee',...args,name:'Persona eliminada',role:'cashier',pin:null,operationId:randomUUID()};
    const person=(await account<Person>(owner,creation)).body.data!;const pending=await invite(args,person.id);const device=await pairDevice(args);
    await choosePin(person,device.deviceToken);
    const session=(await account<BusinessSession>(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'024680'})).body.data!;
    const deletion={action:'delete_employee',...args,employeeId:person.id,operationId:randomUUID()};
    const removed=await account<{id:string;deleted:boolean}>(owner,deletion);expect(removed.status).toBe(200);expect(removed.body.data).toEqual({id:person.id,deleted:true});
    expect((await account(owner,deletion)).body.data).toEqual(removed.body.data);
    let team=(await account<Team>(owner,{action:'team',...args})).body.data!;
    expect(team.employees.map(e=>e.id)).not.toContain(person.id);expect(team.deletedEmployees).toEqual([expect.objectContaining({id:person.id,active:false,deletedAt:expect.any(String)})]);
    expect(team.invitations.find(i=>i.id===pending.invitationId)).toMatchObject({status:'revoked',revokeReason:'employee_deleted'});
    expect((await account<{employees:Person[]}>(null,{action:'device_status',deviceToken:device.deviceToken})).body.data!.employees.map(e=>e.id)).not.toContain(person.id);
    expect((await account(null,{action:'device_context',deviceToken:device.deviceToken,operatorToken:session.operatorToken})).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(owner,{action:'update_employee',...args,employeeId:person.id,name:'Cambio tardío',role:'manager',active:true,pin:null})).body.error?.code).toBe('EMPLOYEE_INACTIVE');
    expect((await account(owner,creation)).body.error?.code).toBe('EMPLOYEE_INACTIVE');
    expect((await account(owner,{action:'create_invitation',...args,employeeId:person.id,operationId:randomUUID()})).body.error?.code).toBe('EMPLOYEE_INACTIVE');
    expect((await account(employee,{action:'accept_invitation',invitationCode:pending.invitationCode,pin:'086420',operationId:randomUUID()})).body.error?.code).toBe('INVITATION_INVALID');
    const restoration={action:'restore_employee',...args,employeeId:person.id,operationId:randomUUID()};
    expect((await account<Person>(owner,restoration)).body.data).toMatchObject({id:person.id,active:true,deletedAt:null,pinReady:true});
    // Lost responses must not undo a more recent human action.
    expect((await account(owner,deletion)).status).toBe(200);
    team=(await account<Team>(owner,{action:'team',...args})).body.data!;expect(team.employees.map(e=>e.id)).toContain(person.id);expect(team.deletedEmployees).toEqual([]);
    expect((await account(null,{action:'device_context',deviceToken:device.deviceToken,operatorToken:session.operatorToken})).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'024680'})).status).toBe(200);
    await account(owner,{...deletion,operationId:randomUUID()});
    expect((await account(owner,restoration)).status).toBe(200);
    team=(await account<Team>(owner,{action:'team',...args})).body.data!;expect(team.employees.map(e=>e.id)).not.toContain(person.id);
  },30_000);

  it('preserves Google acceptance history and PIN cooldown while permanently invalidating old invitation retries',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);const person=await makePerson(args,'Persona Google');
    const invitation=await invite(args,person.id);const acceptance={action:'accept_invitation',invitationCode:invitation.invitationCode,pin:'086420',operationId:randomUUID()};
    const session=(await account<BusinessSession>(employee,acceptance)).body.data!;expect(session.operatorToken).toBeTruthy();
    sql(`update app_private.operator_credentials set failed_attempts=5,locked_until=now()+interval '15 minutes' where business_id=${sqlUuid(business.business.id)} and user_id=${sqlUuid(employee.userId)};`);
    const removed=await account(owner,{action:'delete_employee',...args,employeeId:person.id,operationId:randomUUID()});expect(removed.status).toBe(200);
    expect((await account(employee,{action:'context',businessId:business.business.id,operatorToken:session.operatorToken})).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    expect((await account<{businesses:{id:string}[]}>(employee,{action:'status'})).body.data!.businesses.map(b=>b.id)).not.toContain(business.business.id);
    expect((await account(owner,{action:'restore_employee',...args,employeeId:person.id,operationId:randomUUID()})).status).toBe(200);
    expect((await account(employee,acceptance)).body.error?.code).toBe('INVITATION_INVALID');
    expect((await account(employee,{action:'unlock',businessId:business.business.id,pin:'086420'})).body.error?.code).toBe('PIN_LOCKED');
    expect((await account(employee,{action:'context',businessId:business.business.id,operatorToken:session.operatorToken})).body.error?.code).toBe('SESSION_INVALID');
    const team=(await account<Team>(owner,{action:'team',...args})).body.data!;
    expect(team.invitations.find(i=>i.id===invitation.invitationId)).toMatchObject({status:'accepted',acceptedAt:expect.any(String),revokeReason:'employee_deleted'});
    expect(team.employees.find(e=>e.id===person.id)).toMatchObject({active:true,googleLinked:true,pinReady:true});
  },30_000);

  it('does not revive a pending Google creation operation or its cancelled code after restoration',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);
    const creation={action:'create_employee',...args,name:'Persona Google pendiente',role:'cashier',pin:null,inviteWithGoogle:true,operationId:randomUUID()};
    const person=(await account<Person & {invitation:Invitation}>(owner,creation)).body.data!;
    expect((await account(owner,{action:'delete_employee',...args,employeeId:person.id,operationId:randomUUID()})).status).toBe(200);
    expect((await account(owner,creation)).body.error?.code).toBe('EMPLOYEE_INACTIVE');
    expect((await account(owner,{action:'restore_employee',...args,employeeId:person.id,operationId:randomUUID()})).body.data).toMatchObject({id:person.id,active:true,pinReady:false});
    expect((await account(owner,creation)).body.error?.code).toBe('INVITATION_INVALID');
    expect((await account(employee,{action:'accept_invitation',invitationCode:person.invitation.invitationCode,pin:'086420',operationId:randomUUID()})).body.error?.code).toBe('INVITATION_INVALID');
    const fresh=await invite(args,person.id);
    expect((await account(employee,{action:'accept_invitation',invitationCode:fresh.invitationCode,pin:'086420',operationId:randomUUID()})).status).toBe(200);
    expect(sql(`select count(*) from app_private.employees where business_id=${sqlUuid(business.business.id)} and role<>'owner';`).trim()).toBe('1');
  },30_000);

  it('restricts delete and restore to the owner and the correct employee/business operation',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);const person=await makePerson(args,'Persona protegida');
    const team=(await account<Team>(owner,{action:'team',...args})).body.data!;const ownerPerson=team.employees.find(e=>e.role==='owner')!;
    for(const action of ['delete_employee','restore_employee']){
      expect((await account(owner,{action,...args,employeeId:ownerPerson.id,operationId:randomUUID()})).body.error?.code).toBe('PERMISSION_DENIED');
      const other=await newBusiness(anotherOwner);expect((await account(anotherOwner,{action,...ownerArgs(other),employeeId:person.id,operationId:randomUUID()})).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    }
    const invitation=await invite(args,person.id);const joined=(await account<BusinessSession>(employee,{action:'accept_invitation',invitationCode:invitation.invitationCode,pin:'086420',operationId:randomUUID()})).body.data!;
    for(const action of ['delete_employee','restore_employee'])expect((await account(employee,{action,...ownerArgs(joined),employeeId:person.id,operationId:randomUUID()})).body.error?.code).toBe('PERMISSION_DENIED');
    const operationId=randomUUID();expect((await account(owner,{action:'delete_employee',...args,employeeId:person.id,operationId})).status).toBe(200);
    expect((await account(owner,{action:'restore_employee',...args,employeeId:person.id,operationId})).body.error?.code).toBe('OPERATION_CONFLICT');
    expect((await account(owner,{action:'delete_employee',...args,employeeId:ownerPerson.id,operationId})).body.error?.code).toBe('OPERATION_CONFLICT');
  },30_000);

  it('revokes a personal unlock already waiting on the PIN credential before restoring access',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);const person=await makePerson(args,'Persona desbloqueando');const invitation=await invite(args,person.id);
    expect((await account(employee,{action:'accept_invitation',invitationCode:invitation.invitationCode,pin:'086420',operationId:randomUUID()})).status).toBe(200);
    const locker=await lockPersonalCredential(business.business.id,employee.userId);
    try{
      const unlocking=account<BusinessSession>(employee,{action:'unlock',businessId:business.business.id,pin:'086420'});
      await waitForBlockedRpc(1,locker.pinLockName);
      const deleting=account(owner,{action:'delete_employee',...args,employeeId:person.id,operationId:randomUUID()});
      await waitForBlockedRpc(2,locker.pinLockName);
      const restoring=account(owner,{action:'restore_employee',...args,employeeId:person.id,operationId:randomUUID()});
      locker.stdin.end('commit;\n');
      const [unlocked,removed,restored]=await Promise.all([unlocking,deleting,restoring]);
      expect(unlocked.status).toBe(200);expect(removed.status).toBe(200);expect(restored.status).toBe(200);
      expect((await account(employee,{action:'context',businessId:business.business.id,operatorToken:unlocked.body.data!.operatorToken})).body.error?.code).toBe('SESSION_INVALID');
      expect((await account(employee,{action:'unlock',businessId:business.business.id,pin:'086420'})).status).toBe(200);
    }finally{locker.stdin.end('rollback;\n');}
  },30_000);

  it('serializes register PIN unlock against removal without restoring its operator token',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);const person=await makePerson(args,'Persona caja concurrente');const device=await pairDevice(args);
    await choosePin(person,device.deviceToken);
    const [unlocked,removed]=await Promise.all([
      account<BusinessSession>(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'024680'}),
      account(owner,{action:'delete_employee',...args,employeeId:person.id,operationId:randomUUID()}),
    ]);
    expect(removed.status).toBe(200);expect([200,403]).toContain(unlocked.status);
    expect((await account(owner,{action:'restore_employee',...args,employeeId:person.id,operationId:randomUUID()})).status).toBe(200);
    if(unlocked.body.data)expect((await account(null,{action:'device_context',deviceToken:device.deviceToken,operatorToken:unlocked.body.data.operatorToken})).body.error?.code).toBe('SESSION_INVALID');
    expect((await account(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:person.id,pin:'024680'})).status).toBe(200);
  },30_000);

  it('serializes Google acceptance against deletion and leaves no access after removal',async()=>{
    const business=await newBusiness(owner);const args=ownerArgs(business);const person=await makePerson(args,'Persona concurrente');const invitation=await invite(args,person.id);
    const [removed,accepted]=await Promise.all([
      account(owner,{action:'delete_employee',...args,employeeId:person.id,operationId:randomUUID()}),
      account(employee,{action:'accept_invitation',invitationCode:invitation.invitationCode,pin:'086420',operationId:randomUUID()}),
    ]);
    expect(removed.status).toBe(200);expect([200,400,403]).toContain(accepted.status);
    expect(sql(`select active=false and deleted_at is not null from app_private.employees where id=${sqlUuid(person.id)};`).trim()).toBe('t');
    expect(sql(`select count(*) from app_private.business_memberships where business_id=${sqlUuid(business.business.id)} and user_id=${sqlUuid(employee.userId)} and active;`).trim()).toBe('0');
    expect(sql(`select count(*) from app_private.operator_sessions where business_id=${sqlUuid(business.business.id)} and user_id=${sqlUuid(employee.userId)} and revoked_at is null;`).trim()).toBe('0');
    expect((await account(employee,{action:'unlock',businessId:business.business.id,pin:'086420'})).body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
  },30_000);
});

type Person={id:string;name:string;role:string;active:boolean;deletedAt?:string|null;pinReady?:boolean;googleLinked?:boolean;pinSetup?:{setupCode:string}};
type Team={employees:Person[];deletedEmployees:Person[];invitations:{id:string;employeeId:string;status:string;revokeReason:string|null;acceptedAt:string|null;revokedAt:string|null}[]};
type Invitation={invitationCode:string;invitationId:string;expiresAt:string};
function ownerArgs(business:BusinessSession){return{businessId:business.business.id,operatorToken:business.operatorToken};}
async function makePerson(args:ReturnType<typeof ownerArgs>,name:string){const result=await account<Person>(owner,{action:'create_employee',...args,name,role:'cashier',pin:null,operationId:randomUUID()});expect(result.status).toBe(200);return result.body.data!;}
async function choosePin(person:Person,deviceToken:string){const result=await account<BusinessSession>(null,{action:'device_set_employee_pin',deviceToken,setupCode:person.pinSetup!.setupCode,pin:'024680',operationId:randomUUID()});expect(result.status).toBe(200);return result.body.data!;}
async function invite(args:ReturnType<typeof ownerArgs>,employeeId:string,operationId=randomUUID()){const result=await account<Invitation>(owner,{action:'create_invitation',...args,employeeId,operationId});expect(result.status).toBe(200);return result.body.data!;}
async function pairDevice(args:ReturnType<typeof ownerArgs>){const pairing=(await account<{pairingCode:string}>(owner,{action:'create_pairing_code',...args,operationId:randomUUID()})).body.data!;return (await account<{deviceToken:string}>(null,{action:'device_pair',pairingCode:pairing.pairingCode,deviceName:'Caja lifecycle',operationId:randomUUID()})).body.data!;}

async function lockPersonalCredential(businessId:string,userId:string){
  const pinLockName=`lifecycle_pin_${randomUUID()}`;
  const child=spawn('docker',['exec','-i',config!.dbContainer,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At','-q'],{stdio:['pipe','pipe','pipe']});
  const ready=new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Local credential lock did not become ready.')),5_000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('credential_locked')){clearTimeout(timeout);resolve();}});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('exit',code=>{if(code){clearTimeout(timeout);reject(new Error('Local credential lock exited.'));}});
  });
  child.stdin.write(`set application_name='${pinLockName}';\nbegin;\nselect 1 from app_private.operator_credentials where business_id=${sqlUuid(businessId)} and user_id=${sqlUuid(userId)} for update;\nselect 'credential_locked';\n`);
  await ready;return Object.assign(child,{pinLockName});
}
async function waitForBlockedRpc(expectedCount:number,pinLockName:string){
  const deadline=Date.now()+5_000;
  while(Date.now()<deadline){
    if(Number(sql(`with recursive blocked(pid) as (select pid from pg_stat_activity where application_name='${pinLockName}' union select a.pid from pg_stat_activity a join blocked b on b.pid=any(pg_blocking_pids(a.pid))) select count(*) from blocked join pg_stat_activity using(pid) where wait_event_type='Lock' and query like '%"account_secure"%';`).trim())>=expectedCount)return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('Expected local account request to wait on a lifecycle lock.');
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
    body: JSON.stringify(await signedRequest(identity?.userId, request)),
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
