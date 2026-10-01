// Agente de Larios. Disposable local SQL compatibility check; never connects to cloud.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const cli = resolve('node_modules/.bin/supabase')
const status = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const apiUrl = new URL(status.API_URL)
const connection = new URL(status.DB_URL)
if (![apiUrl, connection].every(url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Migration smoke requires the identified loopback stack.')
const projectId = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
if (!projectId) throw new Error('Missing local project id.')
const container = `supabase_db_${projectId}`
const database = `pos_mexico_lifecycle_${randomUUID().replaceAll('-', '')}`
const workspace = mkdtempSync(`${tmpdir()}/pos-mexico-lifecycle-`)
const migrations = ['20261001000100_account_foundation.sql', '20261001000200_business_team.sql', '20261001000300_unified_employee_access.sql', '20261001000400_employee_lifecycle.sql']
connection.pathname = `/${database}`
let created = false
function sql(statement, target = database) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', target, '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}
function migrate() {
  // CLI records its canonical SQL statement array, exactly as for an ordinary deployment.
  execFileSync(cli, ['db', 'push', '--db-url', connection.href, '--skip-vault', '--yes', '--workdir', workspace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
try {
  sql(`create database ${database} template template0;`, 'postgres')
  created = true
  const authSchema = execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema=auth', '--schema=extensions', '--schema-only', '--no-owner', '--no-privileges'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  sql(authSchema)
  mkdirSync(`${workspace}/supabase/migrations`, { recursive: true })
  copyFileSync('supabase/config.toml', `${workspace}/supabase/config.toml`)
  for (const file of migrations.slice(0, 3)) copyFileSync(`supabase/migrations/${file}`, `${workspace}/supabase/migrations/${file}`)
  migrate()
  sql(`
    create table public.compatibility_fixture(kind text primary key,owner_id uuid,owner_session uuid,business_id uuid,operator_token text,employee_id uuid,invitation_id uuid,invitation_code text,accepted_operation uuid);
    do $$
    declare v_owner uuid:=gen_random_uuid(); v_owner_session uuid:=gen_random_uuid(); v_member uuid:=gen_random_uuid(); v_member_session uuid:=gen_random_uuid();
      v_business jsonb; v_args jsonb; v_person jsonb; v_invitation jsonb; v_kind text; v_accept_operation uuid:=gen_random_uuid();
    begin
      insert into auth.users(id) values(v_owner),(v_member);
      insert into auth.sessions(id,user_id,created_at,updated_at) values(v_owner_session,v_owner,now(),now()),(v_member_session,v_member,now(),now());
      v_business:=public.account_create_business(v_owner,v_owner_session,'Negocio compatibilidad','cafe','America/Mexico_City',gen_random_uuid(),'583927',null);
      v_args:=jsonb_build_object('businessId',v_business#>>'{data,business,id}','operatorToken',v_business#>>'{data,operatorToken}');
      foreach v_kind in array array['accepted','revoked','expired','pending'] loop
        v_person:=public.account_manage(v_owner,v_owner_session,'create_employee',v_args||jsonb_build_object('name','Persona '||v_kind,'role','cashier','pin','024680','operationId',gen_random_uuid()));
        v_invitation:=public.account_manage(v_owner,v_owner_session,'create_invitation',v_args||jsonb_build_object('employeeId',v_person#>>'{data,id}','operationId',gen_random_uuid()));
        insert into public.compatibility_fixture values(v_kind,v_owner,v_owner_session,(v_args->>'businessId')::uuid,v_args->>'operatorToken',(v_person#>>'{data,id}')::uuid,(v_invitation#>>'{data,invitationId}')::uuid,v_invitation#>>'{data,invitationCode}',v_accept_operation);
        if v_kind='accepted' then
          perform public.account_manage(v_member,v_member_session,'accept_invitation',jsonb_build_object('invitationCode',v_invitation#>>'{data,invitationCode}','pin','086420','operationId',v_accept_operation));
          -- The old cancellation API allowed this; acceptance must still be reported after migration.
          perform public.account_manage(v_owner,v_owner_session,'revoke_invitation',v_args||jsonb_build_object('invitationId',v_invitation#>>'{data,invitationId}'));
        elsif v_kind='revoked' then
          perform public.account_manage(v_owner,v_owner_session,'revoke_invitation',v_args||jsonb_build_object('invitationId',v_invitation#>>'{data,invitationId}'));
        elsif v_kind='expired' then
          update app_private.business_invitations set expires_at=now()-interval '1 second' where id=(v_invitation#>>'{data,invitationId}')::uuid;
        end if;
      end loop;
    end;
    $$;
  `)
  copyFileSync(`supabase/migrations/${migrations[3]}`, `${workspace}/supabase/migrations/${migrations[3]}`)
  migrate()
  const outcomes = JSON.parse(sql(`
    select jsonb_object_agg(f.kind,jsonb_build_object('status',i->>'status','revokeReason',i->'revokeReason'))
    from public.compatibility_fixture f cross join lateral jsonb_array_elements(public.account_manage(f.owner_id,f.owner_session,'team',jsonb_build_object('businessId',f.business_id,'operatorToken',f.operator_token))#>'{data,invitations}') i
    where i->>'id'=f.invitation_id::text;
  `).trim())
  assert.deepEqual(outcomes, {
    accepted: { status: 'accepted', revokeReason: null },
    revoked: { status: 'revoked', revokeReason: null },
    expired: { status: 'expired', revokeReason: null },
    pending: { status: 'pending', revokeReason: null },
  })
  // An original pending code survives the schema migration and still binds to its original person.
  sql(`
    do $$
    declare v_fixture public.compatibility_fixture%rowtype; v_member uuid:=gen_random_uuid(); v_member_session uuid:=gen_random_uuid(); v_result jsonb;
    begin
      select * into v_fixture from public.compatibility_fixture where kind='pending';
      insert into auth.users(id) values(v_member);
      insert into auth.sessions(id,user_id,created_at,updated_at) values(v_member_session,v_member,now(),now());
      v_result:=public.account_manage(v_member,v_member_session,'accept_invitation',jsonb_build_object('invitationCode',v_fixture.invitation_code,'pin','086420','operationId',gen_random_uuid()));
      if v_result#>>'{data,business,employee,id}'<>v_fixture.employee_id::text then raise exception 'Pending invitation changed its employee target'; end if;
      if (select count(*) from app_private.employees where business_id=v_fixture.business_id)<>5 then raise exception 'Migration duplicated employee records'; end if;
      perform public.account_manage(v_fixture.owner_id,v_fixture.owner_session,'delete_employee',jsonb_build_object('businessId',v_fixture.business_id,'operatorToken',v_fixture.operator_token,'employeeId',v_fixture.employee_id,'operationId',gen_random_uuid()));
      perform public.account_manage(v_fixture.owner_id,v_fixture.owner_session,'restore_employee',jsonb_build_object('businessId',v_fixture.business_id,'operatorToken',v_fixture.operator_token,'employeeId',v_fixture.employee_id,'operationId',gen_random_uuid()));
      select * into v_fixture from public.compatibility_fixture where kind='expired';
      perform public.account_manage(v_fixture.owner_id,v_fixture.owner_session,'delete_employee',jsonb_build_object('businessId',v_fixture.business_id,'operatorToken',v_fixture.operator_token,'employeeId',v_fixture.employee_id,'operationId',gen_random_uuid()));
      if (select app_private.invitation_status(i,e) from app_private.business_invitations i join app_private.employees e on e.id=i.employee_id where i.id=v_fixture.invitation_id)<>'expired' then raise exception 'Removal overwrote prior expiry'; end if;
    end;
    $$;
  `)
  const canonical = JSON.parse(sql("select row_to_json(m) from supabase_migrations.schema_migrations m where version='20261001000400';").trim())
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  writeFileSync('/tmp/pos-mexico-employee-lifecycle-canonical-history.sql', `update supabase_migrations.schema_migrations set name=${quote(canonical.name)},statements=array[${canonical.statements.map(quote).join(',')}]::text[] where version=${quote(canonical.version)};\n`)
  const history = sql('select version,name,cardinality(statements) from supabase_migrations.schema_migrations order by version;').trim().split('\n')
  assert.deepEqual(history, [
    '20261001000100|account_foundation|44',
    '20261001000200|business_team|48',
    '20261001000300|unified_employee_access|27',
    '20261001000400|employee_lifecycle|23',
  ])
  console.log('PASS: real local 0003→0004 migration, truthful historical outcomes, pending code/target compatibility, removal/restoration, and canonical ledger 44/48/27/23.')
} catch (error) {
  // Never print connection arguments, operation tokens or fixture SQL.
  console.error(`Migration compatibility failed: ${error instanceof assert.AssertionError ? error.message : error.name ?? 'Error'}`)
  process.exitCode = 1
} finally {
  if (created) sql(`drop database ${database} with (force);`, 'postgres')
  rmSync(workspace, { recursive: true, force: true })
}
