import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let db: PGlite
type Actor = { userId: string; authSessionId: string; businessId: string; operatorToken: string; hash: string }
describe('Point browser binding through separate RPC transactions', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('refreshes with the original verified browser, rejects missing/other hashes, and restores caller context', async () => {
    const actor = await newActor()
    await expect(point(actor, { command: 'settings' })).rejects.toThrow('SESSION_INVALID')
    await expect(point(actor, { command: 'settings', serverDeviceKeyHash: 'b'.repeat(64) })).rejects.toThrow('SESSION_INVALID')
    for (const invalid of [null, false, 2, 'invalid']) await expect(point(actor, { command: 'settings', serverDeviceKeyHash: invalid })).rejects.toThrow('VALIDATION_ERROR')
    expect(await point(actor, { command: 'settings', serverDeviceKeyHash: actor.hash })).toMatchObject({ data: { enabled: false } })
    expect((await db.query("select nullif(current_setting('app.employee_device_key',true),'') current")).rows[0].current).toBeNull()
    await db.exec('begin')
    try {
      await db.query("select set_config('app.employee_device_key',$1,true)", ['c'.repeat(64)])
      await point(actor, { command: 'settings', serverDeviceKeyHash: actor.hash })
      expect((await db.query("select current_setting('app.employee_device_key',true) current")).rows[0].current).toBe('c'.repeat(64))
      await db.exec('savepoint wrong_browser')
      await expect(point(actor, { command: 'settings', serverDeviceKeyHash: 'b'.repeat(64) })).rejects.toThrow('SESSION_INVALID')
      await db.exec('rollback to savepoint wrong_browser')
      expect((await db.query("select current_setting('app.employee_device_key',true) current")).rows[0].current).toBe('c'.repeat(64))
    } finally { await db.exec('rollback') }
  })
  it('saves an OAuth result only under the browser that authorized it and consumes it once', async () => {
    const actor = await newActor(), payload = await consumedState(actor)
    await expect(service('oauth_connection_save', payload)).rejects.toThrow('SESSION_INVALID')
    await expect(service('oauth_connection_save', { ...payload, serverDeviceKeyHash: 'b'.repeat(64) })).rejects.toThrow('SESSION_INVALID')
    expect(await service('oauth_connection_save', { ...payload, serverDeviceKeyHash: actor.hash })).toMatchObject({ businessId: actor.businessId, status: 'connected' })
    await expect(service('oauth_connection_save', { ...payload, serverDeviceKeyHash: actor.hash })).rejects.toThrow('POINT_OAUTH_INVALID')
    expect((await db.query('select count(*)::int count from app_private.point_connections where business_id=$1', [actor.businessId])).rows[0].count).toBe(1)
    expect((await db.query("select nullif(current_setting('app.employee_device_key',true),'') current")).rows[0].current).toBeNull()
  })
  it.each(['lock', 'browser-revoke', 'replacement', 'logout', 'membership'] as const)('does not finish provider I/O after %s', async reason => {
    const actor = await newActor(), payload = await consumedState(actor)
    if (reason === 'lock' || reason === 'browser-revoke') await db.query('update app_private.operator_sessions set revoked_at=clock_timestamp() where user_id=$1', [actor.userId])
    if (reason === 'replacement') await db.query("update app_private.operator_sessions set employee_device_key_hash=decode($2,'hex') where user_id=$1", [actor.userId, 'b'.repeat(64)])
    if (reason === 'logout') await db.query('delete from auth.sessions where id=$1', [actor.authSessionId])
    if (reason === 'membership') await db.query('update app_private.business_memberships set active=false where business_id=$1', [actor.businessId])
    await expect(service('oauth_connection_save', { ...payload, serverDeviceKeyHash: actor.hash })).rejects.toThrow(reason === 'logout' ? 'AUTH_REQUIRED' : reason === 'membership' ? 'BUSINESS_ACCESS_DENIED' : 'SESSION_INVALID')
    expect((await db.query('select count(*)::int count from app_private.point_connections where business_id=$1', [actor.businessId])).rows[0].count).toBe(0)
  })
  it('keeps accepted operation fingerprints unchanged but requires the current actor/browser on replay', async () => {
    const actor = await newActor(), payload = { command: 'close_statement', operationId: randomUUID(), period: '2026-09', serverDeviceKeyHash: actor.hash }
    const original = await point(actor, payload)
    expect(await point(actor, payload)).toEqual(original)
    await expect(point(actor, { ...payload, serverDeviceKeyHash: 'b'.repeat(64) })).rejects.toThrow('SESSION_INVALID')
    const { serverDeviceKeyHash: _hash, ...withoutHash } = payload
    await expect(point(actor, withoutHash)).rejects.toThrow('SESSION_INVALID')
    await db.query('update app_private.operator_sessions set revoked_at=clock_timestamp() where user_id=$1', [actor.userId])
    await expect(point(actor, payload)).rejects.toThrow('SESSION_INVALID')
    expect((await db.query('select count(*)::int count from app_private.point_operations where business_id=$1', [actor.businessId])).rows[0].count).toBe(1)
    expect((await db.query('select count(*)::int count from app_private.point_statements where business_id=$1', [actor.businessId])).rows[0].count).toBe(1)
  })
  it('preserves public signatures with service-only grants and private predecessors', async () => {
    for (const signature of ['public.point_execute(uuid,uuid,uuid,text,jsonb)', 'public.point_service(text,jsonb)']) {
      for (const role of ['anon', 'authenticated']) expect((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false)
      expect((await db.query('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') allowed', [signature])).rows[0].allowed).toBe(true)
    }
    for (const signature of ['app_private.point_execute_before_verified_browser(uuid,uuid,uuid,text,jsonb)', 'app_private.point_service_before_verified_browser(text,jsonb)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) expect((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false)
    }
    const functions = (await db.query("select proname,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('point_execute','point_service')")).rows
    expect(functions).toHaveLength(2)
    expect(functions.every(row => (row.proconfig as string[]).includes('search_path=""'))).toBe(true)
  })
})
async function point(actor: Actor, payload: Record<string, unknown>) { return (await db.query('select public.point_execute($1,$2,$3,$4,$5::jsonb) result', [actor.userId, actor.authSessionId, actor.businessId, actor.operatorToken, JSON.stringify(payload)])).rows[0].result }
async function service(action: string, payload: Record<string, unknown>) { return (await db.query('select public.point_service($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result }
async function newActor(): Promise<Actor> {
  const actor = { userId: randomUUID(), authSessionId: randomUUID(), businessId: randomUUID(), operatorToken: randomBytes(32).toString('hex'), hash: 'a'.repeat(64) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.authSessionId, actor.userId])
  await db.query("insert into app_private.businesses(id,name,business_type,timezone) values($1,'Point sintético','cafe','America/Mexico_City')", [actor.businessId])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'owner')", [actor.businessId, actor.userId])
  await db.query("insert into app_private.employees(business_id,user_id,name,role) values($1,$2,'Dueño sintético','owner')", [actor.businessId, actor.userId])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))", [actor.businessId, actor.userId, actor.authSessionId, actor.operatorToken, actor.hash])
  return actor
}
async function consumedState(actor: Actor) {
  const { hash: _hash, ...identity } = actor
  const payload = { ...identity, stateHash: randomBytes(32).toString('hex'), redirectUri: 'https://example.test/point/callback', environment: 'live',
    verifierCiphertext: 'synthetic-encrypted-verifier', expiresAt: new Date(Date.now() + 60000).toISOString(), receiverId: randomUUID(), tokensCiphertext: 'synthetic-encrypted-token' }
  await service('oauth_state_create', payload); await service('oauth_state_consume', payload)
  return payload
}
