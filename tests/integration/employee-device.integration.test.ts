import { execFileSync, spawn } from 'node:child_process'
import { randomUUID, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type LocalConfig = { url: string; anonKey: string; serviceRoleKey: string; dbContainer: string }
type Identity = { userId: string; token: string; email: string; password: string; client: SupabaseClient }
type Session = { business: { id: string; role: string; employee?: { id: string } }; operatorToken: string }
type Notification = { id: string; type: string; employeeId: string; status: string; readAt: string | null }
type Inbox = { notifications: Notification[]; unreadCount: number }
type Reply<T> = { status: number; body: { data?: T; error?: { code: string } } }
type Proof = { publicKey: string; nonce: string; issuedAt: number; signature: string }
type Enrollment = { business: Session; employeeId: string; device: CryptoKeyPair; session: Session }

const config = loadLocalConfig()
const userIds: string[] = []
const businessIds: string[] = []
const ownerPin = '583927'
const employeePin = '024680'
let admin: SupabaseClient
let owner: Identity
let otherOwner: Identity
let employee: Identity

describe.skipIf(!config)('employee device binding and owner notifications', () => {
  beforeAll(async () => {
    admin = client(config!.serviceRoleKey)
    ;[owner, otherOwner, employee] = await Promise.all([newIdentity(), newIdentity(), newIdentity()])
  }, 30_000)

  afterAll(async () => {
    for (const userId of userIds) {
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) throw error
    }
    if (businessIds.length) sql(`delete from app_private.businesses where id in (${businessIds.map(uuid).join(',')});`)
  }, 30_000)

  it('binds invitation acceptance to a key and accepts a fresh Auth session only with the same device', async () => {
    const enrolled = await enroll()
    expect(enrolled.session.business).toMatchObject({ role: 'cashier', employee: { id: enrolled.employeeId } })
    expect((await call(employee, { action: 'context', ...args(enrolled.session) }, enrolled.device)).status).toBe(200)
    expectDenied(await call(employee, { action: 'context', ...args(enrolled.session) }), 'DEVICE_LINK_REQUIRED')
    expectDenied(await call(employee, { action: 'context', ...args(enrolled.session) }, await newDevice()))

    const nextClient = client(config!.anonKey)
    const auth = await nextClient.auth.signInWithPassword({ email: employee.email, password: employee.password })
    if (auth.error) throw auth.error
    const nextIdentity = { ...employee, token: auth.data.session!.access_token, client: nextClient }
    const next = await call<Session>(nextIdentity, unlock(enrolled), enrolled.device)
    expect(next.status).toBe(200)
    expect((await call(nextIdentity, { action: 'context', ...args(next.body.data!) }, enrolled.device)).status).toBe(200)
    const linked = (await inbox(enrolled)).notifications.filter((item) => item.type === 'employee_device_linked')
    expect(linked).toHaveLength(1)
    expect(linked[0]).toMatchObject({ employeeId: enrolled.employeeId, status: 'info', readAt: null })
  }, 30_000)

  it('requires a device proof before an invitation can be consumed', async () => {
    const business = await newBusiness(owner)
    const person = await invitePerson(business)
    const acceptance = { action: 'accept_invitation', invitationCode: person.invitation.invitationCode, pin: employeePin, operationId: randomUUID(), deviceName: 'Dispositivo sintético' }
    expectDenied(await call(employee, acceptance), 'DEVICE_LINK_REQUIRED')
    expect((await call<Session>(employee, acceptance, await newDevice())).status).toBe(200)
  }, 30_000)

  it('blocks another device and notifies once only after the correct identity and PIN', async () => {
    const enrolled = await enroll()
    const second = await newDevice()
    const baseline = await inbox(enrolled)
    const wrong = await call(employee, { ...unlock(enrolled), pin: '999999' }, second)
    expect(wrong.body.error?.code).toBe('PIN_INVALID')
    expect((await inbox(enrolled)).notifications).toHaveLength(baseline.notifications.length)

    const attempts = await Promise.all([call(employee, unlock(enrolled), second), call(employee, unlock(enrolled), second)])
    for (const attempt of attempts) expectDenied(attempt, 'DEVICE_APPROVAL_REQUIRED')
    const notifications = await inbox(enrolled)
    const pending = notifications.notifications.filter((item) => item.type === 'employee_device_requested')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ employeeId: enrolled.employeeId, status: 'pending', readAt: null })
    expect(notifications.unreadCount).toBe(baseline.unreadCount + 1)
    expect((await call(owner, { action: 'mark_notification_read', ...args(enrolled.business), notificationId: pending[0].id })).status).toBe(200)
    const read = await inbox(enrolled)
    expect(read.unreadCount).toBe(baseline.unreadCount)
    expect(read.notifications.find((item) => item.id === pending[0].id)).toMatchObject({ status: 'pending', readAt: expect.any(String) })
    expect((await call(employee, { action: 'context', ...args(enrolled.session) }, enrolled.device)).status).toBe(200)
  }, 30_000)

  it('owner approval replaces the binding, revokes old operators and still requires a new PIN login', async () => {
    const enrolled = await enroll()
    const second = await newDevice()
    expectDenied(await call(employee, unlock(enrolled), second), 'DEVICE_APPROVAL_REQUIRED')
    const pending = (await inbox(enrolled)).notifications.find((item) => item.type === 'employee_device_requested')!
    const review = { action: 'review_employee_device', ...args(enrolled.business), notificationId: pending.id, decision: 'approve' }
    const approved = await call(owner, review)
    expect(approved.status).toBe(200)
    expect(approved.body.data).toEqual({ reviewed: true })
    expect((await call(owner, review)).status).toBe(200)
    expectDenied(await call(employee, { action: 'context', ...args(enrolled.session) }, enrolled.device), 'SESSION_INVALID')
    expectDenied(await call(employee, { action: 'context', ...args(enrolled.session) }, second))
    expect((await call(employee, { ...unlock(enrolled), pin: '999999' }, second)).body.error?.code).toBe('PIN_INVALID')
    const entered = await call<Session>(employee, unlock(enrolled), second)
    expect(entered.status).toBe(200)
    expect((await call(employee, { action: 'context', ...args(entered.body.data!) }, second)).status).toBe(200)
    expect((await inbox(enrolled)).notifications.find((item) => item.id === pending.id)?.status).toBe('approved')
  }, 30_000)

  it('owner rejection preserves the current device and does not revive on a repeated decision', async () => {
    const enrolled = await enroll()
    const second = await newDevice()
    expectDenied(await call(employee, unlock(enrolled), second), 'DEVICE_APPROVAL_REQUIRED')
    const pending = (await inbox(enrolled)).notifications.find((item) => item.type === 'employee_device_requested')!
    const review = { action: 'review_employee_device', ...args(enrolled.business), notificationId: pending.id, decision: 'reject' }
    expect((await call(owner, review)).status).toBe(200)
    expect((await call(owner, review)).status).toBe(200)
    expectDenied(await call(owner, { ...review, decision: 'approve' }), 'OPERATION_CONFLICT')
    expect((await call(employee, { action: 'context', ...args(enrolled.session) }, enrolled.device)).status).toBe(200)
    expectDenied(await call(employee, unlock(enrolled), second), 'DEVICE_APPROVAL_REQUIRED')
    expect((await inbox(enrolled)).notifications.find((item) => item.id === pending.id)?.status).toBe('rejected')
  }, 30_000)

  it('rejects request tampering, invalid signatures, expired/future proofs and nonce replay', async () => {
    const enrolled = await enroll()
    const request = unlock(enrolled)
    const replayable = await signed(request, enrolled.device)
    expect((await call(employee, replayable)).status).toBe(200)
    expectDenied(await call(employee, replayable), 'DEVICE_PROOF_INVALID')
    const tampered = await signed(request, enrolled.device)
    expectDenied(await call(employee, { ...tampered, pin: '999999' }), 'DEVICE_PROOF_INVALID')
    const invalid = await signed(request, enrolled.device)
    invalid.deviceProof.signature = Buffer.alloc(64).toString('base64url')
    expectDenied(await call(employee, invalid), 'DEVICE_PROOF_INVALID')
    for (const issuedAt of [Date.now() - 600_000, Date.now() + 600_000]) {
      expectDenied(await call(employee, await signed(request, enrolled.device, issuedAt)), 'DEVICE_PROOF_INVALID')
    }
    const valid = await call<Session>(employee, request, enrolled.device)
    expect(valid.status).toBe(200)
    const context = { action: 'context', ...args(valid.body.data!) }
    expectDenied(await call(employee, { ...context, deviceProof: (await signed(request, enrolled.device)).deviceProof }), 'DEVICE_PROOF_INVALID')
  }, 30_000)

  it('keeps notification contents and owner decisions inside the authorized tenant and role', async () => {
    const enrolled = await enroll()
    const second = await newDevice()
    expectDenied(await call(employee, unlock(enrolled), second), 'DEVICE_APPROVAL_REQUIRED')
    const notification = (await inbox(enrolled)).notifications.find((item) => item.type === 'employee_device_requested')!
    const another = await newBusiness(otherOwner)
    expectDenied(await call(employee, { action: 'notifications', ...args(enrolled.session) }, enrolled.device))
    expectDenied(await call(employee, { action: 'mark_notification_read', ...args(enrolled.session), notificationId: notification.id }, enrolled.device))
    expectDenied(await call(employee, { action: 'review_employee_device', ...args(enrolled.session), notificationId: notification.id, decision: 'approve' }, enrolled.device))
    expectDenied(await call(otherOwner, { action: 'notifications', ...args(enrolled.business) }))
    expectDenied(await call(otherOwner, { action: 'mark_notification_read', ...args(another), notificationId: notification.id }))
    expectDenied(await call(otherOwner, { action: 'review_employee_device', ...args(another), notificationId: notification.id, decision: 'approve' }))
    expect((await inbox(enrolled)).notifications.find((item) => item.id === notification.id)).toMatchObject({ status: 'pending', readAt: null })
  }, 30_000)

  it('cannot bypass a linked employee binding through a shared register while legacy PIN staff still work', async () => {
    const enrolled = await enroll()
    const device = await pair(enrolled.business)
    expectDenied(await call(null, { action: 'device_unlock', deviceToken: device.deviceToken, employeeId: enrolled.employeeId, pin: employeePin }), 'DEVICE_LINK_REQUIRED')
    const legacy = await call<{ id: string; pinSetup: { setupCode: string } }>(owner, { action: 'create_employee', ...args(enrolled.business), name: 'Empleado PIN de prueba', role: 'kitchen', pin: null, inviteWithGoogle: false, operationId: randomUUID() })
    expect(legacy.status).toBe(200)
    const setup = await call<Session>(null, { action: 'device_set_employee_pin', deviceToken: device.deviceToken, setupCode: legacy.body.data!.pinSetup.setupCode, pin: employeePin, operationId: randomUUID() })
    expect(setup.status).toBe(200)
    const entered = await call<Session>(null, { action: 'device_unlock', deviceToken: device.deviceToken, employeeId: legacy.body.data!.id, pin: employeePin })
    expect(entered.status).toBe(200)
    expect((await call(null, { action: 'device_context', deviceToken: device.deviceToken, operatorToken: entered.body.data!.operatorToken })).status).toBe(200)
  }, 30_000)

  it('an owner approval revokes an old-device unlock already waiting on the employee row', async () => {
    const enrolled = await enroll()
    const second = await newDevice()
    expectDenied(await call(employee, unlock(enrolled), second), 'DEVICE_APPROVAL_REQUIRED')
    const pending = (await inbox(enrolled)).notifications.find((item) => item.type === 'employee_device_requested')!
    const locker = await lockEmployee(enrolled.employeeId)
    try {
      const unlocking = call<Session>(employee, unlock(enrolled), enrolled.device)
      await waitForBlockedRequests(locker.lockName, 1)
      const approving = call(owner, { action: 'review_employee_device', ...args(enrolled.business), notificationId: pending.id, decision: 'approve' })
      await waitForBlockedRequests(locker.lockName, 2)
      locker.stdin.end('commit;\n')
      const [unlocked, approved] = await Promise.all([unlocking, approving])
      expect(unlocked.status).toBe(200)
      expect(approved.status).toBe(200)
      expectDenied(await call(employee, { action: 'context', ...args(unlocked.body.data!) }, enrolled.device), 'SESSION_INVALID')
      expectDenied(await call(employee, unlock(enrolled), enrolled.device), 'DEVICE_APPROVAL_REQUIRED')
      const current = await call<Session>(employee, unlock(enrolled), second)
      expect(current.status).toBe(200)
      expect((await call(employee, { action: 'context', ...args(current.body.data!) }, second)).status).toBe(200)
      expect(sql(`select count(*) from app_private.employee_personal_devices where business_id=${uuid(enrolled.business.business.id)} and employee_id=${uuid(enrolled.employeeId)};`).trim()).toBe('1')
    } finally {
      if (!locker.stdin.writableEnded) locker.stdin.end('rollback;\n')
    }
  }, 30_000)

  it('email PIN recovery from another device preserves the binding and still needs owner approval', async () => {
    const enrolled = await enroll()
    const second = await newDevice()
    const originalBinding = sql(`select encode(key_hash,'hex') from app_private.employee_personal_devices where employee_id=${uuid(enrolled.employeeId)};`).trim()
    const sent = await call(employee, { action: 'request_pin_email', businessId: enrolled.business.business.id }, second)
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
    const recoveryToken = await recoveryEmail(employee.email)
    const nextPin = '135790'
    const confirmed = await call(null, { action: 'confirm_pin_email', recoveryToken, pin: nextPin, operationId: randomUUID() }, second)
    expect(confirmed.status).toBe(200)
    expect(confirmed.body.data).toEqual({ updated: true })
    expect(sql(`select encode(key_hash,'hex') from app_private.employee_personal_devices where employee_id=${uuid(enrolled.employeeId)};`).trim()).toBe(originalBinding)
    expectDenied(await call(employee, { action: 'context', ...args(enrolled.session) }, enrolled.device), 'SESSION_INVALID')
    expect((await call(employee, { ...unlock(enrolled), pin: nextPin }, enrolled.device)).status).toBe(200)
    expectDenied(await call(employee, { ...unlock(enrolled), pin: nextPin }, second), 'DEVICE_APPROVAL_REQUIRED')
    const pending = (await inbox(enrolled)).notifications.find((item) => item.type === 'employee_device_requested')!
    expect(pending.status).toBe('pending')
    expect((await call(owner, { action: 'review_employee_device', ...args(enrolled.business), notificationId: pending.id, decision: 'approve' })).status).toBe(200)
    expect((await call(employee, { ...unlock(enrolled), pin: nextPin }, second)).status).toBe(200)
  }, 30_000)

  it('permanent deletion removes pending requests and the personal device binding', async () => {
    const enrolled = await enroll()
    const second = await newDevice()
    expectDenied(await call(employee, unlock(enrolled), second), 'DEVICE_APPROVAL_REQUIRED')
    const pending = (await inbox(enrolled)).notifications.find((item) => item.type === 'employee_device_requested')!
    expect((await call(owner, { action: 'delete_employee', ...args(enrolled.business), employeeId: enrolled.employeeId, operationId: randomUUID() })).status).toBe(200)
    expect((await inbox(enrolled)).notifications.find((item) => item.id === pending.id)).toBeUndefined()
    expect((await call(owner, { action: 'restore_employee', ...args(enrolled.business), employeeId: enrolled.employeeId, operationId: randomUUID() })).body.error?.code).toBe('VALIDATION_ERROR')
    expectDenied(await call(owner, { action: 'review_employee_device', ...args(enrolled.business), notificationId: pending.id, decision: 'approve' }), 'BUSINESS_ACCESS_DENIED')
    expectDenied(await call(employee, unlock(enrolled), enrolled.device), 'BUSINESS_ACCESS_DENIED')
    expectDenied(await call(employee, unlock(enrolled), second), 'BUSINESS_ACCESS_DENIED')
    expect(sql(`select count(*) from app_private.employee_personal_devices where employee_id=${uuid(enrolled.employeeId)};`).trim()).toBe('0')
  }, 30_000)

})

