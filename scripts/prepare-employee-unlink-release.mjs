// Agente de Larios. Builds reviewable 0010 SQL artifacts; never deploys or reads credentials.
// Run the isolated employee-unlink migration smoke first. Its CLI ledger and
// schema manifest are tied to the exact migration source hashes used below.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const hash = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${value.replaceAll("'", "''")}'`
const literal = (value, index) => {
  let tag = `pos_unlink_${index}_${hash(value).slice(0, 12)}`
  while (value.includes(`$${tag}$`)) tag += '_x'
  return `$${tag}$${value}$${tag}$`
}
const evidence = JSON.parse(readFileSync('/tmp/pos-employee-unlink-schema-manifest.json', 'utf8'))
const ledger = JSON.parse(readFileSync('/tmp/pos-employee-unlink-canonical-ledger.json', 'utf8'))
assert.equal(ledger.length, 10, 'Run the isolated 0009→0010 migration smoke first')
assert.equal(ledger.at(-1).version, '20261002001000')
assert.equal(evidence.sources.length, 10)
assert.equal(evidence.ledgerSha256, hash(JSON.stringify(ledger)), 'Canonical ledger differs from tested evidence')
for (const source of evidence.sources) assert.equal(hash(readFileSync(source.path)), source.sha256, `Migration changed after compatibility check: ${source.path}`)
const latest = evidence.sources.at(-1)
assert(latest.path.startsWith('supabase/migrations/20261002001000_'))
const migration = readFileSync(latest.path, 'utf8')
const previous = ledger.slice(0, -1)
const row = ledger.at(-1)
const historyChecks = previous.map((entry, index) => `or not exists(select 1 from supabase_migrations.schema_migrations where version=${quote(entry.version)} and name=${quote(entry.name)} and statements=array[${entry.statements.map((statement, item) => literal(statement, `${index}_${item}`)).join(',')}]::text[])`).join('\n')
const guarded = `begin;
do $history_guard$ begin
if (select count(*) from supabase_migrations.schema_migrations)<>9
${historyChecks}
then raise exception 'Expected exact 0001-0009 ledger; no changes applied.'; end if;
end $history_guard$;

${migration}
insert into supabase_migrations.schema_migrations(version,name,statements) values(${quote(row.version)},${quote(row.name)},array[${row.statements.map(literal).join(',')}]::text[]);
commit;
`

