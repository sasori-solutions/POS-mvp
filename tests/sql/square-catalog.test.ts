import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { emptyDetails, includedTax, selectedPrice } from '../../src/lib/product-details'
import { filterProducts } from '../../src/lib/pos'
import type { PosCommand, Product, ProductDetails, Sale } from '../../src/lib/pos-contracts'
import type { CheckoutAttempt, KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'

type Actor = {
  userId: string; sessionId: string; businessId: string; employeeId: string; token: string; keyHash: string
}
type SaveProduct = Extract<PosCommand, { command: 'save_product' }>
let db: PGlite
let legacyUnsellable: { owner: Actor; command: SaveProduct; product: Product }
let legacySnapshot: { owner: Actor; product: Product; command: Extract<PosCommand, { command: 'save_order' }>; order: OperationalOrder }

// The HTTP parser and actual migration/RPC chain run against synthetic Auth rows.
// This establishes neither live Auth/Edge integration nor multi-connection locks.
describe('Square-compatible catalog metadata and operational snapshots', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } })
    await db.exec(`create schema auth; create schema extensions;
      create role anon; create role authenticated; create role service_role;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now(),not_after timestamptz);`)
    for (const file of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort()) {
      if (file === '20261006200000_square_catalog_options.sql') {
        const owner = await actor(), command = saveProduct(modifierDetails([9, 8, 8]))
        // An old direct SQL client could save an impossible mandatory selection.
        // Keep its accepted UUID/result to verify the additive upgrade preserves replay.
        legacyUnsellable = { owner, command, product: await executeRaw<Product>(owner, command) }
        const product = await executeRaw<Product>(owner, saveProduct({ ...emptyDetails(), customerName: 'Alias anterior', kitchenName: 'Nombre de cocina' }))
        await execute(owner, { command: 'activate_operations', operationId: randomUUID() })
        await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
        const orderCommand = newOrder(product)
        legacySnapshot = { owner, product, command: orderCommand, order: await execute<OperationalOrder>(owner, orderCommand) }
      }
      await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'))
    }
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('round-trips names, appearance, identifiers, nutrition and open price through exact HTTP and SQL', async () => {
    const owner = await actor()
    const details: ProductDetails = {
      ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600,
      kitchenName: 'LATTE BARRA', customerName: 'Latte con avena',
      tileColor: '#F3D6B8', tileLabel: 'LATTE', sku: 'CAFE-01', barcode: '7501234567890',
      calories: 142, dietary: 'Vegetariano; leche de avena', allergens: 'Avena',
      variablePrice: true, favorite: true, description: 'Café preparado al momento',
      skipCustomization: true,
      customAttributes: [{ name: 'Origen', value: 'Chiapas' }, { name: 'Ingredientes', value: 'Café; leche de avena' }],
    }
    const command = saveProduct(details, 0)
    expect(parse(owner, command)).toMatchObject({ details })
    const saved = await execute<Product>(owner, command)
    expect(saved.details).toEqual(details)
    expect((await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products).toEqual([saved])

    const edited = await execute<Product>(owner, {
      ...command, expectedVersion: saved.version, operationId: randomUUID(), name: 'Latte de especialidad',
      details: { ...details, dietary: 'Vegetariano', calories: null, tileLabel: 'CAFÉ' },
    })
    expect(edited.details).toEqual({ ...details, dietary: 'Vegetariano', calories: null, tileLabel: 'CAFÉ' })
    // Accepted replay returns the original version after later catalog edits.
    expect(await execute(owner, command)).toEqual(saved)
    expect((await db.query<{ count: number }>('select count(*)::integer as count from app_private.products where business_id=$1', [owner.businessId])).rows[0].count).toBe(1)
    await expect(execute(owner, { ...command, name: 'Payload incompatible' })).rejects.toThrow('OPERATION_CONFLICT')
  })

  it('rejects invalid restored fields and extra keys independently in HTTP and SQL', async () => {
    const owner = await actor()
    const invalidDetails = [
      { kitchenName: 'x'.repeat(101) }, { customerName: 'x'.repeat(101) },
      { tileLabel: 'x'.repeat(9) }, { tileColor: 'url(example)' },
      { sku: 'x'.repeat(61) }, { barcode: 'x'.repeat(33) },
      { calories: 1.5 }, { calories: -1 }, { dietary: 'x'.repeat(201) },
      { kitchenName: 'Barra\u0001' }, { unsupportedField: true },
      { skipCustomization: 'true' }, { skipCustomization: null },
      { customAttributes: null }, { customAttributes: [{ name: 'Origen', value: '' }] },
      { customAttributes: [{ name: ' ', value: 'Chiapas' }] },
      { customAttributes: [{ name: '\u00a0', value: 'Chiapas' }] },
      { customAttributes: [{ name: 'Origen', value: '\ufeff' }] },
      { customAttributes: [{ name: 'Origen', value: 'Chiapas', unsupported: true }] },
      { customAttributes: [{ name: 'Origen\u0001', value: 'Chiapas' }] },
      { customAttributes: [{ name: 'x'.repeat(41), value: 'Chiapas' }] },
      { customAttributes: [{ name: 'Origen', value: 'x'.repeat(121) }] },
      { customAttributes: [{ name: 'Origen', value: 'Chiapas' }, { name: ' origen ', value: 'Oaxaca' }] },
      { customAttributes: [{ name: 'Café', value: 'Chiapas' }, { name: 'Cafe\u0301', value: 'Oaxaca' }] },
      { customAttributes: [{ name: 'CAFÉ', value: 'Chiapas' }, { name: 'café', value: 'Oaxaca' }] },
      { customAttributes: Array.from({ length: 9 }, (_, index) => ({ name: `Dato ${index}`, value: 'Sintético' })) },
      { variablePrice: true, variations: [{ id: randomUUID(), name: 'Grande', priceCents: 11600, sku: '', barcode: '', soldOut: false }] },
    ]
    for (const patch of invalidDetails) {
      const command = saveProduct({ ...emptyDetails(), ...patch } as ProductDetails)
      expect(() => parse(owner, command)).toThrow()
      await expect(executeRaw(owner, command)).rejects.toThrow('VALIDATION_ERROR')
    }
    expect((await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products).toEqual([])
  })

  it('accepts the bounded optional extension while legacy payloads retain their exact shape', async () => {
    const owner = await actor(), legacy = saveProduct()
    expect(parse(owner, legacy)).not.toHaveProperty('details.skipCustomization')
    expect(parse(owner, legacy)).not.toHaveProperty('details.customAttributes')
    const previous = await execute<Product>(owner, legacy)
    expect(previous.details).not.toHaveProperty('skipCustomization')
    expect(previous.details).not.toHaveProperty('customAttributes')
    const command = saveProduct({
      ...emptyDetails(), skipCustomization: false,
      customAttributes: Array.from({ length: 8 }, (_, index) => ({ name: `Dato ${index}`, value: 'Sintético' })),
    })
    const extended = await execute<Product>(owner, command)
    expect(extended.details).toMatchObject({ skipCustomization: false, customAttributes: command.details!.customAttributes })
    expect(await execute(owner, command)).toEqual(extended)
    expect(await execute(owner, legacy)).toEqual(previous)
  })

  it('rejects more than 24 required modifiers without changing accepted pre-upgrade retries', async () => {
    const owner = await actor(), impossible = saveProduct(modifierDetails([9, 8, 8]))
    expect(() => parse(owner, impossible)).toThrow()
    await expect(executeRaw(owner, impossible)).rejects.toThrow('VALIDATION_ERROR')
    const maximum = saveProduct(modifierDetails([8, 8, 8]))
    const saved = await execute<Product>(owner, maximum)
    expect(saved.details?.modifierSets.reduce((sum, set) => sum + set.min, 0)).toBe(24)
    expect(await execute(owner, maximum)).toEqual(saved)
    expect(await executeRaw(legacyUnsellable.owner, legacyUnsellable.command)).toEqual(legacyUnsellable.product)
    await expect(executeRaw(legacyUnsellable.owner, {
      ...legacyUnsellable.command, operationId: randomUUID(), expectedVersion: legacyUnsellable.product.version,
    })).rejects.toThrow('VALIDATION_ERROR')
    expect((await execute<{ products: Product[] }>(owner, { command: 'catalog' })).products).toEqual([saved])
  })

  it('keeps catalog validators and the snapshot trigger private with an empty search path', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['app_private.validate_product_details(uuid,jsonb)', 'app_private.catalog_customer_name_snapshot()']) {
        expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, signature])).rows[0].allowed).toBe(false)
      }
    }
    const functionSettings = await db.query<{ proconfig: string[]; prosecdef: boolean }>(
      "select proconfig,prosecdef from pg_proc where oid='app_private.catalog_customer_name_snapshot()'::regprocedure",
    )
    expect(functionSettings.rows[0]).toEqual({ proconfig: ['search_path=""'], prosecdef: false })
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege('service_role','public.pos_execute(uuid,uuid,uuid,text,jsonb)','EXECUTE') as allowed")).rows[0].allowed).toBe(true)
  })

  it('preserves pre-upgrade names and snapshots aliases only for new lines, with a blank-alias fallback', async () => {
    const { owner, product, command, order } = legacySnapshot
    expect(order.items[0].name).toBe(product.name)
    expect(await execute(owner, command)).toEqual(order)
    expect((await execute<OperationalOrder>(owner, { command: 'order', orderId: order.id })).items[0].name).toBe(product.name)
    const current = await execute<OperationalOrder>(owner, newOrder(product))
    expect(current.items[0]).toMatchObject({ name: 'Alias anterior', kitchenName: 'Nombre de cocina' })
    const blank = await execute<Product>(owner, saveProduct({ ...emptyDetails(), customerName: '', kitchenName: '' }))
    const fallback = await execute<OperationalOrder>(owner, newOrder(blank))
    expect(fallback.items[0]).toMatchObject({ name: blank.name, kitchenName: blank.name })
  })

  it('keeps metadata mutations and accepted retry scoped to the live actor and tenant', async () => {
    const owner = await actor(), other = await actor()
    const cashier = await actor(owner.businessId, ['catalog.read', 'sales.create'])
    const command = saveProduct({ ...emptyDetails(), kitchenName: 'Cocina sintética', tileLabel: 'CAFÉ' })
    const product = await execute<Product>(owner, command)
    await expect(execute(cashier, { ...command, productId: randomUUID(), operationId: randomUUID() })).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(cashier, command)).rejects.toThrow('PERMISSION_DENIED')
    await expect(execute(other, { ...command, expectedVersion: product.version, operationId: randomUUID() })).rejects.toThrow('PRODUCT_CHANGED')
    expect((await execute<{ products: Product[] }>(other, { command: 'catalog' })).products).toEqual([])
    await db.query('delete from app_private.operator_sessions where business_id=$1 and user_id=$2', [owner.businessId, owner.userId])
    await expect(execute(owner, command)).rejects.toThrow(/PIN_REQUIRED|SESSION_INVALID|OPERATOR_EXPIRED/)
  })

  it('reuses a private photo inside its business while rejecting references from another tenant', async () => {
    const owner = await actor(), other = await actor(), imageId = randomUUID()
    const upload: PosCommand = {
      command: 'upload_product_image', operationId: randomUUID(), imageId, part: 0, parts: 1, data: '/9j/2f/Z',
    }
    expect(await execute(owner, upload)).toEqual({ imageId, complete: true })
    expect(await execute(owner, upload)).toEqual({ imageId, complete: true })
    const details = { ...emptyDetails(), imageId, tileColor: '#DDE8E0', tileLabel: 'PAN' }
    const first = await execute<Product>(owner, saveProduct(details))
    const second = await execute<Product>(owner, saveProduct(details))
    expect(first.image).toBe('data:image/jpeg;base64,/9j/2f/Z')
    expect(second.image).toBe(first.image)
    await expect(execute(other, saveProduct(details))).rejects.toThrow('VALIDATION_ERROR')
    expect((await execute<{ products: Product[] }>(other, { command: 'catalog' })).products).toEqual([])
  })

  it('finds restored product and variant identifiers without requiring a scanner', async () => {
    const owner = await actor()
    const product = await execute<Product>(owner, saveProduct({
      ...emptyDetails(), sku: 'CAFE-01', barcode: '7501234567890',
      variations: [{ id: randomUUID(), name: 'Grande', priceCents: 11601, sku: 'LATTE-G', barcode: '7501234567891', soldOut: false }],
    }))
    for (const query of ['cafe-01', '7501234567890', 'latte-g', '7501234567891']) {
      expect(filterProducts([product], query, '')).toEqual([product])
    }
    expect(filterProducts([product], '7500000000000', '')).toEqual([])
  })

  it('prices an open-price account with required extras and preserves IVA and kitchen names through catalog changes', async () => {
    const owner = await actor()
    await execute(owner, { command: 'activate_operations', operationId: randomUUID() })
    await execute(owner, { command: 'open_shift', operationId: randomUUID(), openingCents: 0 })
    const modifierId = randomUUID()
    const details: ProductDetails = {
      ...emptyDetails(), variablePrice: true, kitchenName: 'LATTE BARRA', customerName: 'Nombre de cliente',
      taxTreatment: 'vat_16', taxBps: 1600,
      modifierSets: [{ id: randomUUID(), name: 'Leche', min: 1, max: 1, options: [{ id: modifierId, name: 'Avena', priceCents: 101 }] }],
    }
    const product = await execute<Product>(owner, saveProduct(details, 0))
    const selection = { variationId: null, modifierIds: [modifierId], variablePriceCents: 11601 }
    const unitPriceCents = selectedPrice(product, selection)
    const command: Extract<PosCommand, { command: 'save_order' }> = {
      command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null,
      name: 'Mesa sintética', tableId: null, orderKind: 'service',
      items: [{ lineId: randomUUID(), productId: product.id, quantity: 3, unitPriceCents, version: product.version, note: 'Sin espuma', selection }],
    }
    for (const patch of [
      { selection: { ...selection, modifierIds: [] } },
      { selection: { ...selection, variablePriceCents: null } },
      { unitPriceCents: unitPriceCents - 1 },
    ]) {
      await expect(execute(owner, { ...command, operationId: randomUUID(), items: [{ ...command.items[0], ...patch }] })).rejects.toThrow(/VALIDATION_ERROR|PRODUCT_CHANGED/)
    }
    const order = await execute<OperationalOrder>(owner, command)
    const totalCents = unitPriceCents * 3, taxCents = includedTax(totalCents, 1600)
    expect(order).toMatchObject({ totalCents, taxCents, items: [{ name: 'Nombre de cliente', kitchenName: 'LATTE BARRA', selectionLabel: 'Avena', unitPriceCents, taxTreatment: 'vat_16', taxBps: 1600 }] })

    await execute(owner, {
      ...saveProduct({ ...emptyDetails(), kitchenName: 'Nombre posterior', taxTreatment: 'exempt', taxBps: 0 }, 99999),
      productId: product.id, expectedVersion: product.version, name: 'Catálogo editado',
    })
    expect(await execute(owner, command)).toEqual(order)
    const sent = await execute<OperationalOrder>(owner, { command: 'send_order', operationId: randomUUID(), orderId: order.id, expectedRevision: order.revision })
    const batches = (await execute<{ batches: KitchenBatch[] }>(owner, { command: 'kitchen' })).batches
    expect(batches.find(batch => batch.orderId === order.id)?.items).toEqual([{ lineId: order.items[0].lineId, name: 'LATTE BARRA', selectionLabel: 'Avena', note: 'Sin espuma', quantity: 3, cancelledQuantity: 0 }])
    const checkoutOrder = await execute<OperationalOrder>(owner, { command: 'begin_order_checkout', operationId: randomUUID(), orderId: sent.id, expectedRevision: sent.revision })
    const quote = await execute<CheckoutAttempt>(owner, { command: 'prepare_checkout', operationId: randomUUID(), orderId: checkoutOrder.id, expectedRevision: checkoutOrder.revision, items: [{ lineId: order.items[0].lineId, quantity: 3 }], paymentMethod: 'cash' })
    expect(quote).toMatchObject({ totalCents, taxCents, items: [{ name: 'Nombre de cliente', unitPriceCents }] })
    const payment: PosCommand = { command: 'record_checkout', operationId: randomUUID(), attemptId: quote.id, expectedRevision: quote.revision, confirmed: true }
    const paid = await execute<{ order: OperationalOrder; attempt: CheckoutAttempt }>(owner, payment)
    expect(await execute(owner, payment)).toEqual(paid)
    const receipt = await execute<Sale>(owner, { command: 'sale', saleId: paid.attempt.saleId! })
    expect(receipt).toMatchObject({ totalCents, items: [{ name: 'Nombre de cliente', unitPriceCents, totalCents, taxCents, taxBps: 1600, taxTreatment: 'vat_16', selectionLabel: 'Avena' }] })
  })
})