function expectDenied(reply: Reply<unknown>, code?: string) {
  expect(reply.status).toBeGreaterThanOrEqual(400)
  expect(reply.status).toBeLessThan(500)
  expect(reply.body.error?.code).toBeTruthy()
  if (code) expect(reply.body.error?.code).toBe(code)
  expect(reply.body.data).toBeUndefined()
}

function args(session: Session) { return { businessId: session.business.id, operatorToken: session.operatorToken } }
function unlock(enrolled: Enrollment) { return { action: 'unlock', businessId: enrolled.business.business.id, pin: employeePin, deviceName: 'Dispositivo sintético' } }

async function enroll(): Promise<Enrollment> {
  const business = await newBusiness(owner)
  const person = await invitePerson(business)
  const device = await newDevice()
  const accepted = await call<Session>(employee, { action: 'accept_invitation', invitationCode: person.invitation.invitationCode, pin: employeePin, operationId: randomUUID(), deviceName: 'Dispositivo sintético' }, device)
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
  return { business, employeeId: person.id, device, session: accepted.body.data! }
}

async function invitePerson(business: Session) {
  const reply = await call<{ id: string; invitation: { invitationCode: string } }>(owner, { action: 'create_employee', ...args(business), name: 'Empleado de prueba', role: 'cashier', pin: null, inviteWithGoogle: true, operationId: randomUUID() })
  expect(reply.status).toBe(200)
  return reply.body.data!
}

