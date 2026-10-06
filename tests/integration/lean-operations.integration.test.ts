import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessPermissions, type BusinessPermission, type OperatorSession } from '../../src/lib/contracts'
import { emptyDetails } from '../../src/lib/product-details'
import type { PosCommand, Product, Sale } from '../../src/lib/pos-contracts'
import type { BalanceWaiver, BusinessDayReport, BusinessPeriodReport, CashShift, CheckoutAttempt, DiningTable, KitchenBatch, OperationalOrder, OperationsSnapshot, OrderInputLine } from '../../src/lib/operations-contracts'
import { businessDate } from '../../src/lib/reporting'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import { signedRequest } from './device-proof-fixture'

type Identity = { userId: string; token: string }
type Actor = { identity: Identity; operator: OperatorSession }
type Reply<T> = { status: number; body: { data?: T; error?: { code: string } } }
const config = localConfig()
const users: string[] = [], businesses: string[] = []
const pin = '583927', employeePin = '024680'
let admin: SupabaseClient, ownerIdentity: Identity, staffIdentity: Identity

describe.skipIf(!config)('lean operations through real Auth/Edge and simultaneous PostgreSQL connections', () => {
  beforeAll(async () => {
    admin = client(config!.serviceRoleKey)
    ;[ownerIdentity, staffIdentity] = await Promise.all([identity(), identity()])
    expect(sql("select to_regclass('app_private.checkout_attempts') is not null;").trim()).toBe('t')
    expect((await call(ownerIdentity, { action:'status' })).status).toBe(200)
  },60_000)
  afterAll(async () => {
    if (businesses.length) sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`)
    for (const id of users) {
      const {error} = await admin.auth.admin.deleteUser(id)
      if (error) throw error
    }
  },60_000)

  it('persists the three kitchen stages through signed HTTP without changing the confirmed payment', async () => {
    const { owner, staff } = await fixture(['kitchen.read', 'kitchen.operate'])
    const order = await createOrder(owner)
    const receipt = await payAll(owner, order)
    const batch = (await kitchen(staff)).find(item => item.orderId === order.id)!
    expect(batch.status).toBe('queued')
    const before = data(await pos<BusinessDayReport>(owner, { command: 'report', date: businessDate(owner.operator.business.timezone) }))
    const command = { command: 'set_kitchen_status' as const, operationId: randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'preparing' as const }
    const preparing = data(await pos<KitchenBatch>(staff, command))
    expect(preparing).toMatchObject({ status: 'preparing', revision: batch.revision + 1 })
    expect((await kitchen(owner)).find(item => item.id === batch.id)).toEqual(preparing)
    const delivered = data(await pos<KitchenBatch>(staff, { ...command, operationId: randomUUID(), expectedRevision: preparing.revision, status: 'delivered' }))
    expect(delivered.status).toBe('delivered')
    expect(data(await pos(staff, command))).toEqual(preparing)
    expect(await pos(staff, { ...command, operationId: randomUUID(), expectedRevision: delivered.revision })).toMatchObject({ status: 409, body: { error: { code: 'BATCH_CHANGED' } } })
    expect(data(await pos<BusinessDayReport>(owner, { command: 'report', date: businessDate(owner.operator.business.timezone) }))).toEqual(before)
    expect(data(await pos<Sale>(owner, { command: 'sale', saleId: receipt.saleId! })).totalCents).toBe(receipt.totalCents)
    expect(count(owner, 'sales')).toBe(1)
  }, 45_000)

  it('prepares an unpaid restaurant account before collection and never duplicates its batch on payment or replay', async () => {
    const { owner, staff } = await fixture(['catalog.read', 'sales.create', 'orders.read', 'orders.manage', 'kitchen.read', 'kitchen.operate'])
    const order = data(await pos<OperationalOrder>(staff, { command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, orderKind: 'service', name: 'Mostrador', tableId: null, items: [input(await product(owner), 2)] }))
    expect(count(owner, 'sales')).toBe(0)
    expect(order).toMatchObject({ orderKind: 'service', status: 'open', phase: 'service', paidCents: 0, balanceCents: 2002, items: [{ sentQuantity: 0, paidQuantity: 0 }] })
    const send = { command: 'send_order' as const, operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision }
    const discarded = await raw(staff.identity, { action: 'pos', ...args(staff), ...send })
    expect(discarded.status).toBe(200)
    await discarded.body?.cancel()
    const sent = data(await pos<OperationalOrder>(staff, send))
    expect(sent).toMatchObject({ phase: 'service', status: 'open', paidCents: 0, balanceCents: 2002, items: [{ sentQuantity: 2, paidQuantity: 0 }] })
    const batches = (await kitchen(staff)).filter(batch => batch.orderId === order.id)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ status: 'queued', items: [{ quantity: 2 }] })
    let batch = data(await pos<KitchenBatch>(staff, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: batches[0].id, expectedRevision: batches[0].revision, status: 'preparing' }))
    batch = data(await pos<KitchenBatch>(staff, { command: 'set_kitchen_status', operationId: randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'delivered' }))
    expect(data(await pos(owner, { command: 'order', orderId: order.id }))).toEqual(sent)
    expect(count(owner, 'sales')).toBe(0)
    expect(count(owner, 'checkout_attempts')).toBe(0)
    const checkout = await checkoutPhase(staff, sent)
    const reserved = await prepare(staff, checkout)
    const started = data(await pos<CheckoutAttempt>(staff, { command: 'start_checkout', operationId: randomUUID(), attemptId: reserved.id, expectedRevision: reserved.revision }))
    const payment = confirmation(started)
    const receipt = data(await pos<CheckoutAttempt>(staff, payment))
    expect(receipt).toMatchObject({ status: 'completed', totalCents: 2002 })
    expect(data(await pos(staff, payment))).toEqual(receipt)
    expect(data(await pos(staff, send))).toEqual(sent)
    expect(count(owner, 'sales')).toBe(1)
    expect((await kitchen(staff)).filter(item => item.orderId === order.id)).toEqual([batch])
    expect(data(await pos(owner, { command: 'order', orderId: order.id }))).toMatchObject({ status: 'paid', paidCents: 2002, balanceCents: 0, items: [{ sentQuantity: 2, paidQuantity: 2 }] })
  }, 45_000)

  it('persists a direct counter across fresh actor reads and exact retries without allowing service reclassification', async () => {
    const { owner, staff } = await fixture(['catalog.read', 'sales.create'])
    const command = { command: 'save_order' as const, operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, orderKind: 'counter' as const, name: 'Venta directa', tableId: null, items: [input(await product(owner))] }
    const discarded = await raw(staff.identity, { action: 'pos', ...args(staff), ...command })
    expect(discarded.status).toBe(200)
    await discarded.body?.cancel()
    const saved = data(await pos<OperationalOrder>(staff, command))
    expect(saved).toMatchObject({ orderKind: 'counter', balanceCents: 1001, paidCents: 0 })
    for (let reload = 0; reload < 3; reload++) {
      expect(data(await pos<OperationalOrder>(staff, { command: 'order', orderId: saved.id }))).toEqual(saved)
      expect(data(await pos<OperationsSnapshot>(staff, { command: 'operations' })).orders.find(order => order.id === saved.id)).toEqual(saved)
      expect(data(await pos<OperationalOrder>(owner, { command: 'order', orderId: saved.id }))).toEqual(saved)
    }
    expect((await pos(owner, { command: 'send_order', operationId: randomUUID(), orderId: saved.id, expectedRevision: saved.revision })).body.error?.code).toBe('PERMISSION_DENIED')
    expect((await pos(staff, { ...command, operationId: randomUUID(), orderId: randomUUID(), orderKind: 'service', name: 'Mostrador' })).body.error?.code).toBe('PERMISSION_DENIED')
    const edited = data(await pos<OperationalOrder>(staff, { command: 'save_order', operationId: randomUUID(), orderId: saved.id, expectedRevision: saved.revision, name: 'Nombre editable', tableId: null, items: command.items }))
    expect(edited.orderKind).toBe('counter')
    expect((await pos(owner, { ...command, operationId: randomUUID(), expectedRevision: edited.revision, orderKind: 'service' })).body.error?.code).toBe('ORDER_CHANGED')
    expect(count(owner, 'sales')).toBe(0)
    const receipt = await payAll(staff, edited)
    expect(receipt).toMatchObject({ status: 'completed', totalCents: 1001 })
    expect(data(await pos(staff, command))).toEqual(saved)
    expect(data(await pos<OperationalOrder>(owner, { command: 'order', orderId: saved.id }))).toMatchObject({ orderKind: 'counter', paidCents: 1001, balanceCents: 0, status: 'paid' })
    expect(count(owner, 'sales')).toBe(1)
  }, 45_000)

  it('collects a catalog-free amount through signed HTTP with exact replay, VAT, receipt and refund snapshots', async () => {
    const { owner, staff } = await fixture(['catalog.read', 'sales.create', 'sales.read_all', 'sales.reverse', 'reports.read'])
    data(await call(owner.identity, { action: 'update_business', ...args(owner), name: owner.operator.business.name, businessType: owner.operator.business.businessType,
      timezone: owner.operator.business.timezone, profile: { ...owner.operator.business.profile, defaultVatTreatment: 'vat_16' } }))
    const line: OrderInputLine = { lineId: randomUUID(), kind: 'amount', name: 'Servicio sintético', quantity: 1, unitPriceCents: 1001, note: '' }
    const save = { command: 'save_order' as const, operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null, orderKind: 'counter' as const, name: 'Importe directo', tableId: null, items: [line] }
    const catalogBefore = data(await pos<{ products: Product[] }>(owner, { command: 'catalog' }))
    for (const invalid of [{ unitPriceCents: 0 }, { unitPriceCents: 1001.5 }, { productId: randomUUID() }, { selection: {} }, { version: 1 }]) {
      const reply = await call(staff.identity, { action: 'pos', ...args(staff), ...save, operationId: randomUUID(), items: [{ ...line, ...invalid }] })
      expect(reply).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_ERROR' } } })
    }
    const discarded = await raw(staff.identity, { action: 'pos', ...args(staff), ...save })
    expect(discarded.status).toBe(200); await discarded.body?.cancel()
    let order = data(await pos<OperationalOrder>(staff, save))
    expect(order.items[0]).toMatchObject({ kind: 'amount', productId: null, name: line.name, totalCents: 1001, taxCents: 138, sentQuantity: 0, taxTreatment: 'vat_16' })
    expect(data(await pos(owner, { command: 'catalog' }))).toEqual(catalogBefore)
    order = await checkoutPhase(staff, order)
    const quote = await prepare(staff, order)
    const record = { command: 'record_checkout' as const, operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true as const }
    const [first, second] = await Promise.all([pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(staff, record), pos<{ order: OperationalOrder; attempt: CheckoutAttempt }>(staff, record)])
    expect(data(first)).toEqual(data(second))
    const paid = data(first)
    expect(paid.order).toMatchObject({ paidCents: 1001, balanceCents: 0, items: [{ sentQuantity: 0, paidQuantity: 1 }] })
    expect((await kitchen(owner)).filter(batch => batch.orderId === order.id)).toEqual([])
    expect(count(owner, 'sales')).toBe(1)
    const receipt = data(await pos<Sale>(staff, { command: 'sale', saleId: paid.attempt.saleId! }))
    expect(receipt.items).toMatchObject([{ kind: 'amount', productId: null, name: line.name, unitPriceCents: 1001, totalCents: 1001, taxCents: 138 }])
    const reversal = data(await pos<CheckoutAttempt>(staff, { command: 'prepare_reversal', operationId: randomUUID(), saleId: receipt.id, reason: 'Corrección sintética' }))
    const started = data(await pos<CheckoutAttempt>(staff, { command: 'start_checkout', operationId: randomUUID(), attemptId: reversal.id, expectedRevision: reversal.revision }))
    const reversed = data(await pos<CheckoutAttempt>(staff, confirmation(started)))
    expect(reversed.items[0]).toMatchObject({ kind: 'amount', productId: null, name: line.name, totalCents: 1001, taxCents: 138 })
    const report = data(await pos<BusinessDayReport>(owner, { command: 'report', date: businessDate(owner.operator.business.timezone) }))
    expect(report).toMatchObject({ salesCents: 1001, reversalCents: 1001, netCents: 0, taxCents: 138 })
    expect(report.products).toMatchObject([{ kind: 'amount', productId: null, name: 'Importe libre', salesCents: 1001, reversalCents: 1001, netCents: 0 }])
  }, 45_000)

  it('collects an amount plan through signed Auth/Edge with duplicate taps and exact remaining balance',async()=>{
    const {owner,staff}=await fixture(['catalog.read','sales.create'])
    const product=data(await pos<Product>(owner,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Consumo por importe sintético',category:'',priceCents:76068,details:{...emptyDetails(),taxBps:1600,taxTreatment:'vat_16'}}))
    let order=data(await pos<OperationalOrder>(staff,{command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,orderKind:'counter',name:'Venta directa',tableId:null,items:[input(product)]}))
    order=await checkoutPhase(staff,order)
    expect(await pos(staff,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:[0,76068],paymentMethod:'cash'})).toMatchObject({status:400,body:{error:{code:'VALIDATION_ERROR'}}})
    const parts=[50000,4000,22068]
    for(let n=0;n<parts.length;n++) {
      const quote=data(await pos<CheckoutAttempt>(staff,{command:'prepare_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:[],amountsCents:parts.slice(n),paymentMethod:n===1?'transfer':'cash'}))
      expect(data(await pos<OperationalOrder>(staff,{command:'order',orderId:order.id})).balanceCents).toBe(order.balanceCents)
      const command={command:'record_checkout' as const,operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true as const}
      if(n===1) {
        const discarded=await raw(staff.identity,{action:'pos',...args(staff),...command})
        expect(discarded.status).toBe(200)
        await discarded.body?.cancel()
      }
      const [first,repeated]=await Promise.all([pos<{order:OperationalOrder;attempt:CheckoutAttempt}>(staff,command),pos<{order:OperationalOrder;attempt:CheckoutAttempt}>(staff,command)])
      const paid=data(first)
      expect(data(repeated)).toEqual(paid)
      expect(paid.order.balanceCents).toBe(order.balanceCents-parts[n])
      order=paid.order
      expect(order.amountParts).toEqual(parts.slice(n+1))
    }
    expect(order).toMatchObject({orderKind:'counter',status:'closed',balanceCents:0,paidCents:76068})
    expect(count(owner,'sales')).toBe(3)
    const report=data(await pos<BusinessDayReport>(owner,{command:'report',date:businessDate(owner.operator.business.timezone)}))
    expect(report).toMatchObject({salesCents:76068,grossCents:76068,taxCents:order.taxCents})
  },45_000)

  it('serves period analytics through signed Auth/Edge with exact totals, tenant isolation and revoked grants', async () => {
    const {owner,staff} = await fixture(['reports.read'])
    const order = await createOrder(owner)
    await payAll(owner, order)
    const date = businessDate(owner.operator.business.timezone)
    const command = { command: 'report_period' as const, date, period: 'day' as const }
    const daily = data(await pos<BusinessDayReport>(owner, { command: 'report', date }))
    const current = data(await pos<BusinessPeriodReport>(staff, command))
    expect(current.totals).toEqual(daily)
    expect(current.totals).toMatchObject({ salesCents: 1001, saleCount: 1 })
    expect(current.series.reduce((sum, point) => sum + point.salesCents, 0)).toBe(1001)
    expect(current.cutoff).toBe(current.asOf)
    expect(current.previousSeries.length).toBeGreaterThan(0)
    for (const field of ['salesCents', 'reversalCents', 'netCents', 'saleCount'] as const) {
      expect(current.series.reduce((sum, point) => sum + point[field], 0)).toBe(current.totals[field])
      expect(current.previousSeries.reduce((sum, point) => sum + point[field], 0)).toBe(current.previous[field])
    }
    expect(current.series.every(point => point.slot.startsWith('hour:') && new Date(point.end) > new Date(point.start))).toBe(true)
    expect(current).toMatchObject({ partial: true, comparisonComparable: true })
    const week = data(await pos<BusinessPeriodReport>(owner, { ...command, period: 'week' }))
    expect(week.series).toHaveLength(7)
    expect(week.totals.salesCents).toBe(1001)
    expect((await pos(staff, { ...command, period: 'year' } as unknown as PosCommand)).status).toBe(400)
    const other = await fixture([])
    expect(data(await pos<BusinessPeriodReport>(other.owner, command)).totals.salesCents).toBe(0)
    expect(await call(staff.identity, { action: 'pos', ...args(staff), businessId: other.owner.operator.business.id, ...command })).toMatchObject({status:401,body:{error:{code:'SESSION_INVALID'}}})
    const employee = staff.operator.business.employee!
    data(await call(owner.identity, { action: 'update_employee', ...args(owner), employeeId: employee.id, name: employee.name, role: 'cashier', active: true, pin: null, permissions: [] }))
    expect(await pos(staff, command)).toMatchObject({status:401,body:{error:{code:'SESSION_INVALID'}}})
    const fresh=data(await call<OperatorSession>(staff.identity,{action:'unlock',businessId:owner.operator.business.id,pin:employeePin}))
    expect(await pos({...staff,operator:fresh},command)).toMatchObject({status:403,body:{error:{code:'PERMISSION_DENIED'}}})
  }, 45_000)

  it('serves personal metrics through Auth/Edge by immutable employee ID with refunds, isolation and revocation', async () => {
    const grants: BusinessPermission[] = ['catalog.read', 'sales.create', 'orders.read', 'orders.manage', 'reports.read_own']
    const { owner, staff } = await fixture(grants)
    const firstEmployee = staff.operator.business.employee!
    const secondIdentity = await identity()
    const invitation = data(await call<{ invitation: { invitationCode: string } }>(owner.identity, {
      action: 'create_employee', ...args(owner), name: firstEmployee.name, role: 'cashier', permissions: grants,
      pin: null, inviteWithGoogle: true, operationId: randomUUID(),
    }))
    const second: Actor = { identity: secondIdentity, operator: data(await call<OperatorSession>(secondIdentity, {
      action: 'accept_invitation', invitationCode: invitation.invitation.invitationCode, pin: employeePin, operationId: randomUUID(),
    })) }
    expect(second.operator.business.employee!.name).toBe(firstEmployee.name)
    expect(second.operator.business.employee!.id).not.toBe(firstEmployee.id)
    const item = await product(owner)
    const ownReceipt = await payAll(staff, await createOrder(staff, [input(item)]))
    await payAll(second, await createOrder(second, [input(item, 3)]))
    expect(sql(`select employee_id from app_private.sales where business_id=${uuid(owner.operator.business.id)} and id=${uuid(ownReceipt.saleId!)};`).trim()).toBe(firstEmployee.id)
    const command = { command: 'report_own_period' as const, date: businessDate(owner.operator.business.timezone), period: 'day' as const }
    const personal = data(await pos<BusinessPeriodReport>(staff, command))
    expect(personal.totals).toMatchObject({ salesCents: 1001, saleCount: 1, reversalCents: 0, netCents: 1001, operators: [], cashDifferences: [] })
    expect(personal.totals.products).toMatchObject([{ productId: item.id, quantity: 1, salesCents: 1001 }])
    expect(personal.series.reduce((sum, point) => sum + point.salesCents, 0)).toBe(1001)
    expect(data(await pos<BusinessPeriodReport>(second, command)).totals.salesCents).toBe(3003)
    expect(await pos(staff, { ...command, command: 'report_period' })).toMatchObject({ status: 403, body: { error: { code: 'PERMISSION_DENIED' } } })
    for (const selector of [{ employeeId: second.operator.business.employee!.id }, { operatorName: firstEmployee.name }, { scope: 'business' }]) {
      expect(await pos(staff, { ...command, ...selector } as PosCommand)).toMatchObject({ status: 400, body: { error: { code: 'VALIDATION_ERROR' } } })
    }
    let refund = data(await pos<CheckoutAttempt>(owner, { command: 'prepare_reversal', operationId: randomUUID(), saleId: ownReceipt.saleId!, reason: 'Devolución de venta propia sintética' }))
    refund = data(await pos<CheckoutAttempt>(owner, { command: 'start_checkout', operationId: randomUUID(), attemptId: refund.id, expectedRevision: refund.revision }))
    data(await pos(owner, confirmation(refund)))
    const afterRefund = data(await pos<BusinessPeriodReport>(staff, command))
    expect(afterRefund.totals).toMatchObject({ salesCents: 1001, reversalCents: 1001, netCents: 0 })
    expect(afterRefund.series.reduce((sum, point) => sum + point.reversalCents, 0)).toBe(1001)
    expect(data(await pos<BusinessPeriodReport>(owner, command)).totals.reversalCents).toBe(0)
    expect(data(await pos<BusinessPeriodReport>(second, command)).totals).toMatchObject({ salesCents: 3003, reversalCents: 0, netCents: 3003 })
    const other = await fixture([])
    expect(await call(staff.identity, { action: 'pos', ...args(staff), businessId: other.owner.operator.business.id, ...command })).toMatchObject({ status: 401, body: { error: { code: 'SESSION_INVALID' } } })
    data(await call(owner.identity, { action: 'update_employee', ...args(owner), employeeId: firstEmployee.id, name: firstEmployee.name, role: 'cashier', active: true, pin: null, permissions: [] }))
    expect(await pos(staff, command)).toMatchObject({ status: 401, body: { error: { code: 'SESSION_INVALID' } } })
    const fresh = data(await call<OperatorSession>(staff.identity, { action: 'unlock', businessId: owner.operator.business.id, pin: employeePin }))
    expect(await pos({ ...staff, operator: fresh }, command)).toMatchObject({ status: 403, body: { error: { code: 'PERMISSION_DENIED' } } })
  }, 60_000)

  it('reserves before manual collection and records a split sale plus comanda with one idempotent final action', async () => {
    const {owner,staff,shift}=await fixture()
    const order=await createOrder(staff,[input(await product(owner),3)])
    const reservation=data(await pos<CheckoutAttempt>(staff,prepareCommand(order)))
    expect(reservation.totalCents).toBe(3003)
    const closing={command:'begin_shift_close' as const,operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision}
    expect(await pos(owner,closing)).toMatchObject({status:409,body:{error:{code:'PENDING_COLLECTION'}}})
    const quote=data(await pos<CheckoutAttempt>(staff,{command:'update_checkout',operationId:randomUUID(),attemptId:reservation.id,expectedRevision:reservation.revision,items:[{lineId:order.items[0].lineId,quantity:1}],paymentMethod:'cash'}))
    expect(quote).toMatchObject({id:reservation.id,totalCents:1001,status:'prepared'})
    expect(await pos(owner,{...closing,operationId:randomUUID()})).toMatchObject({status:409,body:{error:{code:'PENDING_COLLECTION'}}})
    const payment={command:'record_checkout' as const,operationId:randomUUID(),attemptId:quote.id,expectedRevision:quote.revision,confirmed:true as const}
    const replies=await Promise.all([pos<{order:OperationalOrder;attempt:CheckoutAttempt}>(staff,payment),pos<{order:OperationalOrder;attempt:CheckoutAttempt}>(staff,payment)])
    const paid=data(replies[0]);expect(data(replies[1])).toEqual(paid)
    expect(paid).toMatchObject({attempt:{status:'completed',totalCents:1001},order:{balanceCents:2002,paidCents:1001,items:[{paidQuantity:1,sentQuantity:1}]}})
    expect(count(owner,'sales')).toBe(1)
    expect((await kitchen(owner)).filter(b=>b.orderId===order.id)).toMatchObject([{items:[{quantity:1}]}])
    const frozen=data(await pos<CashShift>(owner,{...closing,operationId:randomUUID()}))
    data(await pos(owner,{command:'close_shift',operationId:randomUUID(),shiftId:shift.id,expectedRevision:frozen.revision,countedCents:shift.openingCents+1001}))
    expect(data(await pos(staff,payment))).toEqual(paid)
    expect(await pos(staff,{...prepareCommand(paid.order),operationId:randomUUID(),command:'record_payment',confirmed:true})).toMatchObject({status:409,body:{error:{code:'ATTEMPT_STATE_INVALID'}}})
  },45_000)

  it('allows refund-only grants to read shift status and recover a reversal without cash disclosure', async () => {
    const { owner, staff } = await fixture(['sales.read_all', 'sales.reverse'])
    const paid = await payAll(owner, await createOrder(owner))
    const attempt = data(await pos<CheckoutAttempt>(staff, { command: 'prepare_reversal', operationId: randomUUID(), saleId: paid.saleId!, reason: 'Devolución sintética' }))
    const snapshot = data(await pos<OperationsSnapshot>(staff, { command: 'operations' }))
    expect(snapshot.shift).toMatchObject({ status: 'open', openingCents: 0, movements: [], expectedCents: null })
    expect(snapshot.orders).toEqual([])
    expect(snapshot.attempts).toEqual([attempt])
  }, 45_000)

  it('deduplicates identical UUIDs, rejects conflicting payloads and never repeats a discarded financial response', async () => {
    const {owner,staff,shift} = await fixture()
    const request = {command:'cash_movement' as const,operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision,kind:'in' as const,amountCents:101,reason:'Entrada sintética'}
    const same = await Promise.all(Array.from({length:4},()=>pos<CashShift>(staff,request)))
    for (const reply of same) expect(data(reply)).toEqual(data(same[0]))
    expect(count(owner,'cash_movements')).toBe(1)
    const current = await activeShift(owner)
    const conflict = {...request,operationId:randomUUID(),expectedRevision:current.revision}
    const conflicting = await Promise.all([pos(staff,conflict),pos(staff,{...conflict,amountCents:202})])
    expect(conflicting.map(r=>r.status).sort()).toEqual([200,409])
    expect(conflicting.find(r=>r.status===409)?.body.error?.code).toBe('OPERATION_CONFLICT')
    expect(count(owner,'cash_movements')).toBe(2)
    let order = await createOrder(staff)
    order = await checkoutPhase(staff,order)
    const prepared = await prepare(staff,order)
    const started = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:prepared.id,expectedRevision:prepared.revision}))
    const confirm = confirmation(started)
    const response = await raw(staff.identity,{action:'pos',...args(staff),...confirm})
    expect(response.status).toBe(200)
    // The application never consumes the accepted body; recovery reuses the same UUID.
    await response.body?.cancel()
    const accepted = data(await pos<CheckoutAttempt>(staff,confirm))
    expect(accepted.status).toBe('completed')
    expect(count(owner,'sales')).toBe(1)
    expect(count(owner,'sale_items')).toBe(1)
    expect(data(await pos(staff,confirm))).toEqual(accepted)
  },45_000)

  it('serializes distinct UUIDs and drawer closing against a movement on separate database sessions', async () => {
    const {owner,staff,shift} = await fixture()
    const movement = {command:'cash_movement' as const,operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision,kind:'out' as const,amountCents:123,reason:'Retiro sintético'}
    const results = await blockedRace(owner,[
      ()=>pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision}),
      ()=>pos<CashShift>(staff,movement),
    ])
    expect(results.map(r=>r.status).sort()).toEqual([200,409])
    expect(results.find(r=>r.status===409)?.body.error?.code).toBe('SHIFT_CHANGED')
    let current = await activeShift(owner)
    const acceptedMovement = count(owner,'cash_movements')
    expect(acceptedMovement).toBe(results[1].status===200?1:0)
    if (current.status==='open') current = data(await pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision}))
    const expected = shift.openingCents-(acceptedMovement?123:0)
    const closed = data(await pos<CashShift>(owner,{command:'close_shift',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision,countedCents:expected}))
    expect(closed).toMatchObject({status:'closed',expectedCents:expected,differenceCents:0})
    if (results[1].status===200) expect(data(await pos(staff,movement))).toEqual(results[1].body.data)
    const next = data(await pos<CashShift>(owner,{command:'open_shift',operationId:randomUUID(),openingCents:500}))
    const distinct = await blockedRace(owner,[
      ()=>pos(owner,{...movement,operationId:randomUUID(),shiftId:next.id,expectedRevision:next.revision}),
      ()=>pos(staff,{...movement,operationId:randomUUID(),shiftId:next.id,expectedRevision:next.revision}),
    ])
    expect(distinct.map(r=>r.status).sort()).toEqual([200,409])
    expect(distinct.find(r=>r.status===409)?.body.error?.code).toBe('SHIFT_CHANGED')
  },45_000)

  it('prevents closing from passing a prepared or unresolved collection and includes the resolved cash once', async () => {
    const {owner,staff,shift} = await fixture()
    const order = await checkoutPhase(staff,await createOrder(staff))
    const prep = prepareCommand(order)
    const results = await blockedRace(owner,[
      ()=>pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision}),
      ()=>pos<CheckoutAttempt>(staff,prep),
    ])
    expect(results.map(r=>r.status).sort()).toEqual([200,409])
    let current = await activeShift(owner)
    let attempt: CheckoutAttempt
    if (results[0].status===200) {
      expect(results[1].body.error?.code).toBe('SHIFT_NOT_OPEN')
      current = data(await pos<CashShift>(owner,{command:'abort_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision}))
      attempt = data(await pos<CheckoutAttempt>(staff,{...prep,operationId:randomUUID()}))
    } else {
      expect(results[0].body.error?.code).toBe('PENDING_COLLECTION')
      attempt = data(results[1]) as CheckoutAttempt
    }
    expect((await pos(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision})).body.error?.code).toBe('PENDING_COLLECTION')
    attempt = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}))
    attempt = data(await pos<CheckoutAttempt>(staff,{command:'mark_checkout_uncertain',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}))
    const resolve = confirmation(attempt)
    const racing = await blockedRace(owner,[
      ()=>pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision}),
      ()=>pos<CheckoutAttempt>(staff,resolve),
    ])
    expect(racing[1].status).toBe(200)
    if (racing[0].status!==200) expect(['PENDING_COLLECTION','SHIFT_CHANGED']).toContain(racing[0].body.error?.code)
    current = await activeShift(owner)
    if (current.status==='open') current = data(await pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision}))
    const closed = data(await pos<CashShift>(owner,{command:'close_shift',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision,countedCents:shift.openingCents+attempt.totalCents}))
    expect(closed).toMatchObject({expectedCents:shift.openingCents+attempt.totalCents,differenceCents:0})
    expect(data(await pos(staff,resolve))).toEqual(racing[1].body.data)
    expect(count(owner,'sales')).toBe(1)
  },45_000)

  it('serializes closing with refunds and records a full reversal in the current drawer only', async () => {
    const {owner,staff,shift} = await fixture()
    const paid = await payAll(staff,await createOrder(staff))
    const results = await blockedRace(owner,[
      ()=>pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:shift.id,expectedRevision:shift.revision}),
      ()=>pos<CheckoutAttempt>(staff,{command:'prepare_reversal',operationId:randomUUID(),saleId:paid.saleId!,reason:'Devolución sintética'}),
    ])
    expect(results.map(r=>r.status).sort()).toEqual([200,409])
    let current = await activeShift(owner), reversal: CheckoutAttempt
    if (results[0].status===200) {
      expect(results[1].body.error?.code).toBe('SHIFT_NOT_OPEN')
      current = data(await pos<CashShift>(owner,{command:'abort_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision}))
      reversal = data(await pos<CheckoutAttempt>(staff,{command:'prepare_reversal',operationId:randomUUID(),saleId:paid.saleId!,reason:'Devolución sintética'}))
    } else {
      expect(results[0].body.error?.code).toBe('PENDING_COLLECTION')
      reversal = data(results[1]) as CheckoutAttempt
    }
    reversal = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:reversal.id,expectedRevision:reversal.revision}))
    const resolve = confirmation(reversal)
    const racing = await blockedRace(owner,[
      ()=>pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision}),
      ()=>pos<CheckoutAttempt>(staff,resolve),
    ])
    expect(racing[1].status).toBe(200)
    current = await activeShift(owner)
    if(current.status==='open') current = data(await pos<CashShift>(owner,{command:'begin_shift_close',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision}))
    const closed = data(await pos<CashShift>(owner,{command:'close_shift',operationId:randomUUID(),shiftId:current.id,expectedRevision:current.revision,countedCents:shift.openingCents}))
    expect(closed).toMatchObject({expectedCents:shift.openingCents,differenceCents:0})
    expect(count(owner,'sale_reversals')).toBe(1)
    expect(count(owner,'sales')).toBe(1)
    expect(data(await pos(staff,resolve))).toEqual(racing[1].body.data)
  },45_000)

  it('preserves every cent of price, discount and IVA across repeated quantity splits after catalog changes', async () => {
    const {owner,staff} = await fixture()
    const taxable = await product(owner,1001,1600), zero = await product(owner,1001,0)
    let order = await createOrder(staff,[input(taxable,3),input(zero,2)])
    order = data(await pos<OperationalOrder>(staff,{command:'set_order_discount',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,discount:{kind:'fixed',value:7,reason:'Descuento sintético'}}))
    expect(order).toMatchObject({grossCents:5005,discountCents:7,totalCents:4998})
    const totals = {discount:order.discountCents,tax:order.taxCents,total:order.totalCents}
    data(await pos(owner,{command:'set_product_sold_out',operationId:randomUUID(),productId:taxable.id,expectedVersion:taxable.version,soldOut:true}))
    data(await pos(owner,{command:'delete_product',operationId:randomUUID(),productId:zero.id,expectedVersion:zero.version}))
    order = await checkoutPhase(staff,order)
    const attempts: CheckoutAttempt[] = []
    for (const line of order.items) for(let i=0;i<line.quantity;i++) {
      const current = data(await pos<OperationalOrder>(staff,{command:'order',orderId:order.id}))
      let attempt = data(await pos<CheckoutAttempt>(staff,{...prepareCommand(current),items:[{lineId:line.lineId,quantity:1}]}))
      attempt = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}))
      attempt = data(await pos<CheckoutAttempt>(staff,confirmation(attempt)))
      attempts.push(attempt)
    }
    expect(attempts.reduce((sum,a)=>sum+a.totalCents,0)).toBe(totals.total)
    expect(attempts.reduce((sum,a)=>sum+a.discountCents,0)).toBe(totals.discount)
    expect(attempts.reduce((sum,a)=>sum+a.taxCents,0)).toBe(totals.tax)
    const settled = data(await pos<OperationalOrder>(owner,{command:'order',orderId:order.id}))
    expect(settled).toMatchObject({status:'paid',balanceCents:0,paidCents:totals.total,frozen:true})
    expect(settled.items.every(i=>i.paidQuantity===i.quantity)).toBe(true)
    expect(count(owner,'sales')).toBe(5)
    const persisted = JSON.parse(sql(`select json_build_object('total',sum(total_cents),'discount',sum(discount_cents),'tax',sum(tax_cents)) from app_private.sale_items where business_id=${uuid(owner.operator.business.id)};`).trim())
    expect(persisted).toEqual({total:totals.total,discount:totals.discount,tax:totals.tax})
  },45_000)

  it('requires the owner to waive prepared unpaid balances and preserves partial sales and preparation history', async () => {
    const {owner,staff} = await fixture()
    let order = data(await pos<OperationalOrder>(staff,{command:'send_order',operationId:randomUUID(),orderId:(await createOrder(staff,[input(await product(owner),3)])).id,expectedRevision:1}))
    const batch = data(await pos<{batches:KitchenBatch[]}>(staff,{command:'kitchen'})).batches.find(b=>b.orderId===order.id)!
    data(await pos(staff,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status:'delivered'}))
    const cancelled = await pos(staff,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cliente cambió de opinión'})
    expect(cancelled.status).toBe(409)
    expect(['ORDER_LOCKED','ORDER_HAS_PAYMENTS']).toContain(cancelled.body.error?.code)
    expect(data(await pos<OperationalOrder>(owner,{command:'order',orderId:order.id})).status).toBe('open')
    order = await checkoutPhase(staff,order)
    let attempt = data(await pos<CheckoutAttempt>(staff,{...prepareCommand(order),items:[{lineId:order.items[0].lineId,quantity:1}]}))
    attempt = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}))
    attempt = data(await pos<CheckoutAttempt>(staff,confirmation(attempt)))
    const receipt = data(await pos<Sale>(owner,{command:'sale',saleId:attempt.saleId!}))
    order = data(await pos<OperationalOrder>(owner,{command:'order',orderId:order.id}))
    const waiverRequest = {command:'prepare_waiver' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Condonación sintética autorizada'}
    expect((await pos(staff,waiverRequest)).body.error?.code).toBe('PERMISSION_DENIED')
    const waiver = data(await pos<BalanceWaiver>(owner,waiverRequest))
    expect(waiver.amountCents).toBe(2002)
    const confirm = {command:'confirm_waiver' as const,operationId:randomUUID(),waiverId:waiver.id,expectedRevision:waiver.revision,confirmed:true as const}
    const confirmations = await Promise.all([pos<BalanceWaiver>(owner,confirm),pos<BalanceWaiver>(owner,confirm)])
    expect(data(confirmations[0])).toEqual(data(confirmations[1]))
    expect((await pos(owner,{...confirm,operationId:randomUUID()})).body.error?.code).toBe('WAIVER_CHANGED')
    expect(count(owner,'balance_waivers')).toBe(1)
    expect(data(await pos<OperationalOrder>(owner,{command:'order',orderId:order.id}))).toMatchObject({status:'waived',paidCents:1001,waivedCents:2002,balanceCents:0})
    expect(data(await pos<Sale>(owner,{command:'sale',saleId:receipt.id}))).toEqual(receipt)
    expect(data(await pos<{batches:KitchenBatch[]}>(owner,{command:'kitchen'})).batches.some(b=>b.id===batch.id&&b.status==='delivered')).toBe(true)
  },45_000)

  it('cancels the older queued two units while preserving the newer prepared and paid three units', async () => {
    const {owner,staff} = await fixture()
    const item = await product(owner)
    let order = await createOrder(staff,[input(item,2)])
    order = data(await pos<OperationalOrder>(staff,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}))
    const queued = (await kitchen(staff)).find(b=>b.orderId===order.id)!
    order = data(await pos<OperationalOrder>(staff,{command:'save_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,name:order.name,tableId:null,items:[{...input(item,5),lineId:order.items[0].lineId}]}))
    order = data(await pos<OperationalOrder>(staff,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}))
    const newer = (await kitchen(staff)).find(b=>b.orderId===order.id&&b.id!==queued.id)!
    const preparedBatch = data(await pos<KitchenBatch>(staff,{command:'set_kitchen_status',operationId:randomUUID(),batchId:newer.id,expectedRevision:newer.revision,status:'delivered'}))
    expect(preparedBatch.items[0].quantity).toBe(3)
    const rawItems = rawKitchenItems(owner,order.id)
    order = await checkoutPhase(staff,order)
    let attempt = data(await pos<CheckoutAttempt>(staff,{...prepareCommand(order),items:[{lineId:order.items[0].lineId,quantity:3}]}))
    attempt = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}))
    attempt = data(await pos<CheckoutAttempt>(staff,confirmation(attempt)))
    const receipt = data(await pos<Sale>(owner,{command:'sale',saleId:attempt.saleId!}))
    order = data(await pos<OperationalOrder>(staff,{command:'order',orderId:order.id}))
    const request = {command:'cancel_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cancelar remanente en cola'}
    const cancelled = data(await pos<OperationalOrder>(staff,request))
    expect(cancelled).toMatchObject({status:'cancelled',paidCents:3003,cancelledCents:2002,balanceCents:0})
    expect(cancelled.items).toEqual(order.items)
    expect(data(await pos(staff,request))).toEqual(cancelled)
    expect(count(owner,'order_cancellations')).toBe(1)
    expect(count(owner,'sales')).toBe(1)
    expect(data(await pos<Sale>(owner,{command:'sale',saleId:receipt.id}))).toEqual(receipt)
    const batches = await kitchen(staff)
    expect(batches.find(b=>b.id===preparedBatch.id)).toEqual(preparedBatch)
    expect(batches.find(b=>b.id===queued.id)).toEqual({...queued,revision:queued.revision+1,fullyCancelled:true,items:queued.items.map(i=>({...i,cancelledQuantity:2}))})
    expect(rawKitchenItems(owner,order.id)).toEqual(rawItems)
    expect(batches.filter(b=>b.orderId===order.id&&b.kind==='cancellation')).toHaveLength(1)
    expect(batches.find(b=>b.orderId===order.id&&b.kind==='cancellation')?.items).toEqual([expect.objectContaining({quantity:2})])
  },45_000)

  it('keeps one of three queued units executable through preparation after cancelling the unpaid two', async () => {
    const {owner,staff} = await fixture()
    let order = await createOrder(staff,[input(await product(owner),3)])
    order = data(await pos<OperationalOrder>(staff,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}))
    const original = (await kitchen(staff)).find(b=>b.orderId===order.id)!
    const rawItems = rawKitchenItems(owner,order.id)
    order = await checkoutPhase(staff,order)
    let attempt = data(await pos<CheckoutAttempt>(staff,{...prepareCommand(order),items:[{lineId:order.items[0].lineId,quantity:1}]}))
    attempt = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}))
    attempt = data(await pos<CheckoutAttempt>(staff,confirmation(attempt)))
    const receipt = data(await pos<Sale>(owner,{command:'sale',saleId:attempt.saleId!}))
    order = data(await pos<OperationalOrder>(staff,{command:'order',orderId:order.id}))
    const cancelled = data(await pos<OperationalOrder>(staff,{command:'cancel_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Cancelar sólo dos unidades en cola'}))
    expect(cancelled).toMatchObject({status:'cancelled',paidCents:1001,cancelledCents:2002,balanceCents:0})
    expect(cancelled.items).toEqual(order.items)
    let batch = (await kitchen(staff)).find(b=>b.id===original.id)!
    expect(batch).toEqual({...original,revision:original.revision+1,items:original.items.map(i=>({...i,cancelledQuantity:2}))})
    expect((await pos(staff,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:original.revision,status:'delivered'})).body.error?.code).toBe('BATCH_CHANGED')
    for(const status of ['delivered'] as const) {
      batch = data(await pos<KitchenBatch>(staff,{command:'set_kitchen_status',operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status}))
      expect(batch).toMatchObject({status,fullyCancelled:false,items:[{quantity:3,cancelledQuantity:2}]})
      expect(batch.items[0].quantity-(batch.items[0].cancelledQuantity??0)).toBe(1)
    }
    expect(rawKitchenItems(owner,order.id)).toEqual(rawItems)
    expect(data(await pos<Sale>(owner,{command:'sale',saleId:receipt.id}))).toEqual(receipt)
    const notice = (await kitchen(staff)).find(b=>b.orderId===order.id&&b.kind==='cancellation')!
    expect(notice).toMatchObject({status:'queued',fullyCancelled:false,items:[{quantity:2,cancelledQuantity:0}]})
    data(await pos(staff,{command:'set_kitchen_status',operationId:randomUUID(),batchId:notice.id,expectedRevision:notice.revision,status:'delivered'}))
    expect((await kitchen(staff)).find(b=>b.id===batch.id)).toEqual(batch)
  },45_000)

  it('serializes cancellation and preparation on separate database sessions in both commit orders', async () => {
    const {owner,staff} = await fixture()
    for(const cancellationFirst of [true,false]) {
      let order = await createOrder(staff,[input(await product(owner),2)])
      order = data(await pos<OperationalOrder>(staff,{command:'send_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}))
      const batch = (await kitchen(staff)).find(b=>b.orderId===order.id)!
      const rawItems = rawKitchenItems(owner,order.id)
      const cancellation = {command:'cancel_order' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Carrera de cancelación sintética'}
      const preparation = {command:'set_kitchen_status' as const,operationId:randomUUID(),batchId:batch.id,expectedRevision:batch.revision,status:'delivered' as const}
      const cancel = ()=>pos(owner,cancellation), prep = ()=>pos(staff,preparation)
      const results = await blockedRace(owner,cancellationFirst?[cancel,prep]:[prep,cancel],true)
      expect(results[0].status).toBe(200)
      expect(results[1].status).toBe(409)
      expect(results[1].body.error?.code).toBe(cancellationFirst?'BATCH_CHANGED':'ORDER_LOCKED')
      const current = (await kitchen(staff)).find(b=>b.id===batch.id)!
      expect(current.revision).toBe(batch.revision+1)
      if(cancellationFirst) {
        expect(current).toMatchObject({status:'queued',fullyCancelled:true,items:[{quantity:2,cancelledQuantity:2}]})
        expect(data(await pos(owner,cancellation))).toEqual(results[0].body.data)
        expect((await pos(staff,{...preparation,operationId:randomUUID(),expectedRevision:current.revision})).body.error?.code).toBe('BATCH_CHANGED')
      } else {
        expect(current).toMatchObject({status:'delivered',fullyCancelled:false,items:[{quantity:2,cancelledQuantity:0}]})
        expect(data(await pos(staff,preparation))).toEqual(results[0].body.data)
        const waiverCommand = {command:'prepare_waiver' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,reason:'Condonar trabajo ya preparado'}
        expect((await pos(staff,waiverCommand)).body.error?.code).toBe('PERMISSION_DENIED')
        const waiver = data(await pos<BalanceWaiver>(owner,waiverCommand))
        expect(waiver.amountCents).toBe(2002)
        data(await pos(owner,{command:'confirm_waiver',operationId:randomUUID(),waiverId:waiver.id,expectedRevision:waiver.revision,confirmed:true}))
        expect((await kitchen(staff)).find(b=>b.id===batch.id)).toEqual(current)
      }
      expect(rawKitchenItems(owner,order.id)).toEqual(rawItems)
    }
    expect(count(owner,'order_cancellations')).toBe(1)
    expect(count(owner,'balance_waivers')).toBe(1)
    expect(count(owner,'sales')).toBe(0)
  },60_000)

  it('denies accepted-operation replay after live grant revocation and preserves recovery for the owner', async () => {
    const {owner,staff} = await fixture()
    const order = await checkoutPhase(staff,await createOrder(staff))
    const request = prepareCommand(order), attempt = data(await pos<CheckoutAttempt>(staff,request))
    data(await call(owner.identity,{action:'update_employee',...args(owner),employeeId:staff.operator.business.employee!.id,name:'Operador sintético',role:'cashier',active:true,pin:null,permissions:[]}))
    expect((await pos(staff,request)).body.error?.code).toBe('SESSION_INVALID')
    const current = data(await call<OperatorSession>(staff.identity,{action:'unlock',businessId:staff.operator.business.id,pin:employeePin}))
    const reentered = {...staff,operator:current}
    expect((await pos(reentered,request)).body.error?.code).toBe('PERMISSION_DENIED')
    expect((await pos(reentered,{command:'attempt',attemptId:attempt.id})).body.error?.code).toBe('PERMISSION_DENIED')
    const recovered = data(await pos<CheckoutAttempt>(owner,{command:'attempt',attemptId:attempt.id}))
    expect(recovered).toEqual(attempt)
    data(await pos(owner,{...confirmation(attempt),resolution:'abort'}))
    expect(count(owner,'sales')).toBe(0)
  },45_000)

  it('rechecks counter ownership after a concurrent move to a shared table before accepting payment', async () => {
    const {owner,staff} = await fixture(['catalog.read','sales.create'])
    const table = data(await pos<DiningTable>(owner,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa sintética',active:true}))
    const order = await checkoutPhase(staff,await createOrder(staff))
    const results = await blockedRace(owner,[
      ()=>pos<OperationalOrder>(owner,{command:'move_order',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,tableId:table.id}),
      ()=>pos<CheckoutAttempt>(staff,{...prepareCommand(order),expectedRevision:order.revision+1}),
    ],true)
    expect(results[0].status).toBe(200)
    expect(results[1].body.error?.code).toBe('PERMISSION_DENIED')
    expect(count(owner,'checkout_attempts')).toBe(0)
  },45_000)

  it('replays accepted counter steps after table movement while rejecting a fresh shared-table collection', async () => {
    const {owner,staff} = await fixture(['catalog.read','sales.create'])
    const table = data(await pos<DiningTable>(owner,{command:'save_table',operationId:randomUUID(),tableId:randomUUID(),expectedRevision:null,name:'Mesa para recuperación',active:true}))
    const item = data(await pos<{products:Product[]}>(staff,{command:'catalog'})).products[0]
    const savedRequest = {command:'save_order' as const,operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Cuenta propia sintética',tableId:null,items:[input(item)]}
    const saved = data(await pos<OperationalOrder>(staff,savedRequest))
    const beginRequest = {command:'begin_order_checkout' as const,operationId:randomUUID(),orderId:saved.id,expectedRevision:saved.revision}
    const begun = data(await pos<OperationalOrder>(staff,beginRequest))
    const prepareRequest = prepareCommand(begun), prepared = data(await pos<CheckoutAttempt>(staff,prepareRequest))
    data(await pos(owner,{...confirmation(prepared),resolution:'abort'}))
    const current = data(await pos<OperationalOrder>(owner,{command:'order',orderId:saved.id}))
    const moved = data(await pos<OperationalOrder>(owner,{command:'move_order',operationId:randomUUID(),orderId:saved.id,expectedRevision:current.revision,tableId:table.id}))
    expect(data(await pos(staff,savedRequest))).toEqual(saved)
    expect(data(await pos(staff,beginRequest))).toEqual(begun)
    expect(data(await pos(staff,prepareRequest))).toEqual(prepared)
    expect((await pos(staff,{...prepareRequest,operationId:randomUUID(),expectedRevision:moved.revision})).body.error?.code).toBe('PERMISSION_DENIED')
    expect(count(owner,'checkout_attempts')).toBe(1)
    expect(count(owner,'sales')).toBe(0)
  },45_000)

  it('revokes real paired-register operators when grants change and cannot replay with a fresh restricted token', async () => {
    const {owner} = await fixture()
    const employee = data(await call<{id:string;pinSetup:{setupCode:string}}>(owner.identity,{action:'create_employee',...args(owner),name:'Caja compartida sintética',role:'cashier',permissions:['catalog.read','sales.create'],pin:null,inviteWithGoogle:false,operationId:randomUUID()}))
    const pairing = data(await call<{pairingCode:string}>(owner.identity,{action:'create_pairing_code',...args(owner),operationId:randomUUID()}))
    const device = data(await call<{deviceToken:string}>(null,{action:'device_pair',pairingCode:pairing.pairingCode,deviceName:'Registro sintético',operationId:randomUUID()}))
    const operator = data(await call<OperatorSession>(null,{action:'device_set_employee_pin',deviceToken:device.deviceToken,setupCode:employee.pinSetup.setupCode,pin:employeePin,operationId:randomUUID()}))
    const item = data(await pos<{products:Product[]}>(owner,{command:'catalog'})).products[0]
    const request = {command:'save_order' as const,operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Cuenta de registro',tableId:null,items:[input(item)]}
    const accepted = data(await call<OperationalOrder>(null,{action:'device_pos',deviceToken:device.deviceToken,operatorToken:operator.operatorToken,...request}))
    data(await call(owner.identity,{action:'update_employee',...args(owner),employeeId:employee.id,name:'Caja compartida sintética',role:'cashier',active:true,pin:null,permissions:[]}))
    expect(sql(`select count(*) from app_private.device_operator_sessions where business_id=${uuid(owner.operator.business.id)} and employee_id=${uuid(employee.id)} and revoked_at is null;`).trim()).toBe('0')
    expect((await call(null,{action:'device_pos',deviceToken:device.deviceToken,operatorToken:operator.operatorToken,...request})).body.error?.code).toBe('SESSION_INVALID')
    const fresh = data(await call<OperatorSession>(null,{action:'device_unlock',deviceToken:device.deviceToken,employeeId:employee.id,pin:employeePin}))
    expect((await call(null,{action:'device_pos',deviceToken:device.deviceToken,operatorToken:fresh.operatorToken,...request})).body.error?.code).toBe('PERMISSION_DENIED')
    expect(data(await pos<OperationalOrder>(owner,{command:'order',orderId:accepted.id}))).toEqual(accepted)
  },45_000)

  it('cascades tenant deletion through settled payments and orderless reversal attempts', async () => {
    const {owner,staff} = await fixture()
    const paid = await payAll(staff,await createOrder(staff))
    let reversal = data(await pos<CheckoutAttempt>(staff,{command:'prepare_reversal',operationId:randomUUID(),saleId:paid.saleId!,reason:'Devolución de fixture sintético'}))
    reversal = data(await pos<CheckoutAttempt>(staff,{command:'start_checkout',operationId:randomUUID(),attemptId:reversal.id,expectedRevision:reversal.revision}))
    data(await pos(staff,confirmation(reversal)))
    expect(count(owner,'checkout_attempts')).toBe(2)
    expect(count(owner,'sale_reversals')).toBe(1)
    const tenant = owner.operator.business.id
    sql(`delete from app_private.businesses where id=${uuid(tenant)};`)
    businesses.splice(businesses.indexOf(tenant),1)
    const remaining = ['checkout_attempts','sale_reversals','operational_orders','order_lines','cash_shifts','sales','sale_items','pos_operations','employees','business_memberships']
      .map(table=>`select count(*) from app_private.${table} where business_id=${uuid(tenant)}`).join(' union all ')
    expect(sql(remaining).trim().split('\n').every(value=>value==='0')).toBe(true)
  },45_000)
})

function localConfig() {
  let status: Record<string,string>, configuration: string
  const own = existsSync('.local-dev/supabase/config.toml')
  if(process.env.TEST_SUPABASE_URL) {
    status={API_URL:process.env.TEST_SUPABASE_URL,ANON_KEY:process.env.TEST_SUPABASE_ANON_KEY??'',SERVICE_ROLE_KEY:process.env.TEST_SUPABASE_SERVICE_ROLE_KEY??''}
    configuration=readFileSync(own?'.local-dev/supabase/config.toml':'supabase/config.toml','utf8')
  } else {
    try {status=JSON.parse(execFileSync('./node_modules/.bin/supabase',[...(own?['--workdir','.local-dev']:[]),'status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))}
    catch {return null}
    configuration=readFileSync(own?'.local-dev/supabase/config.toml':'supabase/config.toml','utf8')
  }
  if(!['localhost','127.0.0.1','[::1]'].includes(new URL(status.API_URL).hostname)) throw new Error('Operations integration refuses non-loopback services')
  if(!status.ANON_KEY||!status.SERVICE_ROLE_KEY) throw new Error('Missing local integration credentials')
  const project=configuration.match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1]
  if(!project) throw new Error('Missing local project identity')
  return {url:status.API_URL,anonKey:status.ANON_KEY,serviceRoleKey:status.SERVICE_ROLE_KEY,dbContainer:process.env.TEST_LOCAL_DB_CONTAINER??`supabase_db_${project}`}
}
function client(key:string) {return createClient(config!.url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}})}
async function identity(): Promise<Identity> {
  const email=`lean-integration-${randomUUID()}@example.test`, password=`local-only-${randomUUID()}-Aa9!`
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true}); if(created.error) throw created.error
  users.push(created.data.user.id)
  const signed=await client(config!.anonKey).auth.signInWithPassword({email,password}); if(signed.error) throw signed.error
  return {userId:created.data.user.id,token:signed.data.session!.access_token}
}
async function fixture(permissions: readonly BusinessPermission[] = businessPermissions) {
  const operator=data(await call<OperatorSession>(ownerIdentity,{action:'create_business',name:'Operación sintética',businessType:'cafe',timezone:'America/Mexico_City',pin,operationId:randomUUID(),profile:{branchName:'Principal',registerName:'Caja',address:'',city:'',state:'',contactPhone:'',paymentMethods:['cash','card_external','transfer']}}))
  businesses.push(operator.business.id)
  const owner={identity:ownerIdentity,operator}
  const employee=data(await call<{invitation:{invitationCode:string}}>(ownerIdentity,{action:'create_employee',...args(owner),name:'Operador sintético',role:'cashier',permissions,pin:null,inviteWithGoogle:true,operationId:randomUUID()}))
  const staff={identity:staffIdentity,operator:data(await call<OperatorSession>(staffIdentity,{action:'accept_invitation',invitationCode:employee.invitation.invitationCode,pin:employeePin,operationId:randomUUID()}))}
  data(await pos(owner,{command:'activate_operations',operationId:randomUUID()}))
  const shift=data(await pos<CashShift>(owner,{command:'open_shift',operationId:randomUUID(),openingCents:10000}))
  await product(owner)
  return {owner,staff,shift}
}
function args(actor:Actor) {return {businessId:actor.operator.business.id,operatorToken:actor.operator.operatorToken}}
async function product(actor:Actor,priceCents=1001,taxBps=1600) {return data(await pos<Product>(actor,{command:'save_product',operationId:randomUUID(),productId:randomUUID(),expectedVersion:null,name:'Producto sintético',category:'',priceCents,details:{...emptyDetails(),taxBps,taxTreatment:taxBps===1600?'vat_16':'vat_0'}}))}
function input(product:Product,quantity=1):OrderInputLine {return {lineId:randomUUID(),productId:product.id,quantity,unitPriceCents:product.priceCents,version:product.version,note:'Nota sintética'}}
async function createOrder(actor:Actor,items?:OrderInputLine[]) {
  if(!items) {
    const catalog=data(await pos<{products:Product[]}>(actor,{command:'catalog'}))
    const item=catalog.products[0]
    if(!item) throw new Error('Missing synthetic catalog fixture')
    items=[input(item)]
  }
  return data(await pos<OperationalOrder>(actor,{command:'save_order',operationId:randomUUID(),orderId:randomUUID(),expectedRevision:null,name:'Cuenta sintética',tableId:null,items}))
}
async function checkoutPhase(actor:Actor,order:OperationalOrder) {return data(await pos<OperationalOrder>(actor,{command:'begin_order_checkout',operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision}))}
function prepareCommand(order:OperationalOrder) {return {command:'prepare_checkout' as const,operationId:randomUUID(),orderId:order.id,expectedRevision:order.revision,items:order.items.filter(i=>i.quantity>i.paidQuantity).map(i=>({lineId:i.lineId,quantity:i.quantity-i.paidQuantity})),paymentMethod:'cash' as const}}
async function prepare(actor:Actor,order:OperationalOrder) {return data(await pos<CheckoutAttempt>(actor,prepareCommand(order)))}
function confirmation(attempt:CheckoutAttempt) {return {command:'resolve_checkout' as const,operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision,resolution:'complete' as const,confirmed:true as const,reason:'Confirmación externa sintética'}}
async function payAll(actor:Actor,order:OperationalOrder) {const phase=await checkoutPhase(actor,order),attempt=await prepare(actor,phase);const started=data(await pos<CheckoutAttempt>(actor,{command:'start_checkout',operationId:randomUUID(),attemptId:attempt.id,expectedRevision:attempt.revision}));return data(await pos<CheckoutAttempt>(actor,confirmation(started)))}
async function activeShift(actor:Actor) {return data(await pos<OperationsSnapshot>(actor,{command:'operations'})).shift!}
async function kitchen(actor:Actor) {return data(await pos<{batches:KitchenBatch[]}>(actor,{command:'kitchen'})).batches}
function rawKitchenItems(actor:Actor,orderId:string) {return JSON.parse(sql(`select json_agg(json_build_object('id',id,'items',items) order by id) from app_private.kitchen_batches where business_id=${uuid(actor.operator.business.id)} and order_id=${uuid(orderId)} and kind='items';`).trim())}
async function pos<T=unknown>(actor:Actor,command:PosCommand) {
  const reply=await call<T>(actor.identity,{action:'pos',...args(actor),...command})
  if(reply.status===200) assertFinancialResponse(command,reply.body.data)
  return reply
}
async function raw(person:Identity|null,request:Record<string,unknown>) {return fetch(`${config!.url}/functions/v1/account`,{method:'POST',headers:{'content-type':'application/json',apikey:config!.anonKey,...(person?{authorization:`Bearer ${person.token}`}:{})},body:JSON.stringify(await signedRequest(person?.userId,request)),signal:AbortSignal.timeout(20_000)})}
async function call<T=unknown>(person:Identity|null,request:Record<string,unknown>):Promise<Reply<T>> {const response=await raw(person,request);return {status:response.status,body:await response.json()}}
function data<T>(reply:Reply<T>):T {expect(reply.status,JSON.stringify(reply.body.error)).toBe(200);expect(reply.body.data).toBeDefined();return reply.body.data!}
function uuid(value:string) {if(!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid synthetic UUID');return `'${value}'::uuid`}
function sql(query:string) {return execFileSync('docker',['exec','-i',config!.dbContainer,'psql','-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-Atq'],{input:query,encoding:'utf8'})}
function count(actor:Actor,table:'sales'|'sale_items'|'cash_movements'|'checkout_attempts'|'sale_reversals'|'balance_waivers'|'order_cancellations') {return Number(sql(`select count(*) from app_private.${table} where business_id=${uuid(actor.operator.business.id)};`).trim())}

// A third real connection holds the business mutex until both signed requests are
// observed waiting on PostgreSQL advisory locks. This proves actual DB contention.
async function blockedRace(actor:Actor,requests:(()=>Promise<Reply<unknown>>)[],ordered=false) {
  const holder=spawn('docker',['exec','-i',config!.dbContainer,'psql','-U','postgres','-d','postgres','-X','-v','ON_ERROR_STOP=1','-Atq'],{stdio:['pipe','pipe','pipe']})
  let stdout='',stderr=''
  holder.stdout.on('data',chunk=>{stdout+=String(chunk)})
  holder.stderr.on('data',chunk=>{stderr+=String(chunk)})
  const done=new Promise<void>((resolve,reject)=>{holder.on('error',reject);holder.on('close',code=>code===0?resolve():reject(new Error(`Synthetic lock connection failed: ${stderr}`)))})
  holder.stdin.write(`begin; select pg_advisory_xact_lock(hashtextextended('operations:'||${uuid(actor.operator.business.id)}::text,0)); select 'LOCK_READY:'||pg_backend_pid();\n`)
  const running:Promise<Reply<unknown>>[]=[]
  let barrierError:unknown
  try {
    let pid:number|undefined
    for(let i=0;i<100;i++) {const match=stdout.match(/LOCK_READY:(\d+)/);if(match){pid=Number(match[1]);break}await delay(20)}
    if(!pid) throw new Error('Synthetic database mutex did not become ready')
    async function waitFor(count:number) {
      for(let i=0;i<100;i++) {
        const blocked=Number(sql(`select count(*) from pg_locks where locktype='advisory' and not granted and (classid,objid,objsubid) in (select classid,objid,objsubid from pg_locks where pid=${pid} and locktype='advisory' and granted);`).trim())
        if(blocked>=count) return
        await delay(25)
      }
      throw new Error(`Expected ${count} real PostgreSQL waiters on the fixture mutex`)
    }
    for(const request of requests) {
      const pending=request()
      // Observe request failures immediately while PostgreSQL is intentionally blocked.
      pending.catch(()=>{})
      running.push(pending)
      if(ordered) await waitFor(running.length)
    }
    if(!ordered) await waitFor(requests.length)
  } catch(error) {barrierError=error
  } finally {holder.stdin.end('commit;\n');await done}
  const results=await Promise.allSettled(running)
  if(barrierError) throw barrierError
  return results.map(result=>{if(result.status==='rejected') throw result.reason;return result.value})
}
