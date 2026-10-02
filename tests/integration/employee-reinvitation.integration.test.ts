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

describe.skipIf(!url)('deleted employee accepts a new owner invitation without losing personal identity', () => {
  beforeAll(async () => {
    if (url !== 'http://127.0.0.1:55321' || container !== 'supabase_db_pos-employee-device-test') throw new Error('Requires the isolated local employee test stack')
    ;[owner, employee] = await Promise.all([identity(), identity()])
  })
  afterAll(async () => {
    if (businesses.length) sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)
    for (const id of users) { const result = await admin!.auth.admin.deleteUser(id); if (result.error) throw result.error }
  })

  it('reuses the archived person, PIN and device; applies the new role/name; retires only the empty placeholder', async () => {
    const fixture = await deletedEmployee()
    const { session, prior, original, invitation } = fixture
    const originalPin = sql(`select pin_hash from app_private.operator_credentials where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)
    sql(`update app_private.operator_credentials set failed_attempts=2 where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)
    const details = data(await call(employee, { action: 'invitation_details', invitationCode: invitation.invitation.invitationCode }))
    expect(details).toMatchObject({ returningEmployee: true, employee: { name: 'Persona reincorporada', role: 'manager', pinReady: true } })
    const acceptance = accept(invitation)
    const joined = data(await call(employee, acceptance)) as Session
    expect(joined.business.employee).toMatchObject({ id: prior.id, name: 'Persona reincorporada', role: 'manager' })
    expect(sql(`select pin_hash=${literal(originalPin)} and failed_attempts=0 from app_private.operator_credentials where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)).toBe('t')
    expect(sql(`select count(*) from app_private.employees where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)).toBe('1')
    expect(sql(`select merged_into_employee_id=${uuid(prior.id)} and deleted_at is not null and not active from app_private.employees where id=${uuid(invitation.id)};`)).toBe('t')
    const team = data(await call(owner, { action: 'team', ...ownerArgs(session) }))
    expect(team.employees.filter((person: Person) => person.id === prior.id)).toHaveLength(1)
    expect(team.deletedEmployees.map((person: Person) => person.id)).not.toContain(invitation.id)
    expect((await call(owner, { action: 'restore_employee', ...ownerArgs(session), employeeId: invitation.id, operationId: randomUUID() })).body.error?.code).toBe('EMPLOYEE_INACTIVE')
    expect((await call(employee, { action: 'context', businessId: session.business.id, operatorToken: original.operatorToken })).body.error?.code).toBe('SESSION_INVALID')
    expect(data(await call(employee, acceptance)).business.employee.id).toBe(prior.id)
    await remove(session, prior.id)
    expect((await call(employee, acceptance)).body.error?.code).toBe('INVITATION_INVALID')
    expect(sql(`select deleted_at is not null from app_private.employees where id=${uuid(prior.id)};`)).toBe('t')
  })

  it('keeps the archived person and invitation unchanged on wrong PIN or existing lockout', async () => {
    const { session, prior, invitation } = await deletedEmployee()
    const acceptance = accept(invitation)
    expect((await call(employee, { ...acceptance, pin: '135790' })).body.error?.code).toBe('PIN_INVALID')
    expect(sql(`select failed_attempts from app_private.operator_credentials where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)).toBe('1')
    expect(sql(`select deleted_at is not null and not active from app_private.employees where id=${uuid(prior.id)};`)).toBe('t')
    expect(sql(`select not active from app_private.business_memberships where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)).toBe('t')
    expect(sql(`select accepted_at is null from app_private.business_invitations where employee_id=${uuid(invitation.id)};`)).toBe('t')
    sql(`update app_private.operator_credentials set failed_attempts=5,locked_until=now()+interval '15 minutes' where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)
    expect((await call(employee, acceptance)).body.error?.code).toBe('PIN_LOCKED')
    expect(sql(`select failed_attempts=5 and locked_until>now() from app_private.operator_credentials where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)).toBe('t')
  })

  it('requires owner approval when rejoining from another browser and keeps the original binding', async () => {
    const { session, prior, invitation } = await deletedEmployee()
    const originalHash = sql(`select encode(key_hash,'hex') from app_private.employee_personal_devices where employee_id=${uuid(prior.id)};`)
    const otherDevice = { ...employee, keyId: randomUUID() }
    expect((await call(otherDevice, accept(invitation))).body.error?.code).toBe('DEVICE_APPROVAL_REQUIRED')
    expect(sql(`select encode(key_hash,'hex') from app_private.employee_personal_devices where employee_id=${uuid(prior.id)};`)).toBe(originalHash)
    expect(sql(`select accepted_at is not null and accepted_employee_id=${uuid(prior.id)} from app_private.business_invitations where token_hash=extensions.digest(${literal(invitation.invitation.invitationCode)},'sha256');`)).toBe('t')
    const notices = data(await call(owner, { action: 'notifications', ...ownerArgs(session) }))
    const pending = notices.notifications.find((notice: { status: string }) => notice.status === 'pending')
    expect(pending).toBeTruthy()
    data(await call(owner, { action: 'review_employee_device', ...ownerArgs(session), notificationId: pending.id, decision: 'approve' }))
    expect(data(await call(otherDevice, { action: 'unlock', businessId: session.business.id, pin: '086420' })).business.employee.id).toBe(prior.id)
    expect((await call(employee, { action: 'unlock', businessId: session.business.id, pin: '086420' })).body.error?.code).toBe('DEVICE_APPROVAL_REQUIRED')
  })

  it('does not merge active, merely inactive, owner, or existing PIN-only identities', async () => {
    const { session, prior, invitation } = await deletedEmployee()
    data(await call(owner, { action: 'restore_employee', ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() }))
    expect((await call(employee, accept(invitation))).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    data(await call(owner, { action: 'update_employee', ...ownerArgs(session), employeeId: prior.id, name: 'Persona inicial', role: 'cashier', active: false, pin: null }))
    expect((await call(employee, { action: 'invitation_details', invitationCode: invitation.invitation.invitationCode })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    expect((await call(owner, accept(invitation))).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    await remove(session, prior.id)
    const pinOnly = data(await call(owner, { action: 'create_employee', ...ownerArgs(session), name: 'Persona con historial', role: 'cashier', pin: null, inviteWithGoogle: false, operationId: randomUUID() }))
    const link = data(await call(owner, { action: 'create_invitation', ...ownerArgs(session), employeeId: pinOnly.id, operationId: randomUUID() }))
    expect((await call(employee, { action: 'invitation_details', invitationCode: link.invitationCode })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    expect((await call(employee, accept({ id: pinOnly.id, invitation: link }))).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
  })

  it('requires a new owner invitation issued after removal', async () => {
    const { prior, invitation } = await deletedEmployee({ inviteBeforeDelete: true })
    expect((await call(employee, { action: 'invitation_details', invitationCode: invitation.invitation.invitationCode })).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    expect((await call(employee, accept(invitation))).body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    expect(sql(`select deleted_at is not null from app_private.employees where id=${uuid(prior.id)};`)).toBe('t')
  })

  it('denies an owner opening their employee invitation without waiting on the owner row', async () => {
    const { session, invitation } = await deletedEmployee()
    const lock = await lockEmployee(session.business.employee!.id)
    try {
      const reply = await Promise.race([
        call(owner, { action: 'invitation_details', invitationCode: invitation.invitation.invitationCode }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Invitation lookup waited on unrelated active owner row')), 2_000)),
      ])
      expect(reply.body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    } finally { await lock.release() }
  })

  it('serializes concurrent new invitations to the same archived identity', async () => {
    const { session, prior, invitation } = await deletedEmployee()
    const second = data(await call(owner, { action: 'create_employee', ...ownerArgs(session), name: 'Otra invitación nueva', role: 'kitchen', pin: null, inviteWithGoogle: true, operationId: randomUUID() })) as Person
    const results = await Promise.all([call(employee, accept(invitation)), call(employee, accept(second))])
    expect(results.map(reply => reply.status).sort()).toEqual([200, 403])
    expect(results.find(reply => reply.status === 403)?.body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    expect(results.find(reply => reply.status === 200)?.body.data.business.employee.id).toBe(prior.id)
    expect(sql(`select count(*) from app_private.employees where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)} and active and deleted_at is null;`)).toBe('1')
  })

  it.each(['acceptance', 'restoration'])('serializes %s queued first against the other restoration path', async first => {
    const { session, prior, invitation } = await deletedEmployee()
    const lock = await lockEmployee(prior.id)
    const restoration = () => call(owner, { action: 'restore_employee', ...ownerArgs(session), employeeId: prior.id, operationId: randomUUID() })
    const acceptance = () => call(employee, accept(invitation))
    const earlier = (first === 'acceptance' ? acceptance : restoration)()
    let later: Promise<Reply> | undefined
    try {
      await waitForBlocked(lock.name, 1)
      later = (first === 'acceptance' ? restoration : acceptance)()
      await waitForBlocked(lock.name, 2)
    } finally { await lock.release() }
    const earlyReply = await earlier, lateReply = await later!
    expect(earlyReply.status).toBe(200)
    expect(lateReply.status).toBe(first === 'acceptance' ? 200 : 403)
    if (first === 'restoration') expect(lateReply.body.error?.code).toBe('BUSINESS_ACCESS_DENIED')
    expect(sql(`select count(*) from app_private.employees where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)} and active and deleted_at is null;`)).toBe('1')
    expect(sql(`select active from app_private.business_memberships where business_id=${uuid(session.business.id)} and user_id=${uuid(employee.id)};`)).toBe('t')
  })

  it('retains normal account deletion cascades after retiring a placeholder', async () => {
    const other = await identity()
    const { session, prior, invitation } = await deletedEmployee({ person: other })
    data(await call(other, accept(invitation)))
    const result = await admin!.auth.admin.deleteUser(other.id)
    expect(result.error).toBeNull()
    users.splice(users.indexOf(other.id), 1)
    expect(sql(`select count(*) from app_private.employees where business_id=${uuid(session.business.id)} and id in (${uuid(prior.id)},${uuid(invitation.id)});`)).toBe('0')
  })
})

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
