import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { createPosDatabase } from './pos-fixture'
import { fixtureBusiness, fixtureOperatorToken, mockAccount } from './account-fixture'
import type { PointCheckout, PointCommand, PointResponses } from '../../src/lib/point-contracts'
import { verifiedDeviceRequest } from '../../supabase/functions/account/device-proof'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

/** Browser behavior uses real migrated SQL reservations/financial records; OAuth/provider transport is intercepted here.
 * The separately required loopback Auth/Edge/Postgres integration suite verifies the real HTTP adapter and worker.
 */
export async function mockPoint(page: Page, options: { state?: 'approved_verified' | 'rejected' | 'unknown_review' | 'processing'; startLoss?: boolean; refundLoss?: boolean; physicalPending?: boolean; admin?: boolean; enabled?: boolean } = {}) {
  const backend = await createPosDatabase()
  await backend.seed()
  const claims = JSON.parse(Buffer.from(backend.session.access_token.split('.')[1], 'base64url').toString())
  const connectionId = randomUUID(), terminalId = 'POINT-SYNTHETIC-01', calls: PointCommand[] = []
  let startLoss = options.startLoss ?? false, refundLoss = options.refundLoss ?? false, remoteCharges = 0
  await backend.db.query(`insert into app_private.point_settings(business_id,enabled) values($1,$2)`, [fixtureBusiness.id, options.enabled !== false])
  await backend.db.query(`insert into app_private.point_connections(id,business_id,receiver_id,environment,status,tokens_ciphertext,verified_at) values($1,$2,'synthetic-account','live','connected','ciphertext-browser-fixture',now())`, [connectionId, fixtureBusiness.id])
  await backend.db.query(`insert into app_private.point_terminals(business_id,id,connection_id,serial,branch_id,register_id,branch_name,register_name,mode,verified,active,physical_steps_pending,verified_at) values($1,$2,$3,'SN-SYNTHETIC-01','branch-01','register-01','Principal','Caja 1','PDV',$4,$4,$5,now())`, [fixtureBusiness.id, terminalId, connectionId, !options.physicalPending, Boolean(options.physicalPending)])
  await backend.db.query(`update app_private.businesses set profile=jsonb_set(profile,'{paymentMethods}','["cash","card_external","transfer","card_integrated"]') where id=$1`, [fixtureBusiness.id])
  if (options.admin) await backend.db.query(`insert into app_private.sasori_admins(user_id,granted_by,reason) values($1,$1,'Browser authorization fixture')`, [backend.session.user.id])
  await backend.execute({ command: 'activate_operations', operationId: randomUUID() })
  await backend.execute({ command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
  async function execute<C extends PointCommand['command']>(command: PointCommand & { command: C }): Promise<PointResponses[C]> {
    const result = await backend.db.query<{ result: { data: PointResponses[C] } }>("select public.account_secure($1,$2,'point',$3::jsonb) as result", [backend.session.user.id, claims.session_id, JSON.stringify({ action: 'point', businessId: fixtureBusiness.id, operatorToken: fixtureOperatorToken, ...command })])
    return result.rows[0].result.data
  }
  async function apply(checkoutId: string, state: string, refunds: { id: string; amountCents: number; confirmedAt: string }[] = []) {
    const checkout = await execute({ command: 'status', checkoutId })
    if (!checkout.attemptId) throw new Error('Point attempt absent')
    await backend.db.query(`select public.point_service('apply_order',$1::jsonb)`, [JSON.stringify({ attemptId: checkout.attemptId, amountCents: checkout.totalCents, currency: 'MXN', receiverId: 'synthetic-account', environment: 'live', externalReference: `sasori_${checkout.attemptId}`, remoteOrderId: `synthetic-order-${checkout.attemptId}`, paymentId: `synthetic-payment-${checkout.attemptId}`, state, statusDetail: state === 'unknown_review' ? 'action_required' : state === 'approved_verified' ? 'accredited' : state, observedAt: new Date().toISOString(), cancelCapability: state === 'processing' ? 'backend' : 'terminal', refunds })])
  }
  async function attach(target: Page) {
    await target.route('**/*', route => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient'))
    await mockAccount(target, {
      existingBusiness: true,
      sessionOverrides: backend.session,
      business: { ...fixtureBusiness, profile: { ...fixtureBusiness.profile, paymentMethods: ['cash', 'card_external', 'transfer', 'card_integrated'] } },
    })
    await target.route('http://127.0.0.1:54321/functions/v1/account', async route => {
      const raw = route.request().postDataJSON()
      if (raw?.action !== 'point' && raw?.action !== 'pos') return route.fallback()
      const reply = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({data}) })
      try {
        const body = parseAccountRequest((await verifiedDeviceRequest(raw)).request)
        if (body.action === 'pos') return reply(await backend.execute(body))
        if (body.action !== 'point') throw new Error('VALIDATION_ERROR')
        calls.push(body)
        if (body.command === 'resources') return reply({ branches: [{id: 'branch-01', name: 'Principal'}], registers: [{id: 'register-01', branchId: 'branch-01', name: 'Caja 1'}], terminals: (await execute({command:'settings'})).terminals })
        if (body.command === 'oauth_start') return reply({ authorizationUrl: `http://127.0.0.1:5174/point/callback?code=synthetic-code&state=synthetic-state`, expiresAt: new Date(Date.now()+300000).toISOString() })
        if (body.command === 'oauth_callback' || body.command === 'verify_connection') return reply(await execute({command:'settings'}))
        if (body.command === 'link_terminal') { await backend.db.query(`update app_private.point_terminals set branch_id=$2,register_id=$3,physical_steps_pending=true,verified=false where business_id=$1`, [fixtureBusiness.id,body.branchId,body.registerId]); return reply(await execute({command:'settings'})) }
        if (body.command === 'test_terminal') { await backend.db.query(`update app_private.point_terminals set mode='PDV',physical_steps_pending=false,verified=true,active=true where business_id=$1`, [fixtureBusiness.id]); return reply(await execute({command:'settings'})) }
        let result = await execute(body)
        if (body.command === 'start') {
          const checkout = result as PointCheckout
          remoteCharges = Number((await backend.db.query<{count:string}>(`select count(*)::text count from app_private.point_attempts`)).rows[0].count)
          await apply(checkout.id, options.state ?? 'approved_verified')
          result = await execute({ command: 'status', checkoutId: checkout.id })
          if (startLoss) { startLoss = false; return route.abort('failed') }
        }
        if (body.command === 'cancel') { const value = result as PointCheckout; if (value.attemptId) { await apply(value.id, 'cancelled'); result = await execute({command:'status',checkoutId:value.id}) } }
        if (body.command === 'refund') {
          const value = result as PointCheckout
          await apply(value.id, 'approved_verified', [{id:`refund-${body.operationId}`, amountCents:body.amountCents, confirmedAt:new Date().toISOString()}])
          result = await execute({command:'status',checkoutId:value.id})
          if (refundLoss) { refundLoss = false; return route.abort('failed') }
        }
        return reply(result)
      } catch (caught) { const code = caught instanceof Error && /^[A-Z_]+$/.test(caught.message) ? caught.message : 'SERVER_ERROR'; return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:{code,message:code}})}) }
    })
  }
  await attach(page)
  return {...backend, attach, calls, execute, apply, remoteCharges:()=>remoteCharges}
}