function saveProduct(details: ProductDetails = emptyDetails(), priceCents = 11600): SaveProduct {
  return { command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, name: 'Latte sintético', category: 'Café', priceCents, details }
}

function modifierDetails(minima: number[]): ProductDetails {
  return {
    ...emptyDetails(), modifierSets: minima.map((min, index) => ({
      id: randomUUID(), name: `Grupo ${index + 1}`, min, max: min,
      options: Array.from({ length: min }, (_, option) => ({ id: randomUUID(), name: `Extra ${option + 1}`, priceCents: 0 })),
    })),
  }
}

function newOrder(product: Product): Extract<PosCommand, { command: 'save_order' }> {
  return {
    command: 'save_order', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: null,
    name: 'Cuenta sintética', tableId: null, orderKind: 'service',
    items: [{ lineId: randomUUID(), productId: product.id, quantity: 1, unitPriceCents: product.priceCents, version: product.version, note: '' }],
  }
}

function envelope(current: Actor, command: PosCommand) {
  return { action: 'pos', businessId: current.businessId, operatorToken: current.token, ...command }
}

function parse(current: Actor, command: PosCommand) {
  return parseAccountRequest(envelope(current, command))
}

async function execute<T = unknown>(current: Actor, command: PosCommand): Promise<T> {
  parse(current, command)
  return executeRaw<T>(current, command)
}

