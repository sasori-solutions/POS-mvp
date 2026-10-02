// Agente de Larios. Real 0004 -> 0005/0006 compatibility in a disposable loopback database.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const cli = resolve('node_modules/.bin/supabase')
const status = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const connection = new URL(status.DB_URL)
if (![new URL(status.API_URL), connection].every(url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Loopback stack required')
const project = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
if (!project) throw new Error('Missing local project id')
const container = `supabase_db_${project}`
const database = `pos_email_compat_${randomUUID().replaceAll('-', '')}`
const workspace = mkdtempSync(`${tmpdir()}/pos-email-compat-`)
const migrations = ['20261001000100_account_foundation.sql', '20261001000200_business_team.sql', '20261001000300_unified_employee_access.sql', '20261001000400_employee_lifecycle.sql', '20261001000500_employee_pin_policy.sql', '20261001000600_owner_pin_recovery.sql', '20261001000700_pin_recovery_email.sql']
connection.pathname = `/${database}`
let created = false
let stage = 'prepare'
function sql(statement, target = database) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', target, '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}
function migrate() {
  execFileSync(cli, ['db', 'push', '--db-url', connection.href, '--skip-vault', '--yes', '--workdir', workspace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
try {
  sql(`create database ${database} template template0;`, 'postgres'); created = true
  sql(execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema=auth', '--schema=extensions', '--schema-only', '--no-owner', '--no-privileges'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }))
  mkdirSync(`${workspace}/supabase/migrations`, { recursive: true }); copyFileSync('supabase/config.toml', `${workspace}/supabase/config.toml`)
  for (const file of migrations.slice(0,6)) copyFileSync(`supabase/migrations/${file}`, `${workspace}/supabase/migrations/${file}`)
  stage='baseline'; migrate()
  stage='legacy fixture'
  sql(`do $$ declare u uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); b jsonb; a jsonb; begin
    insert into auth.users(id,email,email_confirmed_at) values(u,'compat@example.test',now());
    insert into auth.sessions(id,user_id,created_at,updated_at) values(s,u,now(),now());
    b:=public.account_create_business(u,s,'Café de compatibilidad','cafe','America/Mexico_City',gen_random_uuid(),'028462',null);
    a:=jsonb_build_object('businessId',b#>>'{data,business,id}','operatorToken',b#>>'{data,operatorToken}');
    perform public.account_manage(u,s,'create_recovery_code',a||jsonb_build_object('currentPin','028462','operationId',gen_random_uuid()));
    perform public.account_manage(u,s,'create_employee',a||jsonb_build_object('name','Empleado pendiente','role','cashier','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
    update app_private.operator_credentials set failed_attempts=3;
  end $$;`)
  const snapshot = () => sql(`select jsonb_build_object('credentials',(select jsonb_agg(to_jsonb(c)) from app_private.operator_credentials c),'employees',(select jsonb_agg(to_jsonb(e)) from app_private.employees e),'invitations',(select jsonb_agg(to_jsonb(i)) from app_private.business_invitations i),'operators',(select jsonb_agg(to_jsonb(o)) from app_private.operator_sessions o),'recovery',(select jsonb_agg(to_jsonb(r)) from app_private.owner_pin_recovery_credentials r));`).trim()
  const before=snapshot()
  copyFileSync('supabase/migrations/'+migrations[6],`${workspace}/supabase/migrations/${migrations[6]}`)
  stage='new migration'; migrate()
  assert.equal(snapshot(),before,'Migration must preserve all previous identities, PIN hashes, counters, invitations and sessions')
  stage='new permissions'
  assert.equal(sql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and (not c.relrowsecurity or has_table_privilege('anon',c.oid,'select') or has_table_privilege('authenticated',c.oid,'select'));`).trim(),'0')
  assert.equal(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private') and p.proname like 'account_%' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'));`).trim(),'0')
  sql(`do $$ declare u uuid; s uuid; b uuid; r jsonb; begin
    select user_id,id into u,s from auth.sessions limit 1; select business_id into b from app_private.operator_credentials limit 1;
    begin perform public.account_manage(u,s,'reset_pin','{}'); raise exception 'Legacy reset remained available'; exception when raise_exception then if sqlerrm<>'RECOVERY_UNAVAILABLE' then raise; end if; end;
    r:=public.account_request_pin_email(u,s,b);
    if length(r#>>'{data,token}')<>64 then raise exception 'Missing scoped link'; end if;
    if (select failed_attempts from app_private.operator_credentials where business_id=b and user_id=u)<>3 then raise exception 'Request reset counter'; end if;
  end $$;`)
  const rows=JSON.parse(sql("select jsonb_agg(row_to_json(m) order by version) from supabase_migrations.schema_migrations m;").trim())
  assert.equal(rows.length,7); assert.deepEqual(rows.slice(0,6).map(r=>r.statements.length),[44,48,27,23,29,21])
  writeFileSync('/tmp/pos-pin-email-canonical-ledger.json',JSON.stringify(rows))
  console.log(`PASS real 0006→0007 compatibility: preserves identities, hashes/counters, invitations, prior sessions; rejects legacy reset; scoped mail request; private tables and RPC grants; canonical ledger ${rows.map(r=>r.statements.length).join('/')}.`)
} catch(error) {
  const diagnostic=String(error.stderr??'').split('\n').find(line=>line.startsWith('ERROR:'))
  console.error(`Email migration smoke failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : diagnostic??error.name}`); process.exitCode=1
} finally { if(created) sql(`drop database ${database} with (force);`,'postgres'); rmSync(workspace,{recursive:true,force:true}) }
