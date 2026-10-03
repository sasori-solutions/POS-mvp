import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BusinessPermission, EmployeeCreation, OperatorSession } from '../../src/lib/contracts'
import type { Product, Sale } from '../../src/lib/pos-contracts'

let db: PGlite
const migration = '20261002001800_employee_permissions.sql'
type Actor = { userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string }
let legacy: Actor[]

describe('explicit employee grants in real PostgreSQL', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    const migrations = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort()
    for (const file of migrations.filter(file => file < migration)) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    const owner = await actor('owner')
    legacy = [owner, await actor('manager', owner.businessId), await actor('cashier', owner.businessId), await actor('kitchen', owner.businessId)]
    await db.exec(readFileSync(`supabase/migrations/${migration}`, 'utf8'))
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('migrates only existing effective rights without revoking operators or granting new capabilities', async () => {
    const expected = [[], ['catalog.read','catalog.manage','catalog.availability','sales.create','sales.read_own','sales.read_all'], ['catalog.read','catalog.availability','sales.create','sales.read_own'], []]
    for (const [index, person] of legacy.entries()) {
      const row = (await db.query<{ permissions: BusinessPermission[] }>('select permissions from app_private.employees where id=$1', [person.employeeId])).rows[0]
      expect(row.permissions).toEqual(expected[index])
      const context = await account<{ business: { permissions: BusinessPermission[] } }>(person, 'context', args(person))
      expect(context.business.permissions).not.toContain(index ? 'orders.manage' : 'unknown')
      expect(await permission(person, 'orders.manage')).toBe(index === 0)
    }
    expect(await account(legacy[1], 'pos', { ...args(legacy[1]), command: 'catalog' })).toHaveProperty('products')
    expect(await account(legacy[2], 'pos', { ...args(legacy[2]), command: 'catalog' })).toHaveProperty('products')
    await expect(account(legacy[3], 'pos', { ...args(legacy[3]), command: 'catalog' })).rejects.toThrow('PERMISSION_DENIED')
  })

  it('keeps owner implicit all and rejects staff role fallback, foreign tenants and unknown grants', async () => {
    const owner = await actor('owner')
    const manager = await actor('manager', owner.businessId, [])
    const kitchen = await actor('kitchen', owner.businessId, ['catalog.read', 'catalog.manage'])
    for (const key of ['sales.create','cash.close','tables.manage']) expect(await permission(owner,key)).toBe(true)
    expect(await permission(owner, 'unknown')).toBe(false)
    expect(await permission(manager, 'catalog.manage')).toBe(false)
    await expect(account(manager, 'pos', {...args(manager),command:'catalog'})).rejects.toThrow('PERMISSION_DENIED')
    expect(await account(kitchen, 'pos', {...args(kitchen),command:'catalog'})).toHaveProperty('products')
    expect(await product(kitchen)).toHaveProperty('id')
    expect((await db.query<{allowed:boolean}>('select app_private.has_permission($1,$2,$3) allowed',[randomUUID(),kitchen.employeeId,'catalog.read'])).rows[0].allowed).toBe(false)
    for (const values of [['unknown'],['catalog.read','catalog.read'],['owner'],['catalog.manage'],['sales.discount','sales.create'],['orders.cancel'],['kitchen.operate'],['cash.close'],[null],{},'catalog.read']) await expect(db.query('select app_private.validate_employee_permissions($1::jsonb)',[JSON.stringify(values)])).rejects.toThrow('VALIDATION_ERROR')
    for (const role of ['anon','authenticated']) {
      expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'app_private.has_permission(uuid,uuid,text)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false)
      expect((await db.query<{allowed:boolean}>("select has_table_privilege($1,'app_private.employees','UPDATE') allowed",[role])).rows[0].allowed).toBe(false)
    }
  })

  it('authorizes only owners to edit grants and revokes every personal and device operator', async () => {
    const owner = await actor('owner'), other = await actor('owner')
    const staff = await actor('cashier', owner.businessId, ['catalog.read','sales.create','sales.read_own'])
    const secondAuth = randomUUID(), deviceId = randomUUID(), deviceToken = 'ba'.repeat(32)
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[secondAuth,staff.userId])
    await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))",[staff.businessId,staff.userId,secondAuth,'ab'.repeat(32),staff.keyHash])
    await db.query("insert into app_private.devices(id,business_id,name,register_name,token_hash) values($1,$2,'Caja sintética','Caja',extensions.digest($3,'sha256'))",[deviceId,staff.businessId,deviceToken])
    await db.query("insert into app_private.device_operator_sessions(business_id,device_id,employee_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))",[staff.businessId,deviceId,staff.employeeId,'cb'.repeat(32)])
    const update = {...args(owner),employeeId:staff.employeeId,name:'Persona sintética',role:'cashier',active:true,pin:null,permissions:['sales.read_own']}
    await expect(account(staff,'update_employee',{...update,...args(staff)})).rejects.toThrow('PERMISSION_DENIED')
    await expect(account(other,'update_employee',{...update,...args(other)})).rejects.toThrow('BUSINESS_ACCESS_DENIED')
    await expect(account(owner,'update_employee',{...update,employeeId:owner.employeeId})).rejects.toThrow('PERMISSION_DENIED')
    expect(await account(owner,'update_employee',update)).toMatchObject({permissions:['sales.read_own']})
    expect((await db.query<{live:number}>('select count(*)::integer live from app_private.operator_sessions where business_id=$1 and user_id=$2 and revoked_at is null',[staff.businessId,staff.userId])).rows[0].live).toBe(0)
    expect((await db.query<{live:number}>('select count(*)::integer live from app_private.device_operator_sessions where business_id=$1 and employee_id=$2 and revoked_at is null',[staff.businessId,staff.employeeId])).rows[0].live).toBe(0)
    await expect(account(staff,'context',args(staff))).rejects.toThrow('SESSION_INVALID')
  })

  it('checks current grants before accepted sale replay and keeps the original sale immutable', async () => {
    const owner = await actor('owner'), staff = await actor('cashier',owner.businessId,['catalog.read','sales.create','sales.read_own'])
    const item = await product(owner)
    const command = {command:'complete_sale',operationId:randomUUID(),paymentMethod:'cash',totalCents:item.priceCents,items:[{productId:item.id,version:item.version,quantity:1,unitPriceCents:item.priceCents}]}
    const sale = await account<Sale>(staff,'pos',{...args(staff),...command})
    expect(await account(staff,'pos',{...args(staff),...command})).toEqual(sale)
    await account(owner,'update_employee',{...args(owner),employeeId:staff.employeeId,name:'Persona sintética',role:'cashier',active:true,pin:null,permissions:['sales.read_own']})
    await expect(account(staff,'pos',{...args(staff),...command})).rejects.toThrow('SESSION_INVALID')
    await expect(db.query('select app_private.pos_command($1,$2,$3::jsonb)',[staff.businessId,staff.employeeId,JSON.stringify(command)])).rejects.toThrow('PERMISSION_DENIED')
    expect((await db.query<{count:number}>('select count(*)::integer count from app_private.sales where business_id=$1',[staff.businessId])).rows[0].count).toBe(1)
    expect(await account(owner,'pos',{...args(owner),command:'sale',saleId:sale.id})).toEqual(sale)
  })

  it('binds chosen grants to creation retries and uses the current employee grants for invitation details and acceptance', async () => {
    const owner = await actor('owner'), joiner = await identity()
    const create = {...args(owner),name:'Persona invitada',role:'manager',permissions:['catalog.read','orders.read'],pin:null,inviteWithGoogle:true,operationId:randomUUID()}
    const employee = await account<EmployeeCreation>(owner,'create_employee',create)
    expect(employee).toMatchObject({role:'cashier',permissions:['catalog.read','orders.read']})
    expect((await account<EmployeeCreation>(owner,'create_employee',{...create,permissions:['orders.read','catalog.read']})).id).toBe(employee.id)
    await expect(account(owner,'create_employee',{...create,permissions:['catalog.read']})).rejects.toThrow('OPERATION_CONFLICT')
    await account(owner,'update_employee',{...args(owner),employeeId:employee.id,name:employee.name,role:'cashier',active:true,pin:null,permissions:['kitchen.read']})
    const refreshed = await account<EmployeeCreation>(owner,'create_employee',create)
    expect(refreshed.permissions).toEqual(['kitchen.read'])
    const invitationCode = refreshed.invitation!.invitationCode
    const details = await account<{employee:{permissions:BusinessPermission[]}}>(joiner,'invitation_details',{invitationCode})
    expect(details.employee.permissions).toEqual(['kitchen.read'])
    const acceptance = {invitationCode,pin:'024680',operationId:randomUUID(),deviceName:'Navegador sintético'}
    const joined = await account<OperatorSession>(joiner,'accept_invitation',acceptance)
    expect(joined.business.permissions).toEqual(['kitchen.read'])
    expect(joined.business.employee?.id).toBe(employee.id)
    await account(owner,'update_employee',{...args(owner),employeeId:employee.id,name:employee.name,role:'cashier',active:true,pin:null,permissions:[]})
    const retried = await account<OperatorSession>(joiner,'accept_invitation',acceptance)
    expect(retried.business.permissions).toEqual([])
    expect(await account<EmployeeCreation>(owner,'create_employee',{...args(owner),name:'Legacy sin permisos',role:'manager',pin:null,inviteWithGoogle:true,operationId:randomUUID()})).toMatchObject({role:'cashier',permissions:[]})
  })
})

