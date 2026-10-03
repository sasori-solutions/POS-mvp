// Real PostgreSQL lock-order checks in a uniquely named disposable local database.
// Never migrates or resets the running stack's primary database.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const workdir = process.env.TEST_SUPABASE_WORKDIR ?? (existsSync('.local-dev/supabase/config.toml') ? '.local-dev' : '.')
const status = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '--workdir', workdir, '-o', 'json'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}))
for (const url of [status.API_URL,status.DB_URL]) assert(['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname),'Loopback stack required')
const project = readFileSync(`${workdir}/supabase/config.toml`,'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
assert(project,'Local project required')
const container = `supabase_db_${project}`
const database = `pos_permission_${randomUUID().replaceAll('-','')}`
const staff = randomUUID(), owner = randomUUID(), business = randomUUID(), employee = randomUUID(), ownerEmployee = randomUUID(), session = randomUUID(), ownerSession = randomUUID(), product = randomUUID()
const token = randomUUID().replaceAll('-','').repeat(2), ownerToken = randomUUID().replaceAll('-','').repeat(2), keyHash = randomUUID().replaceAll('-','').repeat(2)
const sqlArgs = target => ['exec','-i',container,'psql','-U','postgres','-d',target,'-v','ON_ERROR_STOP=1','-At','-q']
function sql(query,target=database) { return execFileSync('docker',sqlArgs(target),{input:query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim() }
function concurrent(query) {
  const child = spawn('docker',sqlArgs(database),{stdio:['pipe','pipe','pipe']})
  const completion = new Promise(resolve => {let output='',error='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);child.on('close',code=>resolve({code,output,error}));child.on('error',error=>resolve({code:1,output:'',error:String(error)}))})
  child.stdin.end(query)
  return completion
}
async function waitForSleep(label) {
  for (let i=0;i<100;i++) {
    if(sql(`select count(*) from pg_stat_activity where datname='${database}' and application_name='${label}' and wait_event='PgSleep';`)==='1') return
    await new Promise(resolve=>setTimeout(resolve,30))
  }
  throw new Error('Synthetic lock holder did not reach its wait')
}
const config = `select set_config('app.employee_device_key','${keyHash}',true);`
const update = `select public.account_manage('${owner}','${ownerSession}','update_employee',jsonb_build_object('businessId','${business}','operatorToken','${ownerToken}','employeeId','${employee}','name','Persona sintética','role','cashier','active',true,'pin',null,'permissions','[]'::jsonb));`
function sale(operationId) { return `select public.pos_execute('${staff}','${session}','${business}','${token}',jsonb_build_object('command','complete_sale','operationId','${operationId}','paymentMethod','cash','totalCents',1001,'items',jsonb_build_array(jsonb_build_object('productId','${product}','version',1,'quantity',1,'unitPriceCents',1001))));` }
function restore() { sql(`update app_private.employees set permissions=array['catalog.read','sales.create','sales.read_own']::text[] where id='${employee}';update app_private.operator_sessions set revoked_at=null where business_id='${business}' and user_id='${staff}';`) }
let created=false
try {
  sql(`create database ${database} template template0;`,'postgres');created=true
  sql(`create schema auth;create schema extensions;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
  for(const file of readdirSync('supabase/migrations').filter(file=>file.endsWith('.sql') && file<='20261002001800_employee_permissions.sql').sort()) sql(readFileSync(`supabase/migrations/${file}`,'utf8'))
  sql(`insert into auth.users(id) values('${staff}'),('${owner}');insert into auth.sessions(id,user_id) values('${session}','${staff}'),('${ownerSession}','${owner}');
    insert into app_private.businesses(id,name,business_type,timezone,profile) values('${business}','Negocio sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja","paymentMethods":["cash"]}');
    insert into app_private.business_memberships(business_id,user_id,role) values('${business}','${owner}','owner'),('${business}','${staff}','cashier');
    insert into app_private.employees(id,business_id,user_id,name,role,permissions) values('${ownerEmployee}','${business}','${owner}','Dueño sintético','owner','{}'),('${employee}','${business}','${staff}','Persona sintética','cashier',array['catalog.read','sales.create','sales.read_own']);
    insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values('${business}','${employee}',decode('${keyHash}','hex'),'Navegador sintético');
    insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values('${business}','${staff}','${session}',extensions.digest('${token}','sha256'),decode('${keyHash}','hex')),('${business}','${owner}','${ownerSession}',extensions.digest('${ownerToken}','sha256'),null);
    insert into app_private.products(id,business_id,name,category,price_cents) values('${product}','${business}','Café sintético','Café',1001);`)

  // Revocation owns the employee first. A sale must wait, then observe its revoked session.
  const revocation = concurrent(`set application_name='permission-revocation';begin;select id from app_private.employees where id='${employee}' for update;select pg_sleep(1);${update}commit;`)
  await waitForSleep('permission-revocation')
  const rejected = await concurrent(`begin;${config}${sale(randomUUID())}commit;`)
  assert.equal((await revocation).code,0,'Revocation must commit without a deadlock')
  assert.equal(rejected.code,3,'The delayed sale must be rejected')
  assert(rejected.error.includes('SESSION_INVALID'),'Sale must reauthorize after waiting')
  assert.equal(sql(`select count(*) from app_private.sales where business_id='${business}';`),'0')

  // A sale owns the employee first. It commits once; revocation then closes the session.
  restore()
  const operationId = randomUUID()
  const collection = concurrent(`set application_name='permission-sale';begin;${config}select id from app_private.employees where id='${employee}' for share;select pg_sleep(1);${sale(operationId)}commit;`)
  await waitForSleep('permission-sale')
  const removed = await concurrent(update)
  assert.equal((await collection).code,0,'The already authorized sale must commit')
  assert.equal(removed.code,0,'Revocation after the sale must commit without a deadlock')
  const replay = await concurrent(`begin;${config}${sale(operationId)}commit;`)
  assert.equal(replay.code,3)
  assert(replay.error.includes('SESSION_INVALID'),'Accepted replay cannot use a revoked session')
  assert.equal(sql(`select count(*) from app_private.sales where business_id='${business}';`),'1')
  assert.equal(sql(`select count(*) from app_private.operator_sessions where business_id='${business}' and user_id='${staff}' and revoked_at is null;`),'0')
  console.log('PASS real disposable PostgreSQL: revocation first denies delayed sale; sale first commits once before revocation; accepted replay is denied; no deadlocks or surviving employee operators.')
} finally { if(created) sql(`drop database ${database} with (force);`,'postgres') }