const functionValues = evidence.functions.map(item => `(${quote(item.signature)},${quote(item.sourceSha256)},${item.securityDefiner})`).join(',\n')
const tableValues = evidence.tables.map(name => `(${quote(name)})`).join(',\n')
const ledgerValues = ledger.map(entry => `(${quote(entry.version)},${quote(entry.name)},${entry.statements.length},${quote(hash(entry.name + '\x1e' + entry.statements.join('\x1e')))})`).join(',\n')
const constraintValues = evidence.constraints.map(item => `(${quote(item.table)},${quote(item.name)},${quote(item.definition)})`).join(',\n')
const columnValues = evidence.columns.map(item => `(${quote(item.table)},${quote(item.name)},${quote(item.type)},${item.notNull},${item.default === null ? 'null::text' : quote(item.default)})`).join(',\n')
const triggerValues = evidence.triggers.map(item => `(${quote(item.table)},${quote(item.name)},${quote(item.definition)},${quote(item.enabled)})`).join(',\n')
const verification = `-- Agente de Larios. READ ONLY verification after additive migration 0010.
-- Expected definitions come from the disposable CLI-migrated database whose
-- exact migration source hashes are recorded in the release manifest.
-- No user data, credentials, email addresses, PINs or tokens are selected.
begin read only;
with expected_functions(signature,source_sha256,security_definer) as (values
${functionValues}
), expected_ledger(version,name,statement_count,ledger_sha256) as (values
${ledgerValues}
), expected_tables(name) as (values
${tableValues}
), expected_constraints(table_name,name,definition) as (values
${constraintValues}
), expected_columns(table_name,name,type,not_null,column_default) as (values
${columnValues}
), expected_triggers(table_name,name,definition,enabled) as (values
${triggerValues}
), actual_functions as (
 select p.*,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='app_private' or n.nspname='public' and p.proname like 'account_%'
), body_failures as (
 select e.signature from expected_functions e left join pg_proc p on p.oid=to_regprocedure(e.signature)
 where p.oid is null or encode(extensions.digest(p.prosrc,'sha256'),'hex')<>e.source_sha256
), security_failures as (
 select e.signature from expected_functions e left join pg_proc p on p.oid=to_regprocedure(e.signature)
 where p.oid is null or p.prosecdef<>e.security_definer or not coalesce(p.proconfig @> array['search_path=""']::text[],false)
), ledger_failures as (
 select coalesce(e.version,m.version) version from expected_ledger e full join supabase_migrations.schema_migrations m using(version)
 where e.version is null or m.version is null or m.name is distinct from e.name or cardinality(m.statements) is distinct from e.statement_count
 or encode(extensions.digest(m.name||chr(30)||array_to_string(m.statements,chr(30)),'sha256'),'hex') is distinct from e.ledger_sha256
), actual_tables as (
 select c.*,n.nspname||'.'||c.relname qualified_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r'
), table_inventory_failures as (
 select coalesce(e.name,a.qualified_name) name from expected_tables e full join actual_tables a on a.qualified_name=e.name where e.name is null or a.oid is null
), actual_constraints as (
 select c.conrelid::regclass::text table_name,c.conname name,pg_get_constraintdef(c.oid) definition from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='app_private'
), constraint_failures as (
 select coalesce(e.table_name,a.table_name)||'.'||coalesce(e.name,a.name) name from expected_constraints e full join actual_constraints a using(table_name,name)
 where e.name is null or a.name is null or a.definition is distinct from e.definition
), actual_columns as (
 select c.oid::regclass::text table_name,a.attname name,format_type(a.atttypid,a.atttypmod) type,a.attnotnull not_null,pg_get_expr(d.adbin,d.adrelid) column_default
 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
 where n.nspname='app_private' and c.relkind='r' and a.attnum>0 and not a.attisdropped
), column_failures as (
 select coalesce(e.table_name,a.table_name)||'.'||coalesce(e.name,a.name) name from expected_columns e full join actual_columns a using(table_name,name)
 where e.name is null or a.name is null or a.type is distinct from e.type or a.not_null is distinct from e.not_null or a.column_default is distinct from e.column_default
), actual_triggers as (
 select t.tgrelid::regclass::text table_name,t.tgname name,pg_get_triggerdef(t.oid) definition,t.tgenabled::text enabled from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and not t.tgisinternal
), trigger_failures as (
 select coalesce(e.table_name,a.table_name)||'.'||coalesce(e.name,a.name) name from expected_triggers e full join actual_triggers a using(table_name,name)
 where e.name is null or a.name is null or a.definition is distinct from e.definition or a.enabled is distinct from e.enabled
)
select jsonb_build_object(
 'migration_count',(select count(*) from supabase_migrations.schema_migrations),
 'migration_statement_counts',(select jsonb_agg(cardinality(statements) order by version) from supabase_migrations.schema_migrations),
 'migration_failures',(select coalesce(jsonb_agg(version),'[]'::jsonb) from ledger_failures),
 'expected_function_count',(select count(*) from expected_functions),
 'actual_function_count',(select count(*) from actual_functions),
 'function_body_failures',(select coalesce(jsonb_agg(signature),'[]'::jsonb) from body_failures),
 'function_security_failures',(select coalesce(jsonb_agg(signature),'[]'::jsonb) from security_failures),
 'unexpected_functions',(select coalesce(jsonb_agg(p.oid::regprocedure::text),'[]'::jsonb) from actual_functions p where not exists(select 1 from expected_functions e where to_regprocedure(e.signature)=p.oid)),
 'private_tables_count',(select count(*) from actual_tables),
 'table_inventory_failures',(select coalesce(jsonb_agg(name),'[]'::jsonb) from table_inventory_failures),
 'private_table_permission_failures',(select coalesce(jsonb_agg(qualified_name),'[]'::jsonb) from actual_tables c where not c.relrowsecurity or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
 'private_sequence_permission_failures',(select coalesce(jsonb_agg(c.relname),'[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='S' and (has_sequence_privilege('anon',c.oid,'USAGE,SELECT,UPDATE') or has_sequence_privilege('authenticated',c.oid,'USAGE,SELECT,UPDATE'))),
 'browser_callable_functions',(select coalesce(jsonb_agg(p.oid::regprocedure::text),'[]'::jsonb) from actual_functions p where has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')),
 'public_service_permission_failures',(select coalesce(jsonb_agg(p.oid::regprocedure::text),'[]'::jsonb) from actual_functions p where p.nspname='public' and not has_function_privilege('service_role',p.oid,'EXECUTE')),
 'private_policy_count',(select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private'),
 'constraint_failures',(select coalesce(jsonb_agg(name),'[]'::jsonb) from constraint_failures),
 'column_failures',(select coalesce(jsonb_agg(name),'[]'::jsonb) from column_failures),
 'trigger_failures',(select coalesce(jsonb_agg(name),'[]'::jsonb) from trigger_failures),
 'remaining_deleted_nonowners',(select count(*) from app_private.employees where role<>'owner' and deleted_at is not null),
 'retired_restore_function_failures',(select coalesce(jsonb_agg(p.oid::regprocedure::text),'[]'::jsonb) from actual_functions p where p.proname in ('can_rejoin_employee','verify_archived_employee_pin','change_employee_lifecycle_before_rejoin')),
 'authenticator_exposed_schemas',(select coalesce(jsonb_agg(setting),'[]'::jsonb) from pg_roles r cross join lateral unnest(r.rolconfig) setting where r.rolname='authenticator' and setting like 'pgrst.db_schemas=%')
) as verification;
commit;
`