async function inbox(enrolled: Enrollment) {
  const reply = await call<Inbox>(owner, { action: 'notifications', ...args(enrolled.business) })
  expect(reply.status).toBe(200)
  return reply.body.data!
}

async function pair(business: Session) {
  const code = await call<{ pairingCode: string }>(owner, { action: 'create_pairing_code', ...args(business), operationId: randomUUID() })
  expect(code.status).toBe(200)
  const device = await call<{ deviceToken: string }>(null, { action: 'device_pair', pairingCode: code.body.data!.pairingCode, deviceName: 'Caja sintética', operationId: randomUUID() })
  expect(device.status).toBe(200)
  return device.body.data!
}

async function newBusiness(identity: Identity) {
  const reply = await call<Session>(identity, { action: 'create_business', operationId: randomUUID(), name: `Synthetic device test ${randomUUID().slice(0, 8)}`, businessType: 'cafe', timezone: 'America/Mexico_City', pin: ownerPin })
  expect(reply.status).toBe(200)
  businessIds.push(reply.body.data!.business.id)
  return reply.body.data!
}

async function newDevice(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

async function signed(request: Record<string, unknown>, device: CryptoKeyPair, issuedAt = Date.now()): Promise<Record<string, unknown> & { deviceProof: Proof }> {
  const nonce = randomUUID()
  const message = new TextEncoder().encode(JSON.stringify({ request, nonce, issuedAt }))
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey('spki', device.publicKey)).toString('base64url')
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, message)).toString('base64url')
  return { ...request, deviceProof: { publicKey, nonce, issuedAt, signature } }
}

