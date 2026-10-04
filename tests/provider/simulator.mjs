import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'

/** Synthetic local HTTP server; no upstream network access or live credentials. */
export async function startSimulator({ host = '127.0.0.1', port = 0, stateFile, realtime = false } = {}) {
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) throw new Error('Simulator bind must be local')
  const state = { scenario: 'approved', sequence: [], creates: 0, refunds: 0, refreshes: 0, version: 1, deliveries: 0, calls: /** @type {Array<{method:string,path:string,key:string|null}>} */ ([]), terminalMode: 'PDV', orders: new Map(), keys: new Map(), refundKeys: new Map() }
  if (stateFile) {
    try {
      const saved=JSON.parse(await readFile(stateFile,'utf8'))
      Object.assign(state,saved,{orders:new Map(saved.orders),keys:new Map(saved.keys),refundKeys:new Map(saved.refundKeys)})
    } catch(error) { if(error.code!=='ENOENT') throw new Error('Could not read synthetic Point state') }
  }
  const branches = state.branches ?? [{ id: 'STORE-1', name: 'Sucursal de prueba', user_id: '900001' }]
  const registers = state.registers ?? [{ id: 'POS-1', store_id: 'STORE-1', name: 'Caja de prueba', user_id: '900001' }]
  Object.assign(state,{branches,registers})
  const terminal = () => ({ id: 'NEWLAND_N950__SERIAL-1', store_id: 'STORE-1', pos_id: 'POS-1', operating_mode: state.terminalMode })
  const now = () => realtime ? new Date().toISOString() : new Date(Date.UTC(2026, 9, 3, 12, 0, state.deliveries++)).toISOString()
  const snapshot = () => ({ ...state, orders: [...state.orders.values()], keys: [...state.keys.keys()], refundKeys: [...state.refundKeys.keys()] })
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
          if (input.reset) { state.orders.clear(); state.keys.clear(); state.refundKeys.clear(); state.creates = 0; state.refunds = 0; state.refreshes = 0; state.version = 1; state.calls = [] }
          if (typeof input.scenario === 'string') state.scenario = input.scenario
          if (Array.isArray(input.sequence)) state.sequence = [...input.sequence]
          if (typeof input.terminalMode === 'string') state.terminalMode = input.terminalMode
          if (input.orderId && input.order) Object.assign(state.orders.get(input.orderId) ?? {}, input.order)
          if (input.externalRefund) {
            const order = state.orders.get(input.externalRefund.orderId)
            if (!order) return send(response, { error: 'missing' }, 404)
            applyRefund(order, input.externalRefund.amountCents)
          }
        }
        return send(response, snapshot())
      }
      // Records only method/path/key, never request credentials or OAuth bodies.
      state.calls.push({ method: request.method, path: url.pathname, key: request.headers['x-idempotency-key'] ?? null })
      if (url.pathname === '/oauth/token') {
        if (state.scenario === 'revoked') return send(response, { error: 'invalid_grant' }, 401)
        if (input.client_id !== 'sim-client' || input.client_secret !== 'sim-secret') return send(response, { error: 'unauthorized' }, 401)
        if (input.grant_type === 'authorization_code' && (input.code !== 'sim-code' || typeof input.code_verifier !== 'string' || input.code_verifier.length < 43)) return send(response, { error: 'invalid_grant' }, 400)
        if (input.grant_type === 'refresh_token') {
          if (input.refresh_token !== `sim-refresh-${state.version}`) return send(response, { error: 'invalid_grant' }, 401)
          state.refreshes++; state.version++
          if (state.scenario === 'refresh-timeout') { loseResponse(response); return }
        }
        return send(response, { access_token: `sim-access-${state.version}`, refresh_token: `sim-refresh-${state.version}`, user_id: 900001,
          expires_in: 3600, live_mode: input.test_token !== true, scope: 'read write offline_access' })
      }
      if (!String(request.headers.authorization).startsWith('Bearer sim-access-') || state.scenario === 'revoked') return send(response, { error: 'unauthorized' }, 401)
      if (url.pathname === '/users/me') return send(response, { id: 900001, site_id: 'MLM', tags: state.scenario === 'wrong-environment' ? [] : ['test_user'] })
      if (/^\/users\/900001\/stores\/search$/.test(url.pathname)) return send(response, { results: branches, paging: { total: branches.length } })
      if (/^\/users\/900001\/stores$/.test(url.pathname) && request.method === 'POST') {
        if (!input.location || !Number.isFinite(input.location.latitude) || !Number.isFinite(input.location.longitude)) return send(response, { error: 'invalid_location' }, 400)
        const branch = { id: `STORE-${branches.length + 1}`, name: input.name, external_id: input.external_id, user_id: '900001' }; branches.push(branch); return send(response, branch, 201)
      }
      if (url.pathname === '/pos') {
        if (request.method === 'GET') return send(response, { results: registers, paging: { total: registers.length } })
        const pos = { id: `POS-${registers.length + 1}`, store_id: input.store_id, name: input.name, user_id: '900001' }; registers.push(pos); return send(response, pos, 201)
      }
      if (url.pathname === '/terminals/v1/list') return send(response, { data: { terminals: [terminal()].filter(t => (!url.searchParams.has('store_id') || t.store_id === url.searchParams.get('store_id')) && (!url.searchParams.has('pos_id') || t.pos_id === url.searchParams.get('pos_id'))) }, paging: { total: 1, offset: 0, limit: 50 } })
      if (url.pathname === '/terminals/v1/setup') { state.terminalMode = 'PDV'; return send(response, { terminals: [terminal()] }) }
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
        if (input.type !== 'point' || !/^\d+\.\d{2}$/.test(input.transactions?.payments?.[0]?.amount) || input.config?.point?.terminal_id !== terminal().id) return send(response, { error: 'invalid_order' }, 400)
        state.creates++
        const id = `ORD${String(state.creates).padStart(26, '0')}`, paymentId = `PAY${String(state.creates).padStart(26, '0')}`
        const pending = ['pending', 'at_terminal', 'action_required', 'rejected'].includes(scenario)
        const status = scenario === 'pending' ? 'created' : scenario === 'at_terminal' ? 'at_terminal' : scenario === 'action_required' ? 'action_required' : scenario === 'rejected' ? 'failed' : 'processed'
        const order = { id, user_id: scenario === 'wrong-account' ? '800001' : '900001', type: 'point', external_reference: input.external_reference,
          country_code: 'MEX', status, status_detail: status, last_updated_date: now(), config: input.config,
          transactions: { payments: [{ id: paymentId, amount: scenario === 'wrong-amount' ? '999.99' : input.transactions.payments[0].amount,
            status, status_detail: status === 'processed' ? 'accredited' : status === 'failed' ? 'rejected_by_issuer' : status === 'action_required' ? 'check_on_terminal' : status,
            ...(pending ? {} : { reference_id: String(700000 + state.creates) }) }], refunds: [] }, _currency: scenario === 'wrong-currency' ? 'USD' : 'MXN' }
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
          transaction_amount: Number(order.transactions.payments[0].amount), external_reference: order.external_reference,
          status: order.status === 'refunded' ? 'refunded' : 'approved' })
      }
      const match = url.pathname.match(/^\/v1\/orders\/([A-Za-z0-9_-]+)(?:\/(refund|cancel))?$/)
      if (match) {
        const order = state.orders.get(match[1])
        if (!order) return send(response, { error: 'order_not_found' }, 404)
        if (!match[2]) return send(response, order)
        const key = request.headers['x-idempotency-key']
        if (!key) return send(response, { error: 'missing_key' }, 400)
        if (match[2] === 'cancel') {
          if (order.status !== 'created') return send(response, { error: 'cannot_cancel' }, 409)
          order.status = 'canceled'; order.status_detail = 'canceled'; order.transactions.payments[0].status = 'canceled'; order.transactions.payments[0].status_detail = 'canceled_by_api'; order.last_updated_date = now(); return send(response, order)
        }
        if (state.refundKeys.has(key)) return send(response, order, 201)
        const amount = input?.transactions?.[0]?.amount
        if (input && input.transactions?.[0]?.id !== order.transactions.payments[0].id) return send(response, { error: 'transaction_not_found' }, 404)
        const value = amount ? Math.round(Number(amount) * 100) : Math.round(Number(order.transactions.payments[0].amount) * 100)
        const already = order.transactions.refunds.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0)
        if (value + already > Math.round(Number(order.transactions.payments[0].amount) * 100)) return send(response, { error: 'refund_amount_exceeds' }, 400)
        state.refundKeys.set(key, true); applyRefund(order, value)
        if (state.scenario === 'refund-timeout') { loseResponse(response); return }
        return send(response, order, 201)
      }
      return send(response, { error: 'not_found' }, 404)
    } catch { send(response, { error: 'invalid_request' }, 400) }
    finally { if(stateFile) await persist() }
  })
  let persistence=Promise.resolve()
  function persist() {
    const serialized=JSON.stringify({...state,orders:[...state.orders.entries()],keys:[...state.keys.entries()],refundKeys:[...state.refundKeys.entries()]})
    persistence=persistence.then(async()=>{
      await writeFile(`${stateFile}.tmp`,serialized,{mode:0o600})
      await rename(`${stateFile}.tmp`,stateFile)
    })
    return persistence
  }
  function applyRefund(order, amountCents) {
    state.refunds++
    order.transactions.refunds.push({ id: `REF${String(state.refunds).padStart(26, '0')}`, transaction_id: order.transactions.payments[0].id,
      amount: `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`, status: 'processed' })
    const full = order.transactions.refunds.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0) === Math.round(Number(order.transactions.payments[0].amount) * 100)
    order.status = full ? 'refunded' : 'processed'; order.status_detail = full ? 'refunded' : 'partially_refunded'
    order.transactions.payments[0].status = full ? 'refunded' : 'processed'; order.transactions.payments[0].status_detail = full ? 'refunded' : 'accredited'; order.last_updated_date = now()
  }
  await new Promise(resolve => server.listen(port, host, resolve))
  const address = server.address()
  return { url: `http://127.0.0.1:${address.port}`, state, close: async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }); if(stateFile) await persist() },
    webhook(orderId, secret = 'simulator-webhook-secret', ts = '1742505638683', requestId = 'sim-request-1') {
      const manifest = `id:${orderId.toLowerCase()};request-id:${requestId};ts:${ts};`
      return { headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${createHmac('sha256', secret).update(manifest).digest('hex')}` },
        query: `data.id=${orderId}&type=order`, body: { type: 'order', data: { id: orderId }, user_id: 900001, live_mode: false } }
    } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const simulator = await startSimulator({ host: process.env.POINT_SIMULATOR_HOST ?? '127.0.0.1', port: Number(process.env.POINT_SIMULATOR_PORT ?? '8187') })
  console.log(JSON.stringify({ ready: true, url: simulator.url }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await simulator.close(); process.exit(0) })
}
