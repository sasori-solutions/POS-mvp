import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: PGlite
const source = readFileSync('scripts/install-point-scheduler.sql', 'utf8')
const predicate = source.slice(source.indexOf('  where exists('), source.indexOf('\n$job$'))
async function shouldDispatch() { return (await db.query('select 1 as dispatch ' + predicate)).rows.length === 1 }
describe('Point scheduler dispatch predicate', () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`create schema app_private;
      create table app_private.point_jobs(attempt_id text,status text,available_at timestamptz,lease_until timestamptz);
      create table app_private.point_attempts(id text,state text,sale_state text,remote_order_id text,last_reconciled_at timestamptz,observed_at timestamptz,created_at timestamptz);`)
  })
  beforeEach(async () => { await db.exec('truncate app_private.point_jobs,app_private.point_attempts') })
  afterAll(async () => { await db.close() })
  it('uses one 15-second schedule and avoids empty invocations', async () => {
    expect(source).toContain("cron.schedule('sasori-point-reconcile','15 seconds'")
    expect(await shouldDispatch()).toBe(false)
  })
  it('respects retry backoff and recovers expired leases', async () => {
    await db.exec("insert into app_private.point_jobs values('retry','queued',now()+interval '1 minute',null)")
    expect(await shouldDispatch()).toBe(false)
    await db.exec("update app_private.point_jobs set available_at=now()-interval '1 second'")
    expect(await shouldDispatch()).toBe(true)
    await db.exec("update app_private.point_jobs set status='leased',lease_until=now()+interval '1 minute'")
    expect(await shouldDispatch()).toBe(false)
    await db.exec("update app_private.point_jobs set lease_until=now()-interval '1 second'")
    expect(await shouldDispatch()).toBe(true)
  })
  it('reconciles active orders after ten seconds without overriding a queued retry', async () => {
    await db.exec("insert into app_private.point_attempts values('attempt','processing','pending','ORDER',now()-interval '11 seconds',now(),now())")
    expect(await shouldDispatch()).toBe(true)
    await db.exec("insert into app_private.point_jobs values('attempt','queued',now()+interval '1 minute',null)")
    expect(await shouldDispatch()).toBe(false)
    await db.exec("delete from app_private.point_jobs;update app_private.point_attempts set last_reconciled_at=now()")
    expect(await shouldDispatch()).toBe(false)
  })
  it('keeps periodic checks of confirmed charges for later refunds', async () => {
    await db.exec("insert into app_private.point_attempts values('attempt','approved_verified','materialized','ORDER',now()-interval '6 minutes',now(),now())")
    expect(await shouldDispatch()).toBe(true)
    await db.exec("update app_private.point_attempts set last_reconciled_at=now()")
    expect(await shouldDispatch()).toBe(false)
  })
  it('stops automatic confirmed-charge audits beyond the Orders window while preserving unresolved attempts', async () => {
    await db.exec("insert into app_private.point_attempts values('old','approved_verified','materialized','ORDER',now()-interval '6 minutes',now(),now()-interval '4 months')")
    expect(await shouldDispatch()).toBe(false)
    await db.exec("update app_private.point_attempts set state='partially_refunded'")
    expect(await shouldDispatch()).toBe(false)
    await db.exec("update app_private.point_attempts set state='unknown_review',sale_state='pending'")
    expect(await shouldDispatch()).toBe(true)
  })
})