async function identity(): Promise<Actor> {
  const person = {userId:randomUUID(),sessionId:randomUUID(),businessId:randomUUID(),employeeId:randomUUID(),token:randomUUID().replaceAll('-','').repeat(2),keyHash:randomUUID().replaceAll('-','').repeat(2)}
  await db.query('insert into auth.users(id) values($1)',[person.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[person.sessionId,person.userId])
  return person
}
async function actor(role = 'owner', existingBusiness?:string, permissions?: BusinessPermission[]) {
  const person = await identity()
  person.businessId = existingBusiness ?? person.businessId
  if(!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,'Negocio sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja","paymentMethods":["cash"]}')`,[person.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)',[person.businessId,person.userId,role])
  if(permissions) await db.query("insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,'Persona sintética',$4,$5)",[person.employeeId,person.businessId,person.userId,role,permissions])
  else await db.query("insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Persona sintética',$4)",[person.employeeId,person.businessId,person.userId,role])
  await db.query("insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash,employee_device_key_hash) values($1,$2,$3,extensions.digest($4,'sha256'),decode($5,'hex'))",[person.businessId,person.userId,person.sessionId,person.token,person.keyHash])
  if(role!=='owner') await db.query("insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name) values($1,$2,decode($3,'hex'),'Navegador sintético')",[person.businessId,person.employeeId,person.keyHash])
  return person
}
function args(person:Actor) {return {businessId:person.businessId,operatorToken:person.token}}
async function account<T=unknown>(person:Actor,action:string,payload:object):Promise<T> {
  const result = (await db.query<{result:{data:T;error?:{code:string}}}>("select public.account_secure($1,$2,$3,$4::jsonb,$5,$6) result",[person.userId,person.sessionId,action,JSON.stringify({action,...payload}),person.keyHash,randomUUID()])).rows[0].result
  if(result.error) throw new Error(result.error.code)
  return result.data
}
async function permission(person:Actor,key:string) {return (await db.query<{allowed:boolean}>('select app_private.has_permission($1,$2,$3) allowed',[person.businessId,person.employeeId,key])).rows[0].allowed}
async function product(person:Actor) {return account<Product>(person,'pos',{...args(person),command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Café sintético',category:'Café',priceCents:1001})}
