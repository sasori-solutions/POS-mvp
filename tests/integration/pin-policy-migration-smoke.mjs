// Agente de Larios. Real 0004 -> 0005/0006 compatibility in a disposable loopback database.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
const database = `pos_pin_compat_${randomUUID().replaceAll('-', '')}`
const workspace = mkdtempSync(`${tmpdir()}/pos-pin-compat-`)
const migrations = ['20261001000100_account_foundation.sql', '20261001000200_business_team.sql', '20261001000300_unified_employee_access.sql', '20261001000400_employee_lifecycle.sql', '20261001000500_employee_pin_policy.sql', '20261001000600_owner_pin_recovery.sql']
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
  sql(`create database ${database} template template0;`, 'postgres')
  created = true
  sql(execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema=auth', '--schema=extensions', '--schema-only', '--no-owner', '--no-privileges'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  mkdirSync(`${workspace}/supabase/migrations`, { recursive: true })
  copyFileSync('supabase/config.toml', `${workspace}/supabase/config.toml`)
  for (const file of migrations.slice(0, 4)) copyFileSync(`supabase/migrations/${file}`, `${workspace}/supabase/migrations/${file}`)
  stage = 'baseline migration'
  migrate()
  stage = 'historical fixture'
  sql(`
    create table public.pin_fixture(owner_id uuid,owner_session uuid,member_id uuid,member_session uuid,business_id uuid,operator_token text,shared_id uuid,linked_id uuid,pending_id uuid,invitation_code text,shared_hash text,linked_hash text,owner_hash text,invitation_id uuid);
    do $$
    declare o uuid:=gen_random_uuid(); os uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); ms uuid:=gen_random_uuid(); b jsonb; args jsonb; s jsonb; l jsonb; p jsonb; invitation jsonb;
    begin
      insert into auth.users(id) values(o),(m);
      insert into auth.sessions(id,user_id,created_at,updated_at) values(os,o,now(),now()),(ms,m,now(),now());
      b:=public.account_create_business(o,os,'Café sintético histórico','cafe','America/Mexico_City',gen_random_uuid(),'028462',null);
      args:=jsonb_build_object('businessId',b#>>'{data,business,id}','operatorToken',b#>>'{data,operatorToken}');
      s:=public.account_manage(o,os,'create_employee',args||jsonb_build_object('name','Persona caja histórica','role','cashier','pin','024680','operationId',gen_random_uuid()));
      l:=public.account_manage(o,os,'create_employee',args||jsonb_build_object('name','Persona Google histórica','role','manager','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
      perform public.account_manage(m,ms,'accept_invitation',jsonb_build_object('invitationCode',l#>>'{data,invitation,invitationCode}','pin','086420','operationId',gen_random_uuid()));
      p:=public.account_manage(o,os,'create_employee',args||jsonb_build_object('name','Persona pendiente histórica','role','cashier','pin','002468','operationId',gen_random_uuid()));
      invitation:=public.account_manage(o,os,'create_invitation',args||jsonb_build_object('employeeId',p#>>'{data,id}','operationId',gen_random_uuid()));
      update app_private.shared_employee_credentials set failed_attempts=2 where employee_id=(s#>>'{data,id}')::uuid;
      update app_private.operator_credentials set failed_attempts=3 where user_id=m;
      insert into public.pin_fixture select o,os,m,ms,(args->>'businessId')::uuid,args->>'operatorToken',(s#>>'{data,id}')::uuid,(l#>>'{data,id}')::uuid,(p#>>'{data,id}')::uuid,invitation#>>'{data,invitationCode}',sc.pin_hash,mc.pin_hash,oc.pin_hash,(invitation#>>'{data,invitationId}')::uuid
        from app_private.shared_employee_credentials sc,app_private.operator_credentials mc,app_private.operator_credentials oc
        where sc.employee_id=(s#>>'{data,id}')::uuid and mc.user_id=m and oc.user_id=o;
    end $$;
  `)
  for (const file of migrations.slice(4)) copyFileSync(`supabase/migrations/${file}`, `${workspace}/supabase/migrations/${file}`)
  stage = 'new migrations'
  migrate()
  stage = 'preservation and access checks'
  sql(`
    do $$
    declare f public.pin_fixture%rowtype; status jsonb; n uuid:=gen_random_uuid(); ns uuid:=gen_random_uuid(); result jsonb;
    begin
      select * into strict f from public.pin_fixture;
      if (select pin_hash<>f.shared_hash or failed_attempts<>2 from app_private.shared_employee_credentials where employee_id=f.shared_id) then raise exception 'Shared PIN or counter changed'; end if;
      if (select pin_hash<>f.linked_hash or failed_attempts<>3 from app_private.operator_credentials where user_id=f.member_id and business_id=f.business_id) then raise exception 'Linked PIN or counter changed'; end if;
      if (select pin_hash<>f.owner_hash from app_private.operator_credentials where user_id=f.owner_id and business_id=f.business_id) then raise exception 'Owner PIN changed'; end if;
      if (select count(*) from app_private.employees where business_id=f.business_id)<>4 then raise exception 'Migration duplicated or lost a person'; end if;
      if not exists(select 1 from app_private.business_invitations where id=f.invitation_id and token_hash=extensions.digest(f.invitation_code,'sha256') and accepted_by is null and revoked_at is null) then raise exception 'Pending code changed'; end if;
      status:=public.account_status(f.owner_id,f.owner_session);
      if status#>>'{data,businesses,0,canRecoverPin}'<>'true' or status#>>'{data,businesses,0,recoveryReady}'<>'false' then raise exception 'Existing owner incorrectly enrolled'; end if;
      status:=public.account_status(f.member_id,f.member_session);
      if status#>>'{data,businesses,0,canRecoverPin}'<>'false' then raise exception 'Employee granted owner recovery'; end if;
      insert into auth.users(id) values(n); insert into auth.sessions(id,user_id,created_at,updated_at) values(ns,n,now(),now());
      result:=public.account_manage(n,ns,'accept_invitation',jsonb_build_object('invitationCode',f.invitation_code,'pin','864202','operationId',gen_random_uuid()));
      if result#>>'{error,code}'<>'PIN_INVALID' then raise exception 'Existing PIN was overwritten on linking'; end if;
      result:=public.account_manage(n,ns,'accept_invitation',jsonb_build_object('invitationCode',f.invitation_code,'pin','002468','operationId',gen_random_uuid()));
      if result#>>'{data,business,employee,id}'<>f.pending_id::text then raise exception 'Pending invitation changed identity'; end if;
      if not exists(select 1 from app_private.operator_credentials where user_id=n and business_id=f.business_id and pin_hash=extensions.crypt('002468',pin_hash) and failed_attempts=1) then raise exception 'Link did not preserve PIN/counter'; end if;
      if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private') and p.proname like 'account_%' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))) then raise exception 'Browser has direct account RPC access'; end if;
    end $$;
  `)
  const rows = JSON.parse(sql("select jsonb_agg(row_to_json(m) order by version) from supabase_migrations.schema_migrations m;").trim())
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.slice(0, 4).map(row => row.statements.length), [44, 48, 27, 23])
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  for (const row of rows.slice(4)) writeFileSync(`/tmp/pos-mexico-${row.version}-canonical-history.sql`, `insert into supabase_migrations.schema_migrations(version,name,statements) values(${quote(row.version)},${quote(row.name)},array[${row.statements.map(quote).join(',')}]::text[]);\n`)
  writeFileSync('/tmp/pos-mexico-pin-canonical-history.json', JSON.stringify(rows.map(row => ({ version: row.version, name: row.name, count: row.statements.length, hash: createHash('sha256').update(row.statements.join('\n')).digest('hex') })), null, 2))
  console.log(`PASS: real 0004→0005/0006 migration preserves people, hashes, counters and pending invitation; linking verifies existing PIN; legacy owners remain unenrolled; browser RPC denied; canonical ledger ${rows.map(row => row.statements.length).join('/')}.`)
} catch (error) {
  const diagnostic = String(error.stderr ?? '').split('\n').find(line => line.startsWith('ERROR:'))?.replace(/DETAIL:.*/, '')
  console.error(`PIN migration compatibility failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : diagnostic ?? error.name ?? 'Error'}`)
  process.exitCode = 1
} finally {
  if (created) sql(`drop database ${database} with (force);`, 'postgres')
  rmSync(workspace, { recursive: true, force: true })
}