async function call<T = unknown>(identity: Identity | null, request: Record<string, unknown>, device?: CryptoKeyPair): Promise<Reply<T>> {
  const response = await fetch(`${config!.url}/functions/v1/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: config!.anonKey, ...(identity ? { authorization: `Bearer ${identity.token}` } : {}) },
    body: JSON.stringify(device ? await signed(request, device) : request),
  })
  return { status: response.status, body: await response.json() }
}

function client(key: string) { return createClient(config!.url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) }

async function newIdentity(): Promise<Identity> {
  const email = `device-integration-${randomUUID()}@example.test`
  const password = `local-only-${randomUUID()}-Aa9!`
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error) throw created.error
  userIds.push(created.data.user.id)
  const authClient = client(config!.anonKey)
  const signedIn = await authClient.auth.signInWithPassword({ email, password })
  if (signedIn.error) throw signedIn.error
  return { userId: created.data.user.id, token: signedIn.data.session!.access_token, email, password, client: authClient }
}

async function recoveryEmail(email: string): Promise<string> {
  const mailpitUrl = process.env.TEST_MAILPIT_URL ?? 'http://127.0.0.1:54324'
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(mailpitUrl).hostname)) throw new Error('Device integration tests require a loopback inbox.')
  const inbox = await (await fetch(`${mailpitUrl}/api/v1/messages`)).json()
  const message = inbox.messages.find((item: { To: { Address: string }[] }) => item.To.some((recipient) => recipient.Address === email))
  expect(message).toBeTruthy()
  const content = await (await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`)).json()
  const token = content.Text.match(/#recovery=([a-f0-9]{64})/)?.[1]
  expect(token).toBeTruthy()
  return token
}

