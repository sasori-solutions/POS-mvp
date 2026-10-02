// Agente de Larios. Real 0008→0009 compatibility in a separate disposable DB.
// Never resets or migrates the running stack's primary database. Its output ties
// CLI-canonical history and expected cloud schema to exact checked source bytes.
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
const database = `pos_rejoin_compat_${randomUUID().replaceAll('-', '')}`
const releaseDatabase = `pos_rejoin_release_${randomUUID().replaceAll('-', '')}`
const workspace = mkdtempSync(`${tmpdir()}/pos-rejoin-compat-`)
const migrations = readdirSync('supabase/migrations').filter(file => /^\d{14}_.+\.sql$/.test(file)).sort()
assert.equal(migrations.length, 9)
assert.equal(migrations.at(-1), '20261002000900_employee_reinvitation.sql')
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = migrations.map(file => ({ path: `supabase/migrations/${file}`, sha256: hash(readFileSync(`supabase/migrations/${file}`)) }))
connection.pathname = `/${database}`
connection.searchParams.set('sslmode', 'disable')
let created = false
let releaseCreated = false
let stage = 'prepare'

function sql(statement, target = database) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', target, '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}
function migrate() {
  execFileSync(cli, ['db', 'push', '--db-url', connection.href, '--skip-vault', '--yes', '--workdir', workspace], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function snapshot(target = database) {
  return sql(`select jsonb_build_object(
 'credentials',(select jsonb_agg(to_jsonb(c) order by c.user_id) from app_private.operator_credentials c),
 'memberships',(select jsonb_agg(to_jsonb(m) order by m.user_id) from app_private.business_memberships m),
 'employees',(select jsonb_agg(to_jsonb(e)-'merged_into_employee_id' order by e.id) from app_private.employees e),
 'invitations',(select jsonb_agg(to_jsonb(i) order by i.id) from app_private.business_invitations i),
 'operators',(select jsonb_agg(to_jsonb(o) order by o.token_hash) from app_private.operator_sessions o),
 'bindings',(select jsonb_agg(to_jsonb(d) order by d.employee_id) from app_private.employee_personal_devices d),
 'notifications',(select jsonb_agg(to_jsonb(n) order by n.id) from app_private.owner_notifications n));`, target).trim()
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
  stage = 'existing archived employee fixture'
  sql(`create table public.compat_fixture(value jsonb); do $$
 declare u uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); es uuid:=gen_random_uuid(); b jsonb; a jsonb; p jsonb; joined jsonb; fresh jsonb;
 begin
 insert into auth.users(id,email,email_confirmed_at) values(u,'owner-compat@example.test',now()),(e,'employee-compat@example.test',now());
 insert into auth.sessions(id,user_id,created_at,updated_at) values(s,u,now(),now()),(es,e,now(),now());
 b:=public.account_secure(u,s,'create_business',jsonb_build_object('name','Café compatible','businessType','cafe','timezone','America/Mexico_City','operationId',gen_random_uuid(),'pin','028462'));
 a:=jsonb_build_object('businessId',b#>>'{data,business,id}','operatorToken',b#>>'{data,operatorToken}');
 p:=public.account_secure(u,s,'create_employee',a||jsonb_build_object('name','Empleado anterior','role','cashier','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
 joined:=public.account_secure(e,es,'accept_invitation',jsonb_build_object('invitationCode',p#>>'{data,invitation,invitationCode}','pin','024680','operationId',gen_random_uuid()),repeat('a',64),gen_random_uuid());
 if joined->'error' is not null then raise exception 'Baseline acceptance failed'; end if;
 perform public.account_secure(u,s,'delete_employee',a||jsonb_build_object('employeeId',p#>>'{data,id}','operationId',gen_random_uuid()));
 update app_private.operator_credentials set failed_attempts=2 where user_id=e;
 fresh:=public.account_secure(u,s,'create_employee',a||jsonb_build_object('name','Empleado reincorporado','role','manager','pin',null,'inviteWithGoogle',true,'operationId',gen_random_uuid()));
 insert into public.compat_fixture values(jsonb_build_object('owner',u,'ownerSession',s,'employee',e,'employeeSession',es,'ownerArgs',a,'oldPerson',p,'joined',joined,'freshPerson',fresh));
 end $$;`)
  const before = snapshot()
  const beforeCredential = sql(`select to_jsonb(c)-'failed_attempts'-'locked_until' from app_private.operator_credentials c where user_id=(select (value->>'employee')::uuid from public.compat_fixture);`).trim()
  const beforeBinding = sql(`select to_jsonb(d) from app_private.employee_personal_devices d;`).trim()
  // Keep a disposable 0008 clone to validate the exact dashboard SQL artifact,
  // including its fail-closed ledger guard, independently of CLI application.
  sql(`create database ${releaseDatabase} template ${database};`, 'postgres')
  releaseCreated = true
  copyFileSync(`supabase/migrations/${migrations.at(-1)}`, `${workspace}/supabase/migrations/${migrations.at(-1)}`)
  stage = 'migration'
  migrate()
  assert.equal(snapshot(), before, 'Additive migration preserves people, PIN hashes/counters, memberships, links, operators and device bindings')

  stage = 'rejoin behavior'
  sql(`do $$ declare f jsonb; r jsonb; target uuid; request jsonb; begin
 select value into f from public.compat_fixture; target:=(f#>>'{oldPerson,data,id}')::uuid;
 r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'invitation_details',jsonb_build_object('invitationCode',f#>>'{freshPerson,data,invitation,invitationCode}'),repeat('a',64),gen_random_uuid());
 if r#>>'{data,returningEmployee}' is distinct from 'true' or r#>>'{data,employee,pinReady}' is distinct from 'true' then raise exception 'Returning employee details missing'; end if;
 request:=jsonb_build_object('invitationCode',f#>>'{freshPerson,data,invitation,invitationCode}','pin','024680','operationId',gen_random_uuid());
 r:=public.account_secure((f->>'employee')::uuid,(f->>'employeeSession')::uuid,'accept_invitation',request,repeat('a',64),gen_random_uuid());
 if r#>>'{data,business,employee,id}' is distinct from target::text or r#>>'{data,business,role}' is distinct from 'manager' then raise exception 'Rejoin did not preserve identity/apply owner role'; end if;
 if (select name from app_private.employees where id=target)<>'Empleado reincorporado' then raise exception 'Owner assigned name was not applied'; end if;
 if (select count(*) from app_private.employees where active and deleted_at is null and role<>'owner')<>1 then raise exception 'Rejoin left duplicate active people'; end if;
 if (select merged_into_employee_id from app_private.employees where id=(f#>>'{freshPerson,data,id}')::uuid) is distinct from target then raise exception 'Placeholder was not retired into original person'; end if;
 begin
 perform public.account_secure((f->>'owner')::uuid,(f->>'ownerSession')::uuid,'restore_employee',f->'ownerArgs'||jsonb_build_object('employeeId',f#>>'{freshPerson,data,id}','operationId',gen_random_uuid()));
 raise exception 'Retired placeholder restored';
 exception when raise_exception then if sqlerrm<>'EMPLOYEE_INACTIVE' then raise; end if; end;
 end $$;`)
  assert.equal(sql(`select to_jsonb(c)-'failed_attempts'-'locked_until' from app_private.operator_credentials c where user_id=(select (value->>'employee')::uuid from public.compat_fixture);`).trim(), beforeCredential, 'Rejoin preserves exact PIN credential identity and salted hash')
  assert.equal(sql(`select failed_attempts=0 and locked_until is null from app_private.operator_credentials where user_id=(select (value->>'employee')::uuid from public.compat_fixture);`).trim(), 't', 'Correct PIN clears the counter like ordinary entry')
  assert.equal(sql(`select to_jsonb(d) from app_private.employee_personal_devices d;`).trim(), beforeBinding, 'Rejoin preserves original device identity')

  stage = 'canonical source manifest'
  const ledger = JSON.parse(sql('select jsonb_agg(row_to_json(m) order by version) from supabase_migrations.schema_migrations m;').trim())
  assert.equal(ledger.length, 9)
  assert.deepEqual(ledger.slice(0, -1).map(entry => entry.statements.length), [44, 48, 27, 23, 29, 21, 16, 26])
  const schema = JSON.parse(sql(`select jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_object('signature',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')','sourceSha256',encode(extensions.digest(p.prosrc,'sha256'),'hex'),'securityDefiner',p.prosecdef) order by n.nspname,p.proname,p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' or n.nspname='public' and p.proname like 'account_%'),
 'tables',(select jsonb_agg(n.nspname||'.'||c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r'),
 'employeeConstraints',(select jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid)) order by conname) from pg_constraint where conrelid='app_private.employees'::regclass));`).trim())
  for (const source of sources) assert.equal(hash(readFileSync(source.path)), source.sha256, 'Migration source changed while smoke ran; rerun to avoid stale artifacts')
  const evidence = { sources, ledgerSha256: hash(JSON.stringify(ledger)), ...schema }
  writeFileSync('/tmp/pos-employee-rejoin-canonical-ledger.json', JSON.stringify(ledger))
  writeFileSync('/tmp/pos-employee-rejoin-schema-manifest.json', `${JSON.stringify(evidence, null, 2)}\n`)
  stage = 'release artifact verification'
  execFileSync(process.execPath, ['scripts/prepare-employee-rejoin-release.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const verified = JSON.parse(sql(readFileSync('/tmp/pos-employee-rejoin-verify.sql', 'utf8')).trim())
  for (const [key, value] of Object.entries(verified)) if (key.endsWith('_failures') || key === 'unexpected_functions' || key === 'browser_callable_functions') assert.deepEqual(value, [], key)
  assert.equal(verified.employee_merged_into_column, true)
  assert.equal(verified.employee_session_key_column, true)
  assert.equal(verified.employee_device_cleanup_trigger, true)
  assert.equal(verified.private_policy_count, 0)
  assert.equal(verified.actual_function_count, schema.functions.length)
  assert.equal(verified.private_tables_count, schema.tables.length)
  writeFileSync('/tmp/pos-employee-rejoin-local-verification.json', `${JSON.stringify(verified, null, 2)}\n`)
  stage = 'exact ledger guard and dashboard artifact'
  sql("update supabase_migrations.schema_migrations set name=name||'_guard_probe' where version='20261001000800';", releaseDatabase)
  const guarded = readFileSync('/tmp/pos-employee-rejoin-migration-with-history.sql', 'utf8')
  let rejected = false
  try { sql(guarded, releaseDatabase) } catch (error) { rejected = String(error.stderr).includes('Expected exact 0001-0008 ledger; no changes applied.') }
  assert.equal(rejected, true, 'Ledger mismatch must reject the complete release transaction')
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='app_private' and table_name='employees' and column_name='merged_into_employee_id';", releaseDatabase).trim(), '0', 'Rejected release must not add columns')
  assert.equal(snapshot(releaseDatabase), before, 'Rejected release must not change existing data')
  sql("update supabase_migrations.schema_migrations set name='employee_device_notifications' where version='20261001000800';", releaseDatabase)
  sql(guarded, releaseDatabase)
  assert.equal(snapshot(releaseDatabase), before, 'Dashboard release artifact must preserve baseline data')
  const deployed = JSON.parse(sql(readFileSync('/tmp/pos-employee-rejoin-verify.sql', 'utf8'), releaseDatabase).trim())
  assert.deepEqual(deployed, verified, 'Guarded dashboard SQL and CLI migrations must produce identical verified schema/permissions/history')
  console.log(`PASS real 0008→0009 compatibility: exact existing data preserved; rejoin retains identity/PIN hash/device and owner assignment; correct PIN clears failure count; placeholder restore blocked; exact-history guard rejects drift; dashboard artifact matches CLI; ${schema.functions.length} function bodies and ${schema.tables.length} private tables/permissions verified; canonical ledger ${ledger.map(entry => entry.statements.length).join('/')}.`)
} catch (error) {
  const diagnostic = String(error.stderr ?? '').split('\n').find(line => line.startsWith('ERROR:'))
  const safeError = error.status !== undefined ? `Local command exited with status ${error.status}` : error.message
  console.error(`Rejoin migration smoke failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : diagnostic ?? safeError}`)
  process.exitCode = 1
} finally {
  if (created) sql(`drop database ${database} with (force);`, 'postgres')
  if (releaseCreated) sql(`drop database ${releaseDatabase} with (force);`, 'postgres')
  rmSync(workspace, { recursive: true, force: true })
}