async function executeRaw<T = unknown>(current: Actor, command: PosCommand): Promise<T> {
  const result = (await db.query<{ result: { data: T; error?: { code: string } } }>(
    "select public.account_secure($1,$2,'pos',$3::jsonb,$4,$5) as result",
    [current.userId, current.sessionId, JSON.stringify(envelope(current, command)), current.keyHash, randomUUID()],
  )).rows[0].result
  if (result.error) throw new Error(result.error.code)
  return result.data
}

async function actor(existingBusiness?: string, permissions: string[] = []): Promise<Actor> {
  const role = existingBusiness ? 'cashier' : 'owner'
  const current = {
    userId: randomUUID(), sessionId: randomUUID(), businessId: existingBusiness ?? randomUUID(), employeeId: randomUUID(),
    token: randomUUID().replaceAll('-', '').repeat(2), keyHash: randomUUID().replaceAll('-', '').repeat(2),
  }
  await db.query('insert into auth.users(id) values($1)', [current.userId])
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [current.sessionId, current.userId])
  if (!existingBusiness) await db.query(`insert into app_private.businesses(id,name,business_type,timezone,profile)
    values($1,'Café sintético','cafe','America/Mexico_City','{"branchName":"Principal","registerName":"Caja 1","accountsEnabled":true,"paymentMethods":["cash","card_external","transfer"]}')`, [current.businessId])
  await db.query('insert into app_private.business_memberships(business_id,user_id,role) values($1,$2,$3)', [current.businessId, current.userId, role])
  await db.query('insert into app_private.employees(id,business_id,user_id,name,role,permissions) values($1,$2,$3,$4,$5,$6)', [current.employeeId, current.businessId, current.userId, 'Operador sintético', role, permissions])
  await db.query(`insert into app_private.operator_sessions(business_id,user_id,auth_session_id,token_hash)
    values($1,$2,$3,extensions.digest($4,'sha256'))`, [current.businessId, current.userId, current.sessionId, current.token])
  if (existingBusiness) {
    await db.query(`insert into app_private.employee_personal_devices(business_id,employee_id,key_hash,name)
      values($1,$2,decode($3,'hex'),'Navegador sintético')`, [current.businessId, current.employeeId, current.keyHash])
    await db.query("update app_private.operator_sessions set employee_device_key_hash=decode($1,'hex') where business_id=$2 and user_id=$3", [current.keyHash, current.businessId, current.userId])
  }
  return current
}
