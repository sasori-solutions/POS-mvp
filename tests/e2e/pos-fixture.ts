import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import type { Page } from '@playwright/test'
import { fixtureAuthSession, fixtureBusiness, fixtureOperatorToken, mockAccount } from './account-fixture'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { verifiedDeviceRequest } from '../../supabase/functions/account/device-proof'
import type { PosCommand, Product, Sale } from '../../src/lib/pos-contracts'

export const seedProducts = [
  { name: 'Latte', category: 'Café', priceCents: 5800 },
  { name: 'Americano', category: 'Café', priceCents: 4000 },
  { name: 'Capuchino', category: 'Café', priceCents: 5800 },
  { name: 'Té negro', category: 'Café', priceCents: 3500 },
  { name: 'Sándwich', category: 'Comida', priceCents: 11600 },
  { name: 'Croissant', category: 'Panadería', priceCents: 4800 },
  { name: 'Espresso', category: 'Café', priceCents: 3500 },
  { name: 'Chocolate', category: 'Café', priceCents: 5500 },
  { name: 'Panqué', category: 'Panadería', priceCents: 4500 },
]

/** Actual migrations/RPCs with synthetic Auth rows. Browser OAuth stays network-intercepted. */
export async function createPosDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`create schema auth; create schema extensions; create role anon; create role authenticated; create role service_role;
    create table auth.users(id uuid primary key); create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz default now(),not_after timestamptz);`)
  for (const file of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  const session = fixtureAuthSession()
  const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString())
  const employeeId = 'b1d6d131-729c-4eab-90f3-328044b164ce'
  await db.query('insert into auth.users(id) values($1)', [session.user.id])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [claims.session_id, session.user.id])
  await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile) values($1,$2,'cafe','America/Mexico_City','{"paymentMethods":["cash","card_external","transfer"],"branchName":"Principal","registerName":"Caja 1"}')`, [fixtureBusiness.id, fixtureBusiness.name])
  await db.query(`insert into app_private.business_memberships(business_id,user_id) values($1,$2)`, [fixtureBusiness.id, session.user.id])
  await db.query(`insert into app_private.employees(id,business_id,user_id,name,role) values($1,$2,$3,'Dueño sintético','owner')`, [employeeId, fixtureBusiness.id, session.user.id])
  await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash) values($1,$2,$3,extensions.digest($4,'sha256'))`, [fixtureBusiness.id, session.user.id, claims.session_id, fixtureOperatorToken])
  async function execute<T>(command: PosCommand): Promise<T> {
    return (await db.query<{ result: { data: T } }>("select public.account_secure($1,$2,'pos',$3::jsonb) as result", [session.user.id, claims.session_id, JSON.stringify({ action: 'pos', businessId: fixtureBusiness.id, operatorToken: fixtureOperatorToken, ...command })])).rows[0].result.data
  }
  async function seed() {
    for (const product of seedProducts) await execute({ command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, ...product })
  }
  return { db, session, execute, seed }
}

export async function mockPos(page: Page, options: { empty?: boolean; saleResponseLosses?: number; productResponseLosses?: number; deletionResponseLosses?: number; delayDeletionMs?: number; delaySaleMs?: number; catalogFailures?: number } = {}) {
  const backend = await createPosDatabase()
  if (!options.empty) await backend.seed()
  const calls: PosCommand[] = []
  let saleLosses = options.saleResponseLosses ?? 0
  let productLosses = options.productResponseLosses ?? 0
  let deletionLosses = options.deletionResponseLosses ?? 0
  let catalogFailures = options.catalogFailures ?? 0
  async function attach(page: Page) {
    await page.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient'))
    await mockAccount(page, { existingBusiness: true })
    await page.route('http://127.0.0.1:54321/functions/v1/account', async route => {
      const body = route.request().postDataJSON()
      if (body?.action !== 'pos') return route.fallback()
      const reject = (status: number, code: string) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message: 'Synthetic API response' } }) })
      try {
        const parsed = parseAccountRequest((await verifiedDeviceRequest(body)).request)
        if (parsed.action !== 'pos') return reject(400, 'VALIDATION_ERROR')
        calls.push(parsed)
        if (parsed.command === 'catalog' && catalogFailures-- > 0) return reject(500, 'SERVER_ERROR')
        if (parsed.command === 'complete_sale' && options.delaySaleMs) await new Promise(resolve => setTimeout(resolve, options.delaySaleMs))
        if (parsed.command === 'delete_product' && options.delayDeletionMs) await new Promise(resolve => setTimeout(resolve, options.delayDeletionMs))
        const data = await backend.execute(parsed)
        if (parsed.command === 'complete_sale' && saleLosses-- > 0) return route.abort('failed')
        if (parsed.command === 'save_product' && productLosses-- > 0) return route.abort('failed')
        if (parsed.command === 'delete_product' && deletionLosses-- > 0) return route.abort('failed')
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) })
      } catch (caught) {
        const code = caught instanceof Error ? caught.message : 'SERVER_ERROR'
        return reject(code === 'PRODUCT_CHANGED' || code === 'PRODUCT_UNAVAILABLE' ? 409 : 400, /^[A-Z_]+$/.test(code) ? code : 'SERVER_ERROR')
      }
    })
  }
  await attach(page)
  return { ...backend, attach, calls, catalog: () => backend.execute<{ products: Product[] }>({ command: 'catalog' }), sales: () => backend.execute<{ sales: Sale[] }>({ command: 'sales', cursor: null }) }
}
