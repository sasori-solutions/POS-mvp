import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiningTable, OperationsSnapshot, TableLayout } from '../../src/lib/operations-contracts'
import type { PosCommand } from '../../src/lib/pos-contracts'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
let db: PGlite
let legacy: { actor: Actor; command: PosCommand; result: DiningTable }
const migration = '20261007140000_restaurant_service.sql'
const layout: TableLayout = { zone: 'Salón', row: 2, column: 3, seats: 4, shape: 'round' }

describe('restaurant floor layout and table recovery', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && file <= migration).sort()) {
      if (file === migration) {
        const person = await actor(); await activate(person)
        const command: PosCommand = { command: 'save_table', operationId: randomUUID(), tableId: randomUUID(), expectedRevision: null, name: 'Mesa histórica sintética', active: true }
        legacy = { actor: person, command, result: await execute(person, command) }
      }
      await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('preserves pre-migration replies and returns persisted positions after reload', async () => {
    expect(legacy.result).not.toHaveProperty('layout')
    expect(await execute(legacy.actor, legacy.command)).toEqual(legacy.result)
    const command: PosCommand = { command: 'set_table_layout', operationId: randomUUID(), tableId: legacy.result.id, expectedRevision: legacy.result.revision, layout }
    const saved = await execute<DiningTable>(legacy.actor, command)
    expect(saved).toMatchObject({ layout, revision: legacy.result.revision + 1 })
    expect((await execute<OperationsSnapshot>(legacy.actor, { command: 'operations' })).tables.find(table => table.id === saved.id)).toEqual(saved)
    await execute(legacy.actor, { ...command, operationId: randomUUID(), expectedRevision: saved.revision, layout: { ...layout, column: 4 } })
    expect(await execute(legacy.actor, command)).toEqual(saved)
    await expect(execute(legacy.actor, { ...command, layout: { ...layout, seats: 5 } })).rejects.toThrow('OPERATION_CONFLICT')
    await db.query('update app_private.operational_settings set enabled=false where business_id=$1', [legacy.actor.businessId])
    expect(await execute(legacy.actor, command)).toEqual(saved)
    await db.query('update app_private.operational_settings set enabled=true where business_id=$1', [legacy.actor.businessId])
  })

  it('rejects occupied floor positions without changing versions and handles reactivation', async () => {
    const person = await actor(); await activate(person)
    const first = await table(person), second = await table(person)
    await place(person, first, layout)
    await expect(place(person, second, { ...layout, zone: 'salón' })).rejects.toThrow('TABLE_POSITION_OCCUPIED')
    expect((await execute<{ tables: DiningTable[] }>(person, { command: 'tables' })).tables.find(item => item.id === second.id)).toMatchObject({ revision: 1, layout: null })
    let inactive = await execute<DiningTable>(person, { command: 'save_table', operationId: randomUUID(), tableId: second.id, expectedRevision: second.revision, name: second.name, active: false })
    inactive = await place(person, inactive, layout)
    await expect(execute(person, { command: 'save_table', operationId: randomUUID(), tableId: inactive.id, expectedRevision: inactive.revision, name: inactive.name, active: true })).rejects.toThrow('TABLE_POSITION_OCCUPIED')
    const moved = await place(person, inactive, { ...layout, zone: 'Terraza' })
    expect(await execute(person, { command: 'save_table', operationId: randomUUID(), tableId: moved.id, expectedRevision: moved.revision, name: moved.name, active: true })).toMatchObject({ active: true })
  })

  it('authorizes the current actor before replay and keeps tenant references private', async () => {
    const person = await actor(), other = await actor(); await activate(person); await activate(other)
    const own = await table(person), foreign = await table(other)
    const viewer = await actor(person.businessId, ['orders.read'])
    const command: PosCommand = { command: 'set_table_layout', operationId: randomUUID(), tableId: own.id, expectedRevision: own.revision, layout }
    const accepted = await execute(person, command)
    await expect(execute(viewer, command)).rejects.toThrow('PERMISSION_DENIED')
    await expect(place(person, foreign, layout)).rejects.toThrow('TABLE_CHANGED')
    await expect(execute(person, { ...command, operationId: randomUUID() })).rejects.toThrow('TABLE_CHANGED')
    expect(await execute(person, command)).toEqual(accepted)
    await db.query('update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=$1 and user_id=$2', [person.businessId, person.userId])
    await expect(execute(person, command)).rejects.toThrow('SESSION_INVALID')
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege('anon','app_private.pos_command(uuid,uuid,jsonb)','execute') allowed")).rows[0].allowed).toBe(false)
  })

  it('validates exact layouts consistently in HTTP and SQL', async () => {
    const person = await actor(); await activate(person); const value = await table(person)
    const command = { command: 'set_table_layout', operationId: randomUUID(), tableId: value.id, expectedRevision: value.revision, layout }
    expect(parseAccountRequest({ action: 'pos', businessId: person.businessId, operatorToken: person.token, ...command })).toMatchObject(command)
    expect(parseAccountRequest({ action: 'device_pos', deviceToken: person.token, operatorToken: person.token, ...command })).toMatchObject(command)
    for (const invalid of [{ ...layout, row: 0 }, { ...layout, column: 13 }, { ...layout, seats: 1.5 }, { ...layout, seats: true }, { ...layout, shape: 'triangle' }, { ...layout, zone: '' }, { ...layout, zone: 'Salón\nUno' }, { ...layout, extra: 1 }]) {
      const payload = { ...command, operationId: randomUUID(), layout: invalid }
      expect(() => parseAccountRequest({ action: 'pos', businessId: person.businessId, operatorToken: person.token, ...payload })).toThrow()
      await expect(execute(person, payload as PosCommand)).rejects.toThrow('VALIDATION_ERROR')
    }
    const saved = await place(person, value, layout)
    expect(await execute(person, { ...command, operationId: randomUUID(), expectedRevision: saved.revision, layout: null })).toMatchObject({ layout: null })
  })
})