async function lockEmployee(employeeId: string) {
  const lockName = `employee_device_${randomUUID()}`
  const child = spawn('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local employee lock did not become ready.')), 5_000)
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('employee_locked')) { clearTimeout(timeout); resolve() } })
    child.on('error', (error) => { clearTimeout(timeout); reject(error) })
    child.on('exit', (code) => { if (code) { clearTimeout(timeout); reject(new Error('Local employee lock exited.')) } })
  })
  child.stdin.write(`set application_name='${lockName}';\nbegin;\nselect 1 from app_private.employees where id=${uuid(employeeId)} for update;\nselect 'employee_locked';\n`)
  await ready
  return Object.assign(child, { lockName })
}

async function waitForBlockedRequests(lockName: string, count: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = sql(`with recursive blocked(pid) as (select pid from pg_stat_activity where application_name='${lockName}' union select a.pid from pg_stat_activity a join blocked b on b.pid=any(pg_blocking_pids(a.pid))) select count(*) from blocked join pg_stat_activity using(pid) where wait_event_type='Lock' and query like '%"account_secure"%';`).trim()
    if (Number(waiting) >= count) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Expected local device request to wait on the employee row lock.')
}

function loadLocalConfig(): LocalConfig | null {
  let status: Record<string, string>
  if (process.env.TEST_SUPABASE_URL) {
    status = { API_URL: process.env.TEST_SUPABASE_URL, ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? '', SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '' }
  } else {
    try { status = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) } catch { return null }
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(status.API_URL).hostname)) throw new Error('Device integration tests refuse non-loopback Supabase URLs.')
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Local integration credentials are incomplete.')
  const projectId = readFileSync('supabase/config.toml', 'utf8').match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
  if (!projectId) throw new Error('Local Supabase project_id is missing.')
  return { url: status.API_URL, anonKey: status.ANON_KEY, serviceRoleKey: status.SERVICE_ROLE_KEY, dbContainer: process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${projectId}` }
}

function uuid(value: string) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Expected a synthetic UUID for local SQL.')
  return `'${value}'::uuid`
}

function sql(statement: string) {
  return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
