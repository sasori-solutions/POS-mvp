import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: PGlite
let auditPredicate: string
type Actor = { userId: string; authSessionId: string; businessId: string; operatorToken: string }
describe('Point OAuth completion and Orders audit boundary', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    const definition = (await db.query<{ source: string }>("select pg_get_functiondef('public.point_service_before_inbox(text,jsonb)'::regprocedure) source")).rows[0].source
    const marker = 'for a in select pa.* from app_private.point_attempts pa where '
    const start = definition.indexOf(marker), end = definition.indexOf(' order by pa.updated_at,pa.id limit', start)
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
    auditPredicate = definition.slice(start + marker.length, end)
    await db.exec('create temporary table audit_attempts(state text,created_at timestamptz,last_reconciled_at timestamptz,observed_at timestamptz)')
  }, 60_000)
  beforeEach(async () => { await db.exec('truncate audit_attempts') })
  afterAll(async () => { await db?.close() })

  it('saves once under the original active actor and erases the consumed PKCE verifier', async () => {
    const actor = await newActor(), payload = await consumedState(actor)
    expect(await service('oauth_connection_save', payload)).toMatchObject({ businessId: actor.businessId, receiverId: payload.receiverId, environment: 'live', status: 'connected' })
    expect((await db.query('select pkce_ciphertext from app_private.point_oauth_states where state_hash=decode($1,\'hex\')', [payload.stateHash])).rows[0].pkce_ciphertext).toBeNull()
    await expect(service('oauth_connection_save', payload)).rejects.toThrow('POINT_OAUTH_INVALID')
    expect(await connections(actor.businessId)).toHaveLength(1)
  })
  it.each(['logout', 'pin-lock', 'expired-auth', 'ownership'] as const)('rejects %s after state consumption without saving a connection', async revoked => {
    const actor = await newActor(), payload = await consumedState(actor)
    if (revoked === 'logout') await db.query('delete from auth.sessions where id=$1', [actor.authSessionId])
    if (revoked === 'pin-lock') await db.query('update app_private.operator_sessions set revoked_at=clock_timestamp() where user_id=$1', [actor.userId])
    if (revoked === 'expired-auth') await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1", [actor.authSessionId])
    if (revoked === 'ownership') await db.query('update app_private.business_memberships set active=false where business_id=$1 and user_id=$2', [actor.businessId, actor.userId])
    await expect(service('oauth_connection_save', payload)).rejects.toThrow(revoked === 'logout' || revoked === 'expired-auth' ? 'AUTH_REQUIRED' : revoked === 'pin-lock' ? 'SESSION_INVALID' : 'BUSINESS_ACCESS_DENIED')
    expect(await connections(actor.businessId)).toHaveLength(0)
  })
  it.each(['businessId', 'userId', 'authSessionId', 'environment', 'redirectUri'] as const)('rejects an exchanged token outside its consumed %s binding', async field => {
    const actor = await newActor(), payload = await consumedState(actor)
    const changed = field === 'environment' ? 'sandbox' : field === 'redirectUri' ? 'https://another.example.test/point/callback' : randomUUID()
    await expect(service('oauth_connection_save', { ...payload, [field]: changed })).rejects.toThrow('POINT_OAUTH_INVALID')
    expect(await connections(actor.businessId)).toHaveLength(0)
  })
  it('rejects an unconsumed or expired browser state', async () => {
    const actor = await newActor(), payload = await consumedState(actor)
    await db.query('update app_private.point_oauth_states set consumed_at=null where state_hash=decode($1,\'hex\')', [payload.stateHash])
    await expect(service('oauth_connection_save', payload)).rejects.toThrow('POINT_OAUTH_INVALID')
    await db.query("update app_private.point_oauth_states set consumed_at=clock_timestamp(),expires_at=clock_timestamp()-interval '1 second' where state_hash=decode($1,'hex')", [payload.stateHash])
    await expect(service('oauth_connection_save', payload)).rejects.toThrow('POINT_OAUTH_INVALID')
    expect(await connections(actor.businessId)).toHaveLength(0)
  })
  it('keeps a newer completed connection when an older callback arrives late', async () => {
    const actor = await newActor(), older = await consumedState(actor), newer = await consumedState(actor)
    await service('oauth_connection_save', newer)
    await expect(service('oauth_connection_save', older)).rejects.toThrow('POINT_OAUTH_INVALID')
    expect(await connections(actor.businessId)).toMatchObject([{ receiver_id: newer.receiverId, status: 'connected' }])
  })
  it('retains private wrapper grants and exposes completion only through service role', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.point_service_before_oauth_completion(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
    for (const role of ['anon', 'authenticated']) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.point_service(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
  })
  it.each(['approved_verified', 'partially_refunded'])('audits %s only inside the three-calendar-month Orders window', async state => {
    await db.query("insert into audit_attempts values($1,now()-interval '2 months',now()-interval '6 minutes',now()-interval '1 hour')", [state])
    expect(await dueAudit()).toBe(true)
    await db.exec("update audit_attempts set created_at=now()-interval '4 months'")
    expect(await dueAudit()).toBe(false)
    await db.exec("update audit_attempts set created_at=now()-interval '2 months',last_reconciled_at=now()")
    expect(await dueAudit()).toBe(false)
  })
  it.each(['pending', 'sent_to_terminal', 'processing', 'unknown_review'])('never locally expires unresolved %s reconciliation', async state => {
    await db.query("insert into audit_attempts values($1,now()-interval '1 year',now()-interval '6 minutes',now()-interval '1 hour')", [state])
    expect(await dueAudit()).toBe(true)
  })
})
async function dueAudit() { return (await db.query('select 1 from audit_attempts pa where ' + auditPredicate)).rows.length === 1 }
async function connections(businessId: string) { return (await db.query('select receiver_id,status from app_private.point_connections where business_id=$1', [businessId])).rows }
async function service(action: string, payload: Record<string, unknown>) { return (await db.query<{ result: Record<string, unknown> }>('select public.point_service($1,$2::jsonb) result', [action, JSON.stringify(payload)])).rows[0].result }
async function newActor(): Promise<Actor> {
  const actor = { userId: randomUUID(), authSessionId: randomUUID(), businessId: randomUUID(), operatorToken: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [actor.userId]); await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [actor.authSessionId, actor.userId])
  await db.query("insert into app_private.businesses(id,name,business_type,timezone) values($1,'Comercio sintético','cafe','America/Mexico_City')", [actor.businessId])
  await db.query("insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,'owner')", [actor.businessId, actor.userId])
  await db.query("insert into app_private.employees(business_id,user_id,name,role) values($1,$2,'Dueño sintético','owner')", [actor.businessId, actor.userId])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))", [actor.businessId, actor.userId, actor.authSessionId, actor.operatorToken])
  return actor
}
async function consumedState(actor: Actor) {
  const payload = { ...actor, stateHash: randomUUID().replaceAll('-', '').repeat(2), redirectUri: 'https://example.test/point/callback', environment: 'live',
    verifierCiphertext: 'synthetic-encrypted-verifier', expiresAt: new Date(Date.now() + 60_000).toISOString(), receiverId: randomUUID(), tokensCiphertext: 'synthetic-encrypted-token' }
  await service('oauth_state_create', payload); await service('oauth_state_consume', payload)
  return payload
}
