// Agente de Larios. Real 0009→0010 purge/reinvite compatibility in disposable DBs.
// Does not reset, migrate or mutate the running stack's primary database.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const cli = resolve('node_modules/.bin/supabase')
const workdir = process.env.TEST_SUPABASE_WORKDIR
const status = JSON.parse(execFileSync(cli, ['status', ...(workdir ? ['--workdir', workdir] : []), '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const connection = new URL(status.DB_URL)
if (![new URL(status.API_URL), connection].every(url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Loopback stack required')
const project = readFileSync(workdir ? `${workdir}/supabase/config.toml` : 'supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
assert(project, 'Local stack project required')
const container = `supabase_db_${project}`
const database = `pos_unlink_compat_${randomUUID().replaceAll('-', '')}`
const releaseDatabase = `pos_unlink_release_${randomUUID().replaceAll('-', '')}`
const workspace = mkdtempSync(`${tmpdir()}/pos-unlink-compat-`)
const migrations = readdirSync('supabase/migrations').filter(file => /^\d{14}_.+\.sql$/.test(file)).sort()
assert.equal(migrations.length, 10)
assert.equal(migrations.at(-1), '20261002001000_employee_permanent_unlink.sql')
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = migrations.map(file => ({ path: `supabase/migrations/${file}`, sha256: hash(readFileSync(`supabase/migrations/${file}`)) }))
connection.pathname = `/${database}`
connection.searchParams.set('sslmode', 'disable')
let created = false
let releaseCreated = false
let stage = 'prepare'

function sql(statement, target = database) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', target, '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 })
}
function migrate() {
  execFileSync(cli, ['db', 'push', '--db-url', connection.href, '--skip-vault', '--yes', '--workdir', workspace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function preserved(target = database) {
  // Full snapshots stay only in process memory and the disposable database.
  return sql(`select jsonb_build_object(
    'authUsers',(select jsonb_agg(to_jsonb(x) order by id) from auth.users x),
    'authSessions',(select jsonb_agg(to_jsonb(x) order by id) from auth.sessions x),
    'businesses',(select jsonb_agg(to_jsonb(x) order by id) from app_private.businesses x),
    'devices',(select jsonb_agg(to_jsonb(x) order by id) from app_private.devices x),
    'pairing',(select jsonb_agg(to_jsonb(x) order by id) from app_private.device_pairing_codes x),
    'employees',(select jsonb_agg(to_jsonb(x)-'merged_into_employee_id' order by id) from app_private.employees x where deleted_at is null or role='owner'),
    'memberships',(select jsonb_agg(to_jsonb(x) order by business_id,user_id) from app_private.business_memberships x where role='owner'),
    'credentials',(select jsonb_agg(to_jsonb(x) order by business_id,user_id) from app_private.operator_credentials x join app_private.business_memberships m using(business_id,user_id) where m.role='owner'),
    'operators',(select jsonb_agg(to_jsonb(x) order by x.id) from app_private.operator_sessions x join app_private.business_memberships m using(business_id,user_id) where m.role='owner'),
    'proofs',(select jsonb_agg(to_jsonb(x) order by key_hash,nonce) from app_private.employee_device_proofs x));`, target).trim()
}
function fullSnapshot(target) {
  const tables = JSON.parse(sql(`select jsonb_agg(tablename order by tablename) from pg_tables where schemaname='app_private';`, target))
  return Object.fromEntries(tables.map(table => [table, sql(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb) from app_private.${table} x;`, target).trim()]))
}
function assertClean(target = database) {
  const result = JSON.parse(sql(`select jsonb_build_object(
    'oldEmployees',(select count(*) from app_private.employees e where e.id in(select (jsonb_array_elements_text(value->'purgedIds'))::uuid from public.compat_fixture)),
    'oldMemberships',(select count(*) from app_private.business_memberships where business_id=(select (value->>'business')::uuid from public.compat_fixture) and user_id=(select (value->>'employee')::uuid from public.compat_fixture)),
    'oldPersonalPins',(select count(*) from app_private.operator_credentials where business_id=(select (value->>'business')::uuid from public.compat_fixture) and user_id=(select (value->>'employee')::uuid from public.compat_fixture)),
    'oldPersonalSessions',(select count(*) from app_private.operator_sessions where business_id=(select (value->>'business')::uuid from public.compat_fixture) and user_id=(select (value->>'employee')::uuid from public.compat_fixture)),
    'oldRecovery',(select count(*) from app_private.pin_email_recoveries where business_id=(select (value->>'business')::uuid from public.compat_fixture) and user_id=(select (value->>'employee')::uuid from public.compat_fixture)),
    'oldPinOperations',(select count(*) from app_private.pin_security_operations where business_id=(select (value->>'business')::uuid from public.compat_fixture) and user_id=(select (value->>'employee')::uuid from public.compat_fixture)),
    'oldAuditAssociations',(select count(*) from app_private.account_audit_events where business_id=(select (value->>'business')::uuid from public.compat_fixture) and user_id=(select (value->>'employee')::uuid from public.compat_fixture)),
    'oldPinAuditAssociations',(select count(*) from app_private.pin_security_audit_events where business_id=(select (value->>'business')::uuid from public.compat_fixture) and user_id=(select (value->>'employee')::uuid from public.compat_fixture)),
    'oldEmployeeChildren',(select count(*) from (
      select employee_id from app_private.shared_employee_credentials union all select employee_id from app_private.device_operator_sessions union all
      select employee_id from app_private.employee_pin_setup_codes union all select employee_id from app_private.business_invitations union all
      select employee_id from app_private.employee_personal_devices union all select employee_id from app_private.owner_notifications union all
      select employee_id from app_private.employee_create_operations
    ) x where employee_id in(select (jsonb_array_elements_text(value->'purgedIds'))::uuid from public.compat_fixture))
  );`, target))
  for (const [key, value] of Object.entries(result)) assert.equal(value, 0, key)
}

try {
  sql(`create database ${database} template template0;`, 'postgres')
  created = true
  sql(execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema=auth', '--schema=extensions', '--schema-only', '--no-owner', '--no-privileges'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  mkdirSync(`${workspace}/supabase/migrations`, { recursive: true })
  copyFileSync('supabase/config.toml', `${workspace}/supabase/config.toml`)
  for (const file of migrations.slice(0, -1)) copyFileSync(`supabase/migrations/${file}`, `${workspace}/supabase/migrations/${file}`)
  stage = 'baseline'
  migrate()
  stage = '0009 archived, merged, legacy and cross-business fixtures'
  sql(`create table public.compat_fixture(value jsonb); do $$
  declare u uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); es uuid:=gen_random_uuid();
    legacy uuid:=gen_random_uuid(); disabled uuid:=gen_random_uuid(); device uuid:=gen_random_uuid(); b jsonb; a jsonb; p jsonb; joined jsonb; rejoined jsonb; fresh jsonb; second jsonb;
    create_request jsonb; old_request jsonb; rejoin_request jsonb; recovery jsonb; rehire jsonb; bid uuid; eid uuid; hash text;
  begin
    insert into auth.users(id,email,email_confirmed_at) values(u,'owner-unlink-compat@example.test',now()),(e,'employee-unlink-compat@example.test',now());
    insert into auth.sessions(id,user_id,created_at,updated_at) values(s,u,now(),now()),(es,e,now(),now());
    b:=public.account_secure(u,s,'create_business',jsonb_build_object('name','Café a conservar','businessType','cafe','timezone','America/Mexico_City','operationId',gen_random_uuid(),'pin','028462'));
    bid:=(b#>>'{data,business,id}')::uuid;
    a:=jsonb_build_object('businessId',bid,'operatorToken',b#>>'{data,operatorToken}');
    create_request:=a||jsonb_build_object('name','Empleado anterior','role','cashier','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid());
    p:=public.account_secure(u,s,'create_employee',create_request); eid:=(p#>>'{data,id}')::uuid;
    old_request:=jsonb_build_object('invitationCode',p#>>'{data,invitation,invitationCode}','pin','024680','operationId',gen_random_uuid());
    joined:=public.account_secure(e,es,'accept_invitation',old_request,repeat('a',64),gen_random_uuid());
    if joined->'error' is not null then raise exception 'Baseline employee acceptance failed'; end if;
    recovery:=public.account_request_pin_email(e,es,bid);
    perform public.account_pin_email_delivery((recovery#>>'{data,id}')::uuid,true);
    select pin_hash into hash from app_private.operator_credentials where business_id=bid and user_id=e;
    insert into app_private.pin_security_operations(user_id,operation_id,business_id,action,payload_fingerprint,prior_pin_hash,result_pin_hash)
      values(e,gen_random_uuid(),bid,'change_pin',extensions.digest('fixture','sha256'),hash,hash);
    insert into app_private.pin_security_audit_events(business_id,user_id,auth_session_id,event) values(bid,e,es,'pin_changed');
    -- Same Google account owns another business: every association must survive.
    second:=public.account_secure(e,es,'create_business',jsonb_build_object('name','Otro negocio intacto','businessType','cafe','timezone','America/Mexico_City','operationId',gen_random_uuid(),'pin','135791'));
    if second->'error' is not null then raise exception 'Baseline second business failed'; end if;
    perform public.account_secure(u,s,'delete_employee',a||jsonb_build_object('employeeId',eid,'operationId',gen_random_uuid()));
    rehire:=public.account_secure(u,s,'create_employee',a||jsonb_build_object('name','Empleado reincorporado','role','manager','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
    rejoin_request:=jsonb_build_object('invitationCode',rehire#>>'{data,invitation,invitationCode}','pin','024680','operationId',gen_random_uuid());
    rejoined:=public.account_secure(e,es,'accept_invitation',rejoin_request,repeat('a',64),gen_random_uuid());
    if rejoined->'error' is not null then raise exception 'Baseline rejoin failed'; end if;
    perform public.account_secure(u,s,'delete_employee',a||jsonb_build_object('employeeId',eid,'operationId',gen_random_uuid()));
    -- Deleted PIN-only data and a merely disabled employee test purge scope.
    insert into app_private.employees(id,business_id,name,role,active,deleted_at) values(legacy,bid,'Empleado legacy','cashier',false,clock_timestamp()),(disabled,bid,'Empleado deshabilitado','kitchen',false,null);
    insert into app_private.shared_employee_credentials(business_id,employee_id,pin_hash) values(bid,legacy,extensions.crypt('042680',extensions.gen_salt('bf',12)));
    insert into app_private.devices(id,business_id,name,register_name,token_hash) values(device,bid,'Caja compartida','Caja 1',extensions.digest('synthetic register','sha256'));
    insert into app_private.device_operator_sessions(business_id,device_id,employee_id,token_hash) values(bid,device,legacy,extensions.digest('synthetic old operator','sha256'));
    insert into app_private.employee_pin_setup_codes(business_id,employee_id,created_by,operation_id,purpose,token_hash,expires_at) values(bid,legacy,u,gen_random_uuid(),'reset',extensions.digest('synthetic setup','sha256'),clock_timestamp()+interval '15 minutes');
    fresh:=public.account_secure(u,s,'create_employee',a||jsonb_build_object('name','Empleado nuevo','role','cashier','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
    insert into public.compat_fixture values(jsonb_build_object('owner',u,'ownerSession',s,'employee',e,'employeeSession',es,'business',bid,'ownerArgs',a,
      'oldPerson',p,'oldCreate',create_request,'oldRequest',old_request,'rejoinRequest',rejoin_request,'oldOperator',rejoined#>>'{data,operatorToken}',
      'recovery',recovery,'freshPerson',fresh,'secondBusiness',second,'purgedIds',jsonb_build_array(eid,rehire#>>'{data,id}',legacy)));
  end $$;`)
  const before = preserved()
  const completeBefore = fullSnapshot(database)
  const preflight = JSON.parse(sql(readFileSync('scripts/employee-unlink-purge-preflight.sql', 'utf8')))
  assert.equal(preflight.employees_to_remove, 3)
  assert.equal(preflight.linked_employees_to_remove, 1)
  assert.equal(preflight.retired_placeholders_to_remove, 1)
  assert.equal(preflight.unexpected_owner_memberships, 0)
  assert.equal(preflight.other_business_memberships_preserved, 1)
  assert.equal(preflight.global_auth_accounts_preserved, 1)
  assert.equal(preflight.personal_device_bindings_to_remove, 1)
  assert.equal(preflight.email_recoveries_to_remove, 1)
  sql(`create database ${releaseDatabase} template ${database};`, 'postgres')
  releaseCreated = true
  copyFileSync(`supabase/migrations/${migrations.at(-1)}`, `${workspace}/supabase/migrations/${migrations.at(-1)}`)
  stage = 'migration purge and scope preservation'
  migrate()
  assert.equal(hash(preserved()), hash(before), 'Auth identities/sessions, other-business access, active/disabled employees, shared registers and nonce replay records must survive unchanged')
  assertClean()

  stage = 'canonical schema and release artifacts'
  const ledger = JSON.parse(sql('select jsonb_agg(row_to_json(m) order by version) from supabase_migrations.schema_migrations m;'))
  assert.equal(ledger.length, 10)
  assert.deepEqual(ledger.slice(0, -1).map(entry => entry.statements.length), [44, 48, 27, 23, 29, 21, 16, 26, 11])
  const schema = JSON.parse(sql(`select jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('signature',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')','sourceSha256',encode(extensions.digest(p.prosrc,'sha256'),'hex'),'securityDefiner',p.prosecdef) order by n.nspname,p.proname,p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' or n.nspname='public' and p.proname like 'account_%'),
    'tables',(select jsonb_agg(n.nspname||'.'||c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r'),
    'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='app_private'),
    'columns',(select jsonb_agg(jsonb_build_object('table',c.oid::regclass::text,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by c.oid::regclass::text,a.attnum) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='app_private' and c.relkind='r' and a.attnum>0 and not a.attisdropped),
    'triggers',(select jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled::text) order by t.tgrelid::regclass::text,t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and not t.tgisinternal));`))
  for (const source of sources) assert.equal(hash(readFileSync(source.path)), source.sha256, 'Migration source changed while smoke ran; rerun to avoid stale artifacts')
  const evidence = { sources, ledgerSha256: hash(JSON.stringify(ledger)), ...schema }
  writeFileSync('/tmp/pos-employee-unlink-canonical-ledger.json', JSON.stringify(ledger))
  writeFileSync('/tmp/pos-employee-unlink-schema-manifest.json', `${JSON.stringify(evidence, null, 2)}\n`)
  execFileSync(process.execPath, ['scripts/prepare-employee-unlink-release.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const verified = JSON.parse(sql(readFileSync('/tmp/pos-employee-unlink-verify.sql', 'utf8')))
  for (const [key, value] of Object.entries(verified)) if (key.endsWith('_failures') || key === 'unexpected_functions' || key === 'browser_callable_functions') assert.deepEqual(value, [], key)
  assert.equal(verified.remaining_deleted_nonowners, 0)
  assert.equal(verified.private_policy_count, 0)
  assert.equal(verified.actual_function_count, schema.functions.length)
  assert.equal(verified.private_tables_count, schema.tables.length)
  writeFileSync('/tmp/pos-employee-unlink-local-verification.json', `${JSON.stringify(verified, null, 2)}\n`)

  stage = 'exact history guard and dashboard artifact'
  sql("update supabase_migrations.schema_migrations set name=name||'_guard_probe' where version='20261002000900';", releaseDatabase)
  const guarded = readFileSync('/tmp/pos-employee-unlink-migration-with-history.sql', 'utf8')
  let rejected = false
  try { sql(guarded, releaseDatabase) } catch (error) { rejected = String(error.stderr).includes('Expected exact 0001-0009 ledger; no changes applied.') }
  assert.equal(rejected, true, 'Ledger mismatch must reject the complete release transaction')
  assert.equal(sql("select count(*) from pg_tables where schemaname='app_private' and tablename='employee_operation_tombstones';", releaseDatabase).trim(), '0')
  assert.equal(hash(JSON.stringify(fullSnapshot(releaseDatabase))), hash(JSON.stringify(completeBefore)), 'Rejected release must not change any private data')
  sql("update supabase_migrations.schema_migrations set name='employee_reinvitation' where version='20261002000900';", releaseDatabase)
  sql(guarded, releaseDatabase)
  assert.equal(hash(preserved(releaseDatabase)), hash(before), 'Guarded dashboard SQL preserves unaffected data')
  assertClean(releaseDatabase)
  assert.deepEqual(JSON.parse(sql(readFileSync('/tmp/pos-employee-unlink-verify.sql', 'utf8'), releaseDatabase)), verified, 'Dashboard and CLI schema/permissions/history must match exactly')

  stage = 'fresh reinvite and stale authorization denial'
  sql(`create function public.compat_secure_denial(u uuid,s uuid,a text,p jsonb,k text default null) returns text language plpgsql as $$
  declare r jsonb; begin
    r:=public.account_secure(u,s,a,p,k,case when k is not null then gen_random_uuid() end);
    return coalesce(r#>>'{error,code}','UNEXPECTED_SUCCESS');
  exception when raise_exception then return sqlerrm; end $$;
  do $$ declare f jsonb; r jsonb; request jsonb; fresh_id uuid; denial text; begin
    select value into f from public.compat_fixture; fresh_id:=(f#>>'{freshPerson,data,id}')::uuid;
    if public.compat_secure_denial((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'accept_invitation',f->'oldRequest',repeat('a',64))<>'INVITATION_INVALID' then raise exception 'Old accepted invitation survived purge'; end if;
    if public.compat_secure_denial((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'accept_invitation',f->'rejoinRequest',repeat('a',64))<>'INVITATION_INVALID' then raise exception 'Old rejoin invitation survived purge'; end if;
    denial:=public.compat_secure_denial((f->>'owner')::uuid,(f->>'ownerSession')::uuid,'create_employee',f->'oldCreate');
    if denial='UNEXPECTED_SUCCESS' then raise exception 'Old create operation recreated deleted person'; end if;
    denial:=public.compat_secure_denial((f->>'owner')::uuid,(f->>'ownerSession')::uuid,'restore_employee',f->'ownerArgs'||jsonb_build_object('employeeId',f#>>'{oldPerson,data,id}','operationId',gen_random_uuid()));
    if denial<>'VALIDATION_ERROR' then raise exception 'Restore API remains available'; end if;
    r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'invitation_details',jsonb_build_object('invitationCode',f#>>'{freshPerson,data,invitation,invitationCode}'),repeat('b',64),gen_random_uuid());
    if r#>>'{data,employee,pinReady}' is distinct from 'false' or coalesce(r#>>'{data,returningEmployee}','false')<>'false' then raise exception 'Fresh invitation retained old PIN semantics'; end if;
    request:=jsonb_build_object('invitationCode',f#>>'{freshPerson,data,invitation,invitationCode}','pin','086420','operationId',gen_random_uuid());
    r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'accept_invitation',request,repeat('b',64),gen_random_uuid());
    if r->'error' is not null or r#>>'{data,business,employee,id}' is distinct from fresh_id::text then raise exception 'Fresh invitation did not create fresh access'; end if;
    if (select key_hash from app_private.employee_personal_devices where employee_id=fresh_id) is distinct from decode(repeat('b',64),'hex') then raise exception 'Fresh device was not independently linked'; end if;
    denial:=public.compat_secure_denial((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'unlock',jsonb_build_object('businessId',f->>'business','pin','024680'),repeat('b',64));
    if denial<>'PIN_INVALID' then raise exception 'Old PIN remains usable'; end if;
    r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'unlock',jsonb_build_object('businessId',f->>'business','pin','086420'),repeat('b',64),gen_random_uuid());
    if r->'error' is not null then raise exception 'New PIN could not unlock'; end if;
    denial:=public.compat_secure_denial((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'context',jsonb_build_object('businessId',f->>'business','operatorToken',f->>'oldOperator'),repeat('b',64));
    if denial<>'SESSION_INVALID' then raise exception 'Old session regained access after fresh membership'; end if;
    if public.compat_secure_denial((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'accept_invitation',f->'rejoinRequest',repeat('b',64))<>'INVITATION_INVALID' then raise exception 'Old invitation regained access after fresh membership'; end if;
    begin
      perform public.account_confirm_pin_email('confirm_pin_email',jsonb_build_object('recoveryToken',f#>>'{recovery,data,token}','pin','024680','operationId',gen_random_uuid()));
      raise exception 'Old recovery regained access';
    exception when raise_exception then if sqlerrm<>'RECOVERY_INVALID' then raise; end if; end;
    r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'context',jsonb_build_object('businessId',f#>>'{secondBusiness,data,business,id}','operatorToken',f#>>'{secondBusiness,data,operatorToken}'));
    if r->'error' is not null then raise exception 'Other business session was revoked'; end if;
  end $$;`)
  stage = 'business and global Auth deletion cascades'
  sql(`do $$ declare f jsonb; begin
    select value into f from public.compat_fixture;
    delete from app_private.businesses where id=(f#>>'{secondBusiness,data,business,id}')::uuid;
    if not exists(select 1 from auth.users where id=(f->>'employee')::uuid) then raise exception 'Business cascade deleted global Auth user'; end if;
    if not exists(select 1 from app_private.business_memberships where business_id=(f->>'business')::uuid and user_id=(f->>'employee')::uuid) then raise exception 'Business cascade deleted other membership'; end if;
    delete from auth.users where id=(f->>'employee')::uuid;
    if exists(select 1 from app_private.employees where user_id=(f->>'employee')::uuid) or exists(select 1 from app_private.business_memberships where user_id=(f->>'employee')::uuid) then raise exception 'Global Auth cascade left personal links'; end if;
    if not exists(select 1 from auth.users where id=(f->>'owner')::uuid) or not exists(select 1 from app_private.businesses where id=(f->>'business')::uuid) then raise exception 'Auth cascade removed unrelated owner or business'; end if;
    delete from app_private.businesses where id=(f->>'business')::uuid;
    if exists(select 1 from app_private.employee_operation_tombstones) then raise exception 'Business cascade left operation tombstones'; end if;
  end $$;`)
  for (const source of sources) assert.equal(hash(readFileSync(source.path)), source.sha256, 'Source changed during final verification')
  console.log(`PASS real 0009→0010 compatibility: three old employee rows purged with scoped PIN/session/device/invitation/recovery associations; global Auth, other-business access, active/disabled people and shared registers preserved; new invitation/PIN/device works; stale session/invitation/recovery/create/restore paths denied; Auth/business cascades safe; drift guard rejects without changes; dashboard SQL matches CLI; ${schema.functions.length} function bodies, ${schema.tables.length} private tables, all columns/constraints/triggers/permissions verified; canonical ledger ${ledger.map(entry => entry.statements.length).join('/')}.`)
} catch (error) {
  const diagnostic = String(error.stderr ?? '').split('\n').find(line => /^ERROR:/.test(line))
  const safeError = error.status !== undefined ? `Local command exited with status ${error.status}` : error.message
  console.error(`Unlink migration smoke failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : diagnostic ?? safeError}`)
  process.exitCode = 1
} finally {
  if (created) sql(`drop database ${database} with (force);`, 'postgres')
  if (releaseCreated) sql(`drop database ${releaseDatabase} with (force);`, 'postgres')
  rmSync(workspace, { recursive: true, force: true })
}
