import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'

/** Synthetic local HTTP server; no upstream network access or live credentials. */
export async function startSimulator({ host = '127.0.0.1', port = 0, stateFile, realtime = false } = {}) {
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) throw new Error('Simulator bind must be local')
  // The historical account remains the interactive development account. Integration
  // suites use distinct OAuth identities, terminals and state; never reset this one.
  const defaultReceiver = '900001'
  const fixtureReceiver = /^91[0-9]{7}$/
  function makeState(receiverId, saved = {}) {
    return { scenario: 'approved', sequence: [], creates: 0, refunds: 0, refreshes: 0, version: 1, deliveries: 0,
      calls: /** @type {Array<{method:string,path:string,key:string|null}>} */ ([]), terminalMode: 'PDV', ...saved,
      orders: new Map(saved.orders ?? []), keys: new Map(saved.keys ?? []), refundKeys: new Map(saved.refundKeys ?? []), registerKeys: new Map(saved.registerKeys ?? []),
      branches: saved.branches ?? [{ id: 'STORE-1', name: 'Sucursal de prueba', user_id: receiverId }],
      registers: saved.registers ?? [{ id: 'POS-1', store_id: 'STORE-1', name: 'Caja de prueba', user_id: receiverId }] }
  }
  let state = makeState(defaultReceiver)
  const accounts = new Map()
  if (stateFile) {
    try {
      const { fixtureAccounts = [], ...saved } = JSON.parse(await readFile(stateFile, 'utf8'))
      state = makeState(defaultReceiver, saved)
      for (const [receiverId, value] of fixtureAccounts) {
        if (typeof receiverId !== 'string' || !fixtureReceiver.test(receiverId)) throw new Error('Invalid synthetic account')
        accounts.set(receiverId, makeState(receiverId, value))
      }
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read synthetic Point state') }
  }
  function account(receiverId) {
    if (receiverId === defaultReceiver) return state
    if (typeof receiverId !== 'string' || !fixtureReceiver.test(receiverId)) throw new Error('Invalid synthetic account')
    if (!accounts.has(receiverId)) accounts.set(receiverId, makeState(receiverId))
    return accounts.get(receiverId)
  }
  const suffix = receiverId => receiverId === defaultReceiver ? '' : `${receiverId}-`
  const terminal = (state, receiverId) => ({ id: receiverId === defaultReceiver ? 'NEWLAND_N950__SERIAL-1' : `NEWLAND_N950__TST${receiverId}`, store_id: 'STORE-1', pos_id: 'POS-1', operating_mode: state.terminalMode })
  const now = state => realtime ? new Date().toISOString() : new Date(Date.UTC(2026, 9, 3, 12, 0, state.deliveries++)).toISOString()
  const snapshot = state => ({ ...state, orders: [...state.orders.values()], keys: [...state.keys.keys()], refundKeys: [...state.refundKeys.keys()], registerKeys: [...state.registerKeys.keys()] })
  const referenceId = (receiverId, orderId) => receiverId === defaultReceiver ? String(700000 + Number(orderId.slice(3))) : `${receiverId}${String(Number(orderId.split('_').at(-1))).padStart(6, '0')}`
  function page(url, values, maximum) {
    const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? maximum)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error('Invalid paging')
    return { values: values.slice(offset, offset + limit), paging: { total: values.length, offset, limit } }
  }
  // The official v2 response does not promise its store_id; the filtered GET binds it.
  function posResponse(register) { const { store_id: _store, ...visible } = register; return visible }
  function send(response, data, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
  function loseResponse(response) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); setTimeout(() => response.destroy(), 5) }
  async function body(request) {
    let raw = ''
    for await (const chunk of request) { raw += chunk; if (raw.length > 32768) throw new Error('Too large') }
    return raw ? JSON.parse(raw) : undefined
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1'), input = await body(request)
      let receiverId = defaultReceiver
      if (url.pathname === '/__control') receiverId = input?.receiverId ?? url.searchParams.get('receiverId') ?? defaultReceiver
      else if (url.pathname === '/oauth/token') {
        const credential = input?.grant_type === 'refresh_token' ? input.refresh_token : input?.code
        receiverId = String(credential).match(/^sim-(?:code|refresh)-(91[0-9]{7})(?:-[0-9]+)?$/)?.[1] ?? defaultReceiver
      } else receiverId = String(request.headers.authorization).match(/^Bearer sim-access-(91[0-9]{7})-(?:[0-9]+|local-fixture)$/)?.[1] ?? defaultReceiver
      const state = account(receiverId), branches = state.branches, registers = state.registers
      if (url.pathname === '/authorization' && request.method === 'GET') {
        const redirect=new URL(url.searchParams.get('redirect_uri'))
        if(redirect.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(redirect.hostname) || redirect.username || redirect.password || redirect.pathname!=='/point/callback'
          || url.searchParams.get('client_id')!=='sim-client' || url.searchParams.get('code_challenge_method')!=='S256' || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state')??'') || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge')??'')) return send(response,{error:'invalid_authorization'},400)
        redirect.searchParams.set('state',url.searchParams.get('state'));redirect.searchParams.set('code','sim-code')
        response.writeHead(302,{Location:redirect.toString(),'Cache-Control':'no-store'});response.end();return
      }
      if (url.pathname === '/__control') {
        if (request.method === 'POST') {
          if (input.reset && stateFile) return send(response,{error:'persistent_development_orders_cannot_be_reset'},400)
          if (input.reset) { state.orders.clear(); state.keys.clear(); state.refundKeys.clear(); state.registerKeys.clear(); state.creates = 0; state.refunds = 0; state.refreshes = 0; state.version = 1; state.calls = [] }
          if (typeof input.scenario === 'string') state.scenario = input.scenario
          if (Array.isArray(input.sequence)) state.sequence = [...input.sequence]
          if (typeof input.terminalMode === 'string') state.terminalMode = input.terminalMode
          if (input.orderId && input.order) Object.assign(state.orders.get(input.orderId) ?? {}, input.order)
          if (input.externalRefund) {
            const order = state.orders.get(input.externalRefund.orderId)
            if (!order) return send(response, { error: 'missing' }, 404)
            applyRefund(state, receiverId, order, input.externalRefund.amountCents)
          }
        }
        return send(response, snapshot(state))
      }
      // Records only method/path/key, never request credentials or OAuth bodies.
      state.calls.push({ method: request.method, path: url.pathname, key: request.headers['x-idempotency-key'] ?? null })
      if (url.pathname === '/oauth/token') {
        if (state.scenario === 'revoked') return send(response, { error: 'invalid_grant' }, 401)
        if (input.client_id !== 'sim-client' || input.client_secret !== 'sim-secret') return send(response, { error: 'unauthorized' }, 401)
        if (input.grant_type === 'authorization_code' && (input.code !== (receiverId === defaultReceiver ? 'sim-code' : `sim-code-${receiverId}`) || typeof input.code_verifier !== 'string' || input.code_verifier.length < 43)) return send(response, { error: 'invalid_grant' }, 400)
        if (input.grant_type === 'refresh_token') {
          if (input.refresh_token !== `sim-refresh-${suffix(receiverId)}${state.version}`) return send(response, { error: 'invalid_grant' }, 401)
          state.refreshes++; state.version++
          if (state.scenario === 'refresh-timeout') { loseResponse(response); return }
        }
        return send(response, { access_token: `sim-access-${suffix(receiverId)}${state.version}`, refresh_token: `sim-refresh-${suffix(receiverId)}${state.version}`, user_id: Number(receiverId),
          expires_in: 3600, live_mode: input.test_token !== true, scope: 'read write offline_access' })
      }
      if (!(receiverId === defaultReceiver ? /^Bearer sim-access-(?:[0-9]+|local-fixture)$/ : new RegExp(`^Bearer sim-access-${receiverId}-(?:[0-9]+|local-fixture)$`)).test(String(request.headers.authorization)) || state.scenario === 'revoked') return send(response, { error: 'unauthorized' }, 401)
      if (url.pathname === '/users/me') return send(response, { id: Number(receiverId), site_id: 'MLM', tags: state.scenario === 'wrong-environment' ? [] : ['test_user'] })
      if (url.pathname === `/users/${receiverId}/stores/search`) {
        const results = branches.filter(branch => !url.searchParams.has('external_id') || branch.external_id === url.searchParams.get('external_id'))
        const result = page(url, results, 50)
        return send(response, { results: result.values, paging: result.paging })
      }
      if (url.pathname === `/users/${receiverId}/stores` && request.method === 'POST') {
        if (!input.location || !Number.isFinite(input.location.latitude) || !Number.isFinite(input.location.longitude)
          || !/^[A-Za-z0-9]{1,40}$/.test(input.external_id ?? '')) return send(response, { error: 'invalid_location' }, 400)
        const branch = { id: `STORE-${branches.length + 1}`, name: input.name, external_id: input.external_id, location: input.location, user_id: receiverId }; branches.push(branch); return send(response, branch, 201)
      }
      if (url.pathname === '/v2/pos') {
        if (request.method === 'GET') {
          const filtered = registers.filter(register => !url.searchParams.has('store_id') || register.store_id === url.searchParams.get('store_id'))
          const result = page(url, filtered, 30)
          return send(response, { data: result.values.map(posResponse), paging: result.paging })
        }
        if (request.method !== 'POST') return send(response, { error: 'method_not_allowed' }, 405)
        const key = request.headers['x-idempotency-key']
        if (!key) return send(response, { error: 'missing_idempotency' }, 400)
        const old = state.registerKeys.get(key)
        if (old) {
          if (old.payload !== JSON.stringify(input)) return send(response, { error: 'idempotency_key_already_used' }, 409)
          return send(response, posResponse(registers.find(register => register.id === old.id)), 201)
        }
        if (typeof input.name !== 'string' || !input.name.trim() || !branches.some(branch => branch.id === input.store_id)
          || !/^[A-Za-z0-9]{1,40}$/.test(input.external_id ?? '') || input.fixed_amount !== undefined && input.fixed_amount !== false) return send(response, { error: 'invalid_pos' }, 400)
        const pos = { id: `POS-${registers.length + 1}`, store_id: input.store_id, name: input.name, external_id: input.external_id, user_id: receiverId }
        registers.push(pos); state.registerKeys.set(key, { id: pos.id, payload: JSON.stringify(input) }); return send(response, posResponse(pos), 201)
      }
      if (url.pathname === '/terminals/v1/list') {
        const filtered = [terminal(state, receiverId)].filter(t => (!url.searchParams.has('store_id') || t.store_id === url.searchParams.get('store_id')) && (!url.searchParams.has('pos_id') || t.pos_id === url.searchParams.get('pos_id')))
        const result = page(url, filtered, 50)
        return send(response, { data: { terminals: result.values }, paging: result.paging })
      }
      if (url.pathname === '/terminals/v1/setup') { state.terminalMode = 'PDV'; return send(response, { terminals: [terminal(state, receiverId)] }) }
      if (url.pathname === '/v1/orders' && request.method === 'POST') {
        const key = request.headers['x-idempotency-key']
        if (!key) return send(response, { error: 'missing_idempotency' }, 400)
        const old = state.keys.get(key)
        if (old) {
          if (old.payload !== JSON.stringify(input)) return send(response, { error: 'idempotency_key_already_used' }, 409)
          return send(response, state.orders.get(old.id), 201)
        }
        const scenario = state.sequence.shift() ?? state.scenario
        if (scenario === 'timeout-before') { loseResponse(response); return }
        if (scenario === 'transient-before') return send(response, { error: 'server_error' }, 503)
        if (input.type !== 'point' || !/^\d+\.\d{2}$/.test(input.transactions?.payments?.[0]?.amount) || input.config?.point?.terminal_id !== terminal(state, receiverId).id) return send(response, { error: 'invalid_order' }, 400)
        state.creates++
        const prefix = receiverId === defaultReceiver ? '' : `${receiverId}_`
        const id = `ORD${prefix}${String(state.creates).padStart(26, '0')}`, paymentId = `PAY${prefix}${String(state.creates).padStart(26, '0')}`
        const pending = ['pending', 'at_terminal', 'action_required', 'rejected', 'canceled', 'expired'].includes(scenario)
        const status = scenario === 'pending' ? 'created' : scenario === 'at_terminal' ? 'at_terminal' : scenario === 'action_required' ? 'action_required' : scenario === 'rejected' ? 'failed' : scenario === 'canceled' ? 'canceled' : scenario === 'expired' ? 'expired' : 'processed'
        const order = { id, user_id: scenario === 'wrong-account' ? '800001' : receiverId, type: 'point', external_reference: input.external_reference,
          country_code: 'MEX', status, status_detail: status === 'action_required' ? 'check_on_terminal' : status, last_updated_date: now(state), config: input.config,
          transactions: { payments: [{ id: paymentId, amount: scenario === 'wrong-amount' ? '999.99' : input.transactions.payments[0].amount,
            status, status_detail: status === 'processed' ? 'accredited' : status === 'failed' ? 'rejected_by_issuer' : status === 'action_required' ? 'check_on_terminal' : status,
            ...(pending ? {} : { reference_id: referenceId(receiverId, id) }) }], refunds: [] }, _currency: scenario === 'wrong-currency' ? 'USD' : 'MXN' }
        state.orders.set(id, order); state.keys.set(key, { id, payload: JSON.stringify(input) })
        if (scenario === 'timeout-after') { loseResponse(response); return }
        if (scenario === 'transient-after') return send(response, { error: 'server_error' }, 503)
        if (scenario === 'invalid-json') { response.writeHead(201, { 'Content-Type': 'application/json' }); response.end('{'); return }
        return send(response, order, 201)
      }
      if (/^\/v1\/payments\/\d+$/.test(url.pathname)) {
        const paymentId = url.pathname.split('/').at(-1)
        const order = [...state.orders.values()].find(o => o.transactions.payments[0].reference_id === paymentId)
        if (!order) return send(response, { error: 'not_found' }, 404)
        return send(response, { id: Number(paymentId), collector_id: Number(order.user_id), currency_id: order._currency, live_mode: false,
          transaction_amount: order.transactions.payments[0].amount, external_reference: order.external_reference,
          status: order.status === 'refunded' ? 'refunded' : 'approved' })
      }
      const match = url.pathname.match(/^\/v1\/orders\/([A-Za-z0-9_-]+)(?:\/(refund|cancel|events))?$/)
      if (match) {
        const order = state.orders.get(match[1])
        if (!order) return send(response, { error: 'order_not_found' }, 404)
        if (!match[2]) return send(response, order)
        if (match[2] === 'events') {
          if (request.method !== 'POST' || !['processed', 'failed', 'canceled', 'expired', 'action_required'].includes(input?.status)
            || !['created', 'at_terminal', 'action_required'].includes(order.status)
            || order.status === 'action_required' && (order.status_detail !== 'check_on_terminal' || input.status !== 'processed')) return send(response, { error: 'invalid_simulation' }, 400)
          order.status = input.status; order.status_detail = input.status === 'action_required' ? 'check_on_terminal' : input.status; order.last_updated_date = now(state)
          const payment = order.transactions.payments[0]
          payment.status = input.status
          payment.status_detail = input.status === 'processed' ? 'accredited' : input.status === 'failed' ? 'insufficient_amount' : input.status === 'action_required' ? 'check_on_terminal' : input.status === 'canceled' ? 'cancel_by_terminal' : input.status
          if (input.status === 'processed') payment.reference_id = referenceId(receiverId, order.id)
          response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); return
        }
        const key = request.headers['x-idempotency-key']
        if (!key) return send(response, { error: 'missing_key' }, 400)
        if (match[2] === 'cancel') {
          if (order.status !== 'created') return send(response, { error: 'cannot_cancel' }, 409)
          order.status = 'canceled'; order.status_detail = 'canceled'; order.transactions.payments[0].status = 'canceled'; order.transactions.payments[0].status_detail = 'canceled_by_api'; order.last_updated_date = now(state); return send(response, order)
        }
        if (state.refundKeys.has(key)) return send(response, order, 201)
        const amount = input?.transactions?.[0]?.amount
        if (input && input.transactions?.[0]?.id !== order.transactions.payments[0].id) return send(response, { error: 'transaction_not_found' }, 404)
        const value = amount ? Math.round(Number(amount) * 100) : Math.round(Number(order.transactions.payments[0].amount) * 100)
        const already = order.transactions.refunds.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0)
        if (value + already > Math.round(Number(order.transactions.payments[0].amount) * 100)) return send(response, { error: 'refund_amount_exceeds' }, 400)
        state.refundKeys.set(key, true); applyRefund(state, receiverId, order, value)
        if (state.scenario === 'refund-timeout') { loseResponse(response); return }
        return send(response, order, 201)
      }
      return send(response, { error: 'not_found' }, 404)
    } catch { send(response, { error: 'invalid_request' }, 400) }
    finally { if(stateFile) await persist() }
  })
  let persistence=Promise.resolve()
  function persist() {
    const serialize = value => ({...value, orders:[...value.orders.entries()],keys:[...value.keys.entries()],refundKeys:[...value.refundKeys.entries()],registerKeys:[...value.registerKeys.entries()]})
    const serialized = JSON.stringify({...serialize(state), fixtureAccounts:[...accounts.entries()].map(([id,value])=>[id,serialize(value)])})
    persistence=persistence.then(async()=>{
      await writeFile(`${stateFile}.tmp`,serialized,{mode:0o600})
      await rename(`${stateFile}.tmp`,stateFile)
    })
    return persistence
  }
  function applyRefund(state, receiverId, order, amountCents) {
    state.refunds++
    order.transactions.refunds.push({ id: `REF${receiverId === defaultReceiver ? '' : `${receiverId}_`}${String(state.refunds).padStart(26, '0')}`, transaction_id: order.transactions.payments[0].id,
      amount: `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`, status: 'processed' })
    const full = order.transactions.refunds.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0) === Math.round(Number(order.transactions.payments[0].amount) * 100)
    order.status = full ? 'refunded' : 'processed'; order.status_detail = full ? 'refunded' : 'partially_refunded'
    order.transactions.payments[0].status = full ? 'refunded' : 'processed'; order.transactions.payments[0].status_detail = full ? 'refunded' : 'accredited'; order.last_updated_date = now(state)
  }
  await new Promise(resolve => server.listen(port, host, resolve))
  const address = server.address()
  return { url: `http://127.0.0.1:${address.port}`, state, close: async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }); if(stateFile) await persist() },
    webhook(orderId, secret = 'simulator-webhook-secret', ts = '1742505638683', requestId = 'sim-request-1') {
      const receiverId = [defaultReceiver, ...accounts.keys()].find(id => account(id).orders.has(orderId)) ?? defaultReceiver
      const manifest = `id:${orderId.toLowerCase()};request-id:${requestId};ts:${ts};`
      return { headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${createHmac('sha256', secret).update(manifest).digest('hex')}` },
        query: `data.id=${orderId}&type=order`, body: { type: 'order', data: { id: orderId }, user_id: Number(receiverId), live_mode: false } }
    } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const simulator = await startSimulator({ host: process.env.POINT_SIMULATOR_HOST ?? '127.0.0.1', port: Number(process.env.POINT_SIMULATOR_PORT ?? '8187') })
  console.log(JSON.stringify({ ready: true, url: simulator.url }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await simulator.close(); process.exit(0) })
}
