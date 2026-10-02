// Agente de Larios. Real 0007 -> 0008 compatibility in a separate disposable database.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
const cli = resolve('node_modules/.bin/supabase')
const workdir = process.env.TEST_SUPABASE_WORKDIR
const status = JSON.parse(execFileSync(cli, ['status', ...(workdir ? ['--workdir',workdir] : []), '-o', 'json'], { encoding:'utf8',stdio:['ignore','pipe','pipe'] }))
const connection = new URL(status.DB_URL)
if (![new URL(status.API_URL),connection].every(url=>['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw Error('Loopback stack required')
const project=readFileSync(workdir ? `${workdir}/supabase/config.toml` : 'supabase/config.toml','utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
const container=`supabase_db_${project}`
const database=`pos_device_compat_${randomUUID().replaceAll('-','')}`
const workspace=mkdtempSync(`${tmpdir()}/pos-device-compat-`)
const migrations=['20261001000100_account_foundation.sql','20261001000200_business_team.sql','20261001000300_unified_employee_access.sql','20261001000400_employee_lifecycle.sql','20261001000500_employee_pin_policy.sql','20261001000600_owner_pin_recovery.sql','20261001000700_pin_recovery_email.sql','20261001000800_employee_device_notifications.sql']
connection.pathname=`/${database}`
connection.searchParams.set('sslmode','disable')
let created=false,stage='prepare'
function sql(statement,target=database){return execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d',target,'-v','ON_ERROR_STOP=1','-At','-q'],{input:statement,encoding:'utf8',stdio:['pipe','pipe','pipe']})}
function migrate(){execFileSync(cli,['db','push','--db-url',connection.href,'--skip-vault','--yes','--workdir',workspace],{encoding:'utf8',stdio:['ignore','pipe','pipe']})}
try{
 sql(`create database ${database} template template0;`,'postgres');created=true
 sql(execFileSync('docker',['exec',container,'pg_dump','-U','postgres','-d','postgres','--schema=auth','--schema=extensions','--schema-only','--no-owner','--no-privileges'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
 mkdirSync(`${workspace}/supabase/migrations`,{recursive:true});copyFileSync('supabase/config.toml',`${workspace}/supabase/config.toml`)
 for(const file of migrations.slice(0,7))copyFileSync(`supabase/migrations/${file}`,`${workspace}/supabase/migrations/${file}`)
 stage='baseline';migrate()
 stage='legacy fixture';sql(`create table public.compat_fixture(value jsonb); do $$
 declare u uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); es uuid:=gen_random_uuid(); b jsonb; a jsonb; p jsonb; invitation jsonb; joined jsonb; pair jsonb; device jsonb; legacy jsonb; pending jsonb;
 begin
 insert into auth.users(id,email,email_confirmed_at) values(u,'owner@example.test',now()),(e,'employee@example.test',now());
 insert into auth.sessions(id,user_id,created_at,updated_at) values(s,u,now(),now()),(es,e,now(),now());
 b:=public.account_create_business(u,s,'Café compatible','cafe','America/Mexico_City',gen_random_uuid(),'028462',null);
 a:=jsonb_build_object('businessId',b#>>'{data,business,id}','operatorToken',b#>>'{data,operatorToken}');
 p:=public.account_manage(u,s,'create_employee',a||jsonb_build_object('name','Empleado personal','role','cashier','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
 joined:=public.account_manage(e,es,'accept_invitation',jsonb_build_object('invitationCode',p#>>'{data,invitation,invitationCode}','pin','024680','operationId',gen_random_uuid()));
 legacy:=public.account_manage(u,s,'create_employee',a||jsonb_build_object('name','Empleado de caja','role','cashier','pin',null,'operationId',gen_random_uuid()));
 pair:=public.account_manage(u,s,'create_pairing_code',a||jsonb_build_object('operationId',gen_random_uuid()));
 device:=public.account_device('device_pair',jsonb_build_object('pairingCode',pair#>>'{data,pairingCode}','deviceName','Caja existente','operationId',gen_random_uuid()));
 perform public.account_device('device_set_employee_pin',jsonb_build_object('deviceToken',device#>>'{data,deviceToken}','setupCode',legacy#>>'{data,pinSetup,setupCode}','pin','012345','operationId',gen_random_uuid()));
 pending:=public.account_manage(u,s,'create_employee',a||jsonb_build_object('name','Invitación pendiente','role','kitchen','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
 update app_private.operator_credentials set failed_attempts=2 where user_id=e;
 insert into public.compat_fixture values(jsonb_build_object('owner',u,'ownerSession',s,'employee',e,'employeeSession',es,'ownerArgs',a,'joined',joined,'device',device,'legacy',legacy));
 end $$;`)
 const snapshot=()=>sql(`select jsonb_build_object('credentials',(select jsonb_agg(to_jsonb(c)) from app_private.operator_credentials c),'shared',(select jsonb_agg(to_jsonb(c)) from app_private.shared_employee_credentials c),'employees',(select jsonb_agg(to_jsonb(e)) from app_private.employees e),'invitations',(select jsonb_agg(to_jsonb(i)) from app_private.business_invitations i),'operators',(select jsonb_agg(to_jsonb(o)-'employee_device_key_hash') from app_private.operator_sessions o),'devices',(select jsonb_agg(to_jsonb(d)) from app_private.devices d));`).trim()
 const before=snapshot()
 copyFileSync(`supabase/migrations/${migrations[7]}`,`${workspace}/supabase/migrations/${migrations[7]}`)
 stage='migration';migrate();assert.equal(snapshot(),before,'Migration preserves identities, PIN hashes/counters, invitations and prior sessions')
 stage='permissions';assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'select') or has_table_privilege('authenticated',c.oid,'select'));`).trim(),'0')
 assert.equal(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private') and p.proname like 'account_%' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'));`).trim(),'0')
 assert.equal(sql('select count(*) from app_private.employee_personal_devices;').trim(),'0')
 stage='new policy';sql(`do $$ declare f jsonb; b uuid; r jsonb; n uuid; begin
 select value into f from public.compat_fixture; b:=(f#>>'{ownerArgs,businessId}')::uuid;
 perform public.account_context((f->>'owner')::uuid,(f->>'ownerSession')::uuid,b,f#>>'{ownerArgs,operatorToken}');
 begin perform public.account_context((f->>'employee')::uuid,(f->>'employeeSession')::uuid,b,f#>>'{joined,data,operatorToken}'); raise exception 'Legacy employee operator bypassed device'; exception when raise_exception then if sqlerrm<>'DEVICE_LINK_REQUIRED' then raise; end if; end;
 r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'unlock',jsonb_build_object('businessId',b,'pin','024680'),repeat('a',64),gen_random_uuid());
 if r->'error' is not null then raise exception 'Existing employee could not enroll'; end if;
 r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'unlock',jsonb_build_object('businessId',b,'pin','024680'),repeat('b',64),gen_random_uuid());
 if r#>>'{error,code}'<>'DEVICE_APPROVAL_REQUIRED' then raise exception 'New browser was allowed'; end if;
 select id into n from app_private.owner_notifications where business_id=b and status='pending';
 if n is null then raise exception 'Denied attempt did not persist notification'; end if;
 perform public.account_secure((f->>'owner')::uuid,(f->>'ownerSession')::uuid,'review_employee_device',f->'ownerArgs'||jsonb_build_object('notificationId',n,'decision','approve'));
 if (select encode(key_hash,'hex') from app_private.employee_personal_devices where business_id=b)<>repeat('b',64) then raise exception 'Approval did not replace binding'; end if;
 r:=public.account_device('device_unlock',jsonb_build_object('deviceToken',f#>>'{device,data,deviceToken}','employeeId',f#>>'{legacy,data,id}','pin','012345'));
 if r->'error' is not null then raise exception 'Legacy PIN-only register broke'; end if;
 end $$;`)
 const rows=JSON.parse(sql('select jsonb_agg(row_to_json(m) order by version) from supabase_migrations.schema_migrations m;').trim())
 assert.equal(rows.length,8);assert.deepEqual(rows.slice(0,7).map(r=>r.statements.length),[44,48,27,23,29,21,16])
 writeFileSync('/tmp/pos-employee-device-canonical-ledger.json',JSON.stringify(rows))
 console.log(`PASS real 0007→0008 compatibility: preserved identities/PIN hashes/counters/invitations; owner access retained; linked employees enroll once; other device denied with durable notification; approval swaps key; legacy PIN-only register works; private tables/RPC grants; canonical ledger ${rows.map(r=>r.statements.length).join('/')}.`)
}catch(error){const diagnostic=String(error.stderr??'').split('\n').find(line=>line.startsWith('ERROR:'));console.error(`Device migration smoke failed at ${stage} [status=${error.status}, signal=${error.signal}, code=${error.code}]: ${error instanceof assert.AssertionError ? error.message : diagnostic??(String(error.stderr??'')+String(error.stdout??error.name)).slice(-1600)}`);process.exitCode=1}
finally{if(created)sql(`drop database ${database} with (force);`,'postgres');rmSync(workspace,{recursive:true,force:true})}
