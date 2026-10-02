// Agente de Larios. Builds reviewable 0009 SQL artifacts; never deploys or reads credentials.
// Run the isolated employee-rejoin migration smoke first. Its CLI ledger and
// schema manifest are tied to the exact migration source hashes used below.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const hash = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${value.replaceAll("'", "''")}'`
const literal = (value, index) => {
  let tag = `pos_rejoin_${index}_${hash(value).slice(0, 12)}`
  while (value.includes(`$${tag}$`)) tag += '_x'
  return `$${tag}$${value}$${tag}$`
}
const evidence = JSON.parse(readFileSync('/tmp/pos-employee-rejoin-schema-manifest.json', 'utf8'))
const ledger = JSON.parse(readFileSync('/tmp/pos-employee-rejoin-canonical-ledger.json', 'utf8'))
assert.equal(ledger.length, 9, 'Run the isolated 0008→0009 migration smoke first')
assert.equal(ledger.at(-1).version, '20261002000900')
assert.equal(evidence.sources.length, 9)
assert.equal(evidence.ledgerSha256, hash(JSON.stringify(ledger)), 'Canonical ledger differs from tested evidence')
for (const source of evidence.sources) assert.equal(hash(readFileSync(source.path)), source.sha256, `Migration changed after compatibility check: ${source.path}`)
const latest = evidence.sources.at(-1)
assert(latest.path.startsWith('supabase/migrations/20261002000900_'))
const migration = readFileSync(latest.path, 'utf8')
const previous = ledger.slice(0, -1)
const row = ledger.at(-1)
const historyChecks = previous.map((entry, index) => `or not exists(select 1 from supabase_migrations.schema_migrations where version=${quote(entry.version)} and name=${quote(entry.name)} and statements=array[${entry.statements.map((statement, item) => literal(statement, `${index}_${item}`)).join(',')}]::text[])`).join('\n')
const guarded = `begin;
do $history_guard$ begin
if (select count(*) from supabase_migrations.schema_migrations)<>8
${historyChecks}
then raise exception 'Expected exact 0001-0008 ledger; no changes applied.'; end if;
end $history_guard$;

${migration}
insert into supabase_migrations.schema_migrations(version,name,statements) values(${quote(row.version)},${quote(row.name)},array[${row.statements.map(literal).join(',')}]::text[]);
commit;
`

const functionValues = evidence.functions.map(item => `(${quote(item.signature)},${quote(item.sourceSha256)},${item.securityDefiner})`).join(',\n')
const tableValues = evidence.tables.map(name => `(${quote(name)})`).join(',\n')
const ledgerValues = ledger.map(entry => `(${quote(entry.version)},${quote(entry.name)},${entry.statements.length},${quote(hash(entry.name + '\x1e' + entry.statements.join('\x1e')))})`).join(',\n')
const constraintValues = evidence.employeeConstraints.map(item => `(${quote(item.name)},${quote(item.definition)})`).join(',\n')
const verification = `-- Agente de Larios. READ ONLY verification after additive migration 0009.
-- Expected definitions come from the disposable CLI-migrated database whose
-- exact migration source hashes are recorded in the release manifest.
-- No user data, credentials, email addresses, PINs or tokens are selected.
with expected_functions(signature,source_sha256,security_definer) as (values
${functionValues}
), expected_ledger(version,name,statement_count,ledger_sha256) as (values
${ledgerValues}
), expected_tables(name) as (values
${tableValues}
), expected_employee_constraints(name,definition) as (values
${constraintValues}
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
), actual_employee_constraints as (
 select conname name,pg_get_constraintdef(oid) definition from pg_constraint where conrelid='app_private.employees'::regclass
), employee_constraint_failures as (
 select coalesce(e.name,a.name) name from expected_employee_constraints e full join actual_employee_constraints a using(name)
 where e.name is null or a.name is null or a.definition is distinct from e.definition
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
 'employee_constraint_failures',(select coalesce(jsonb_agg(name),'[]'::jsonb) from employee_constraint_failures),
 'employee_merged_into_column',exists(select 1 from information_schema.columns where table_schema='app_private' and table_name='employees' and column_name='merged_into_employee_id' and udt_name='uuid' and is_nullable='YES'),
 'employee_session_key_column',exists(select 1 from information_schema.columns where table_schema='app_private' and table_name='operator_sessions' and column_name='employee_device_key_hash' and udt_name='bytea'),
 'employee_device_cleanup_trigger',exists(select 1 from pg_trigger t where t.tgrelid='app_private.employees'::regclass and t.tgname='employee_device_requests_close' and t.tgenabled='O' and t.tgfoid=to_regprocedure('app_private.close_employee_device_requests()')),
 'authenticator_exposed_schemas',(select coalesce(jsonb_agg(setting),'[]'::jsonb) from pg_roles r cross join lateral unnest(r.rolconfig) setting where r.rolname='authenticator' and setting like 'pgrst.db_schemas=%')
) as verification;
`

const migrationPath = '/tmp/pos-employee-rejoin-migration-with-history.sql'
const verificationPath = '/tmp/pos-employee-rejoin-verify.sql'
writeFileSync(migrationPath, guarded)
writeFileSync(verificationPath, verification)
const metadata = {
  migration: { path: migrationPath, bytes: Buffer.byteLength(guarded), sha256: hash(guarded) },
  verification: { path: verificationPath, bytes: Buffer.byteLength(verification), sha256: hash(verification) },
  sources: evidence.sources,
  canonicalStatements: ledger.map(entry => entry.statements.length),
  functions: evidence.functions.length,
  tables: evidence.tables.length,
  edge: { redeployRequired: false, note: '0009 changes SQL and an optional response field; validate runtime Edge sources separately before deployment.' },
}
writeFileSync('/tmp/pos-employee-rejoin-release.json', `${JSON.stringify(metadata, null, 2)}\n`)
console.log(JSON.stringify(metadata, null, 2))
