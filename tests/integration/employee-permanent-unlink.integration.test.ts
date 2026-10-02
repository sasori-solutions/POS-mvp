import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signedRequest } from './device-proof-fixture'

type Identity = { id: string; token: string; keyId: string }
type Session = { business: { id: string; employee?: { id: string; name: string; role: string } }; operatorToken: string }
type Person = { id: string; invitation: { invitationCode: string } }
type Reply = { status: number; body: { data?: any; error?: { code: string } } }
const url = process.env.TEST_SUPABASE_URL
const anon = process.env.TEST_SUPABASE_ANON_KEY!
const service = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!
const container = process.env.TEST_LOCAL_DB_CONTAINER!
const users: string[] = [], businesses: string[] = []
let owner: Identity, employee: Identity
const admin = url ? createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } }) : null

describe.skipIf(!url)('permanent employee unlink and fresh invitations', () => {
  beforeAll(async () => {
    const developerStack = url === 'http://127.0.0.1:55321' && container === 'supabase_db_pos-employee-device-test'
    const disposableCI = process.env.CI === 'true' && process.env.TEST_DISPOSABLE_SUPABASE === 'true'
      && url === 'http://127.0.0.1:54321' && container === 'supabase_db_pos-mexico-pwa'
    if (!developerStack && !disposableCI) throw new Error('Requires an explicitly isolated local employee test stack')
    ;[owner, employee] = await Promise.all([identity(), identity()])
  })
  afterAll(async () => {
    if (businesses.length) sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)
    for (const id of users) { const result = await admin!.auth.admin.deleteUser(id); if (result.error) throw result.error }
  })

  it('removes the old identity and lets the same Google user choose a new PIN and browser', async () => {
    const { session, prior, original, invitation } = await deletedEmployee()
    expect(sql(`select count(*) from app_private.employees where id=${uuid(prior.id)};`)).toBe('0')
    expect(sql(`select count(*) from app_private.business_memberships where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)).toBe('0')
    const details = data(await call(employee, { action: 'invitation_details', invitationCode: invitation.invitation.invitationCode }))
    expect(details.employee.pinReady).toBe(false)
    expect(details.returningEmployee).toBeUndefined()
    const freshBrowser = { ...employee, keyId: randomUUID() }
    const joined = data(await call(freshBrowser, { ...accept(invitation), pin: '246802' })) as Session
    expect(joined.business.employee!.id).toBe(invitation.id)
    expect(joined.business.employee!.id).not.toBe(prior.id)
    expect((await call(freshBrowser, { action: 'unlock', businessId: session.business.id, pin: '086420' })).body.error?.code).toBe('PIN_INVALID')
    expect(data(await call(freshBrowser, { action: 'unlock', businessId: session.business.id, pin: '246802' })).operatorToken).toBeTruthy()
    expect((await call(freshBrowser, accept(prior))).body.error?.code).toBe('INVITATION_INVALID')
    expect((await call(employee, { action: 'context', businessId: session.business.id, operatorToken: original.operatorToken })).body.error?.code).toBe('SESSION_INVALID')
    const team = data(await call(owner, { action: 'team', ...ownerArgs(session) }))
    expect(team.deletedEmployees).toBeUndefined()
    expect(team.employees.some((person: Person) => person.id === prior.id)).toBe(false)
  })

  it('forbids restoration and prevents old creation or deletion retries from recreating a person', async () => {
    const session = await business()
    const creation = { action: 'create_employee', ...ownerArgs(session), name: 'Persona eliminada definitivamente', role: 'cashier', pin: null, inviteWithGoogle: true, operationId: randomUUID() }
    const prior = data(await call(owner, creation)) as Person
    const invitationOperation = { action: 'create_invitation', ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() }
    data(await call(owner, invitationOperation))
    const deletion = { action: 'delete_employee', ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() }
    expect(data(await call(owner, deletion))).toEqual({ id: prior.id, deleted: true })
    expect(data(await call(owner, deletion))).toEqual({ id: prior.id, deleted: true })
    expect((await call(owner, creation)).body.error?.code).toBe('EMPLOYEE_INACTIVE')
    expect((await call(owner, { action: 'restore_employee', ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() })).body.error?.code).toBe('VALIDATION_ERROR')
    const authSessionId = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url').toString()).session_id as string
    const restore = JSON.stringify({ ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() })
    expect(() => sql(`select public.account_secure(${uuid(owner.id)},${uuid(authSessionId)},'restore_employee',${literal(restore)}::jsonb,null,null);`)).toThrow(/VALIDATION_ERROR/)
    expect((await call(employee, accept(prior))).body.error?.code).toBe('INVITATION_INVALID')
    const other = await invitePerson(session)
    expect((await call(owner, { ...invitationOperation, employeeId: other.id })).body.error?.code).toBe('EMPLOYEE_INACTIVE')
    expect((await call(owner, { ...deletion, employeeId: other.id })).body.error?.code).toBe('OPERATION_CONFLICT')
    data(await call(employee, { ...accept(other), pin: '246802' }))
    data(await call(owner, deletion))
    expect(data(await call(employee, { action: 'unlock', businessId: session.business.id, pin: '246802' })).operatorToken).toBeTruthy()
  })

  it('cleans scoped credentials, recovery, device and audit links while keeping other businesses and global Auth', async () => {
    const first = await business(), second = await business()
    const one = await invitePerson(first), two = await invitePerson(second)
    data(await call(employee, accept(one)))
    const otherSession = data(await call(employee, accept(two))) as Session
    data(await call(employee, { action: 'request_pin_email', businessId: first.business.id }))
    const newDevice = { ...employee, keyId: randomUUID() }
    expect((await call(newDevice, { action: 'unlock', businessId: first.business.id, pin: '086420' })).body.error?.code).toBe('DEVICE_APPROVAL_REQUIRED')
    const countBefore = sql(`select count(*) from app_private.account_audit_events where business_id=${uuid(first.business.id)};`)
    await remove(first, one.id)
    for (const table of ['business_memberships', 'operator_credentials', 'operator_sessions', 'owner_pin_recovery_credentials', 'pin_security_operations', 'pin_email_recoveries']) {
      expect(sql(`select count(*) from app_private.${table} where business_id=${uuid(first.business.id)} and user_id=${uuid(employee.id)};`), table).toBe('0')
    }
    for (const table of ['shared_employee_credentials', 'business_invitations', 'employee_create_operations', 'employee_pin_setup_codes', 'device_operator_sessions', 'employee_personal_devices', 'owner_notifications']) {
      expect(sql(`select count(*) from app_private.${table} where business_id=${uuid(first.business.id)} and employee_id=${uuid(one.id)};`), table).toBe('0')
    }
    for (const table of ['account_audit_events', 'pin_security_audit_events']) expect(sql(`select count(*) from app_private.${table} where business_id=${uuid(first.business.id)} and user_id=${uuid(employee.id)};`)).toBe('0')
    expect(Number(sql(`select count(*) from app_private.account_audit_events where business_id=${uuid(first.business.id)};`))).toBe(Number(countBefore) + 1)
    expect(sql(`select count(*) from auth.users where id=${uuid(employee.id)};`)).toBe('1')
    expect(data(await call(employee, { action: 'context', businessId: second.business.id, operatorToken: otherSession.operatorToken })).business.employee.id).toBe(two.id)
    expect(data(await call(employee, { action: 'status' })).businesses.map((item: { id: string }) => item.id)).not.toContain(first.business.id)
    expect(sql(`select count(*)>0 from app_private.employee_device_proofs where user_id=${uuid(employee.id)};`)).toBe('t')
  })

  it('serializes a creation retry waiting behind deletion without resurrecting the old operation', async () => {
    const session = await business()
    const creation = { action: 'create_employee', ...ownerArgs(session), name: 'Persona concurrente', role: 'cashier', pin: null, inviteWithGoogle: true, operationId: randomUUID() }
    const prior = data(await call(owner, creation)) as Person
    const lock = await lockEmployee(prior.id)
    const deleting = call(owner, { action: 'delete_employee', ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() })
    let retry: Promise<Reply> | undefined
    try { await waitForBlocked(lock.name, 1); retry = call(owner, creation); await waitForBlocked(lock.name, 2) }
    finally { await lock.release() }
    expect((await deleting).status).toBe(200)
    expect((await retry!).body.error?.code).toBe('EMPLOYEE_INACTIVE')
    expect(sql(`select count(*) from app_private.employees where business_id=${uuid(session.business.id)} and role<>'owner';`)).toBe('0')
  })

  it('preserves recorded sales and reserved operation IDs while removing the employee actor link', async () => {
    const session = await business()
    const prior = await invitePerson(session)
    const personal = data(await call(employee, accept(prior))) as Session
    const product = data(await call(owner, { action: 'pos', ...ownerArgs(session), command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Café histórico', category: 'Bebidas', priceCents: 1250 }))
    const command = { command: 'complete_sale', operationId: randomUUID(), items: [{ productId: product.id, quantity: 2, unitPriceCents: 1250, version: product.version }], totalCents: 2500, paymentMethod: 'cash' }
    const receipt = data(await call(employee, { action: 'pos', ...ownerArgs(personal), ...command }))
    const storedResult = sql(`select result::text from app_private.pos_operations where business_id=${uuid(session.business.id)} and operation_id=${uuid(command.operationId)};`)
    await remove(session, prior.id)
    expect(sql(`select employee_id is null and total_cents=2500 and item_count=2 from app_private.sales where id=${uuid(receipt.id)};`)).toBe('t')
    expect(sql(`select actor_id is null from app_private.pos_operations where business_id=${uuid(session.business.id)} and operation_id=${uuid(command.operationId)};`)).toBe('t')
    expect(sql(`select result::text from app_private.pos_operations where business_id=${uuid(session.business.id)} and operation_id=${uuid(command.operationId)};`)).toBe(storedResult)
    expect(data(await call(owner, { action: 'pos', ...ownerArgs(session), command: 'sale', saleId: receipt.id }))).toEqual(receipt)
    expect((await call(employee, { action: 'pos', ...ownerArgs(personal), ...command })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    const fresh = await invitePerson(session)
    const newPersonal = data(await call(employee, { ...accept(fresh), pin: '246802' })) as Session
    expect(data(await call(employee, { action: 'pos', ...ownerArgs(newPersonal), command: 'sales', cursor: null })).sales).toEqual([])
    expect((await call(employee, { action: 'pos', ...ownerArgs(newPersonal), command: 'sale', saleId: receipt.id })).body.error?.code).toBe('SALE_NOT_FOUND')
    expect((await call(employee, { action: 'pos', ...ownerArgs(newPersonal), ...command })).body.error?.code).toBe('OPERATION_CONFLICT')
    expect((await call(owner, { action: 'pos', ...ownerArgs(session), ...command })).body.error?.code).toBe('OPERATION_CONFLICT')
    expect(sql(`select count(*) from app_private.sales where business_id=${uuid(session.business.id)};`)).toBe('1')
    expect(sql(`select quantity=2 and unit_price_cents=1250 and total_cents=2500 from app_private.sale_items where sale_id=${uuid(receipt.id)};`)).toBe('t')
  })

  it('finishes a queued sale before deletion without deadlock or an accessible old actor', async () => {
    const session = await business(), prior = await invitePerson(session)
    const personal = data(await call(employee, accept(prior))) as Session
    const product = data(await call(owner, { action: 'pos', ...ownerArgs(session), command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Venta concurrente', category: '', priceCents: 1500 }))
    const command = { command: 'complete_sale', operationId: randomUUID(), items: [{ productId: product.id, quantity: 1, unitPriceCents: 1500, version: product.version }], totalCents: 1500, paymentMethod: 'cash' }
    const lock = await lockEmployee(prior.id)
    const sale = call(employee, { action: 'pos', ...ownerArgs(personal), ...command })
    let removal: Promise<Reply> | undefined
    try { await waitForBlocked(lock.name, 1); removal = call(owner, { action: 'delete_employee', ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() }); await waitForBlocked(lock.name, 2) }
    finally { await lock.release() }
    const receipt = data(await sale)
    expect((await removal!).status).toBe(200)
    expect(sql(`select employee_id is null and total_cents=1500 from app_private.sales where id=${uuid(receipt.id)};`)).toBe('t')
    expect(sql(`select actor_id is null from app_private.pos_operations where business_id=${uuid(session.business.id)} and operation_id=${uuid(command.operationId)};`)).toBe('t')
    expect((await call(employee, { action: 'pos', ...ownerArgs(personal), ...command })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
  })
})

async function business() {
  const session = data(await call(owner, { action: 'create_business', name: 'Negocio sintético permanente', businessType: 'cafe', timezone: 'America/Mexico_City', pin: '024680', operationId: randomUUID() })) as Session
  businesses.push(session.business.id)
  return session
}
async function invitePerson(session: Session) { return data(await call(owner, { action: 'create_employee', ...ownerArgs(session), name: 'Persona nueva', role: 'cashier', pin: null, inviteWithGoogle: true, operationId: randomUUID() })) as Person }

async function deletedEmployee(options: { inviteBeforeDelete?: boolean; person?: Identity } = {}) {
  const person = options.person ?? employee
  const session = data(await call(owner, { action: 'create_business', name: 'Negocio sintético reincorporación', businessType: 'cafe', timezone: 'America/Mexico_City', pin: '024680', operationId: randomUUID() })) as Session
  businesses.push(session.business.id)
  const prior = data(await call(owner, { action: 'create_employee', ...ownerArgs(session), name: 'Persona inicial', role: 'cashier', pin: null, inviteWithGoogle: true, operationId: randomUUID() })) as Person
  const original = data(await call(person, accept(prior))) as Session
  if (!options.inviteBeforeDelete) await remove(session, prior.id)
  const invitation = data(await call(owner, { action: 'create_employee', ...ownerArgs(session), name: 'Persona reincorporada', role: 'manager', pin: null, inviteWithGoogle: true, operationId: randomUUID() })) as Person
  if (options.inviteBeforeDelete) await remove(session, prior.id)
  return { session, prior, original, invitation }
}
function ownerArgs(session: Session) { return { businessId: session.business.id, operatorToken: session.operatorToken } }
function accept(person: Person) { return { action: 'accept_invitation', invitationCode: person.invitation.invitationCode, pin: '086420', operationId: randomUUID(), deviceName: 'Navegador sintético' } }
async function remove(session: Session, employeeId: string) { data(await call(owner, { action: 'delete_employee', ...ownerArgs(session), employeeId, operationId: randomUUID() })) }
async function call(who: Identity, body: Record<string, unknown>): Promise<Reply> {
  const response = await fetch(`${url}/functions/v1/account`, { method: 'POST', headers: { apikey: anon, authorization: `Bearer ${who.token}`, 'content-type': 'application/json' }, body: JSON.stringify(await signedRequest(who.keyId, body)) })
  return { status: response.status, body: await response.json() }
}
function data(reply: Reply) { expect(reply.status, reply.body.error?.code).toBe(200); expect(reply.body.data).toBeTruthy(); return reply.body.data }
async function identity(): Promise<Identity> {
  const credentials = { email: `rejoin-${randomUUID()}@example.test`, password: `local-only-${randomUUID()}-Aa9!` }
  const result = await admin!.auth.admin.createUser({ ...credentials, email_confirm: true }); if (result.error) throw result.error
  users.push(result.data.user.id)
  const client = createClient(url!, anon, { auth: { persistSession: false, autoRefreshToken: false } })
  const login = await client.auth.signInWithPassword(credentials); if (login.error) throw login.error
  return { id: result.data.user.id, token: login.data.session!.access_token, keyId: result.data.user.id }
}
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Synthetic UUID required'); return `'${value}'::uuid` }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'` }
function sql(statement: string) { return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }

async function lockEmployee(id: string) {
  const name = `rejoin_${randomUUID()}`
  const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic employee lock timed out')), 5_000)
    child.stdout.on('data', chunk => { if (String(chunk).includes('employee_locked')) { clearTimeout(timer); resolve() } })
    child.once('error', reject)
  })
  child.stdin.write(`set application_name='${name}';\nbegin;\nselect 1 from app_private.employees where id=${uuid(id)} for update;\nselect 'employee_locked';\n`)
  await ready
  return { name, release: () => new Promise<void>((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic lock process failed')))
    child.stdin.end('commit;\n')
  }) }
}
async function waitForBlocked(name: string, count: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = sql(`with recursive blocked(pid) as (select pid from pg_stat_activity where application_name=${literal(name)} union select a.pid from pg_stat_activity a join blocked b on b.pid=any(pg_blocking_pids(a.pid))) select count(*) from blocked join pg_stat_activity using(pid) where wait_event_type='Lock' and query like '%"account_secure"%';`)
    if (Number(waiting) >= count) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Expected ${count} synthetic requests waiting on employee row`)
}