async function actor(existingBusiness?: string, permissions: string[] = []): Promise<Actor> {
  const role = existingBusiness ? 'cashier' : 'owner'
  const value = { userId: randomUUID(), sessionId: randomUUID(), businessId: existingBusiness ?? randomUUID(), employeeId: randomUUID(), token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2) }
  await db.query('insert into auth.users(id) values($1)', [value.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [value.sessionId, value.userId])
  if (!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Restaurante sintético','restaurant','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","paymentMethods":["cash"]}')`, [value.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [value.businessId, value.userId, role])
  await db.query('insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,\'Persona sintética\',$4,$5)', [value.employeeId, value.businessId, value.userId, role, permissions])
  await db.query('insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,\'sha256\'))', [value.businessId, value.userId, value.sessionId, value.token])
  if (existingBusiness) {
    await db.query('insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,\'hex\'),\'Navegador sintético\')', [value.businessId, value.employeeId, value.keyHash])
    await db.query('update app_private.operator_sessions set employee_device_key_hash=decode($1,\'hex\') where business_id=$2 and user_id=$3', [value.keyHash, value.businessId, value.userId])
  }
  return value
}
async function execute<T = unknown>(person: Actor, command: PosCommand): Promise<T> {
  const envelope = (await db.query<{ result: { data: T; error?: { code: string } } }>('select public.account_secure($1,$2,\'pos\',$3::jsonb,$4,$5) result', [person.userId, person.sessionId, JSON.stringify({ action: 'pos', businessId: person.businessId, operatorToken: person.token, ...command }), person.keyHash, randomUUID()])).rows[0].result
  if (envelope.error) throw new Error(envelope.error.code)
  return envelope.data
}
async function activate(person: Actor) { await execute(person, { command: 'activate_operations', operationId: randomUUID() }) }
async function table(person: Actor) { return execute<DiningTable>(person, { command: 'save_table', operationId: randomUUID(), tableId: randomUUID(), expectedRevision: null, name: 'Mesa sintética', active: true }) }
async function place(person: Actor, table: DiningTable, layout: TableLayout) { return execute<DiningTable>(person, { command: 'set_table_layout', operationId: randomUUID(), tableId: table.id, expectedRevision: table.revision, layout }) }