const migrationPath = '/tmp/pos-employee-unlink-migration-with-history.sql'
const verificationPath = '/tmp/pos-employee-unlink-verify.sql'
const preflightPath = '/tmp/pos-employee-unlink-purge-preflight.sql'
const preflight = readFileSync('scripts/employee-unlink-purge-preflight.sql', 'utf8')
writeFileSync(migrationPath, guarded)
writeFileSync(verificationPath, verification)
writeFileSync(preflightPath, preflight)
const edgePaths = ['src/lib/contracts.ts', 'supabase/functions/account/validation.ts', 'supabase/functions/account/device-proof.ts', 'supabase/functions/account/authentication.ts', 'supabase/functions/account/email.ts', 'supabase/functions/account/index.ts']
const edgeSources = edgePaths.map(path => ({ path, text: readFileSync(path, 'utf8') }))
const npmImport = "import { createClient } from 'npm:@supabase/supabase-js@2.117.2'"
const edge = npmImport + '\n\n' + edgeSources.map(({ path, text }) => {
  const body = text.replace(npmImport + '\n', '').replace(/^import[^\n]*from ['"](?:\.\.\/\.\.\/\.\.\/src\/lib\/contracts\.ts|\.\/validation\.ts|\.\/authentication\.ts|\.\/email\.ts|\.\/device-proof\.ts)['"]\r?\n/gm, '')
  assert(!/^import\b/m.test(body), `Unresolved bundled import in ${path}`)
  return `// Source: ${path}; SHA-256 ${hash(text)}\n${body.trimEnd()}\n`
}).join('\n')
const edgePath = '/tmp/pos-employee-unlink-account-cloud.ts'
writeFileSync(edgePath, edge)
execFileSync('deno', ['check', edgePath], { stdio: ['ignore', 'pipe', 'pipe'] })
for (const { path, text } of edgeSources) assert.equal(hash(readFileSync(path)), hash(text), `Edge source changed while preparing artifacts: ${path}`)
const metadata = {
  migration: { path: migrationPath, bytes: Buffer.byteLength(guarded), sha256: hash(guarded) },
  verification: { path: verificationPath, bytes: Buffer.byteLength(verification), sha256: hash(verification) },
  preflight: { path: preflightPath, bytes: Buffer.byteLength(preflight), sha256: hash(preflight) },
  sources: evidence.sources,
  canonicalStatements: ledger.map(entry => entry.statements.length),
  functions: evidence.functions.length,
  tables: evidence.tables.length,
  edge: { path: edgePath, bytes: Buffer.byteLength(edge), sha256: hash(edge), redeployRequired: true, denoCheckPassed: true,
    note: 'The request parser retires restore_employee. Deploy account after 0010 and before the matching frontend.',
    sources: edgeSources.map(({ path, text }) => ({ path, sha256: hash(text) })) },
}
writeFileSync('/tmp/pos-employee-unlink-release.json', `${JSON.stringify(metadata, null, 2)}\n`)
console.log(JSON.stringify(metadata, null, 2))
