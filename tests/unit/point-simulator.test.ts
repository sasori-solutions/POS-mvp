import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startSimulator } from '../provider/simulator.mjs'

const receiver = '910123456'
async function request(url: string, path: string, input?: unknown, token?: string) {
  const response = await fetch(url + path, { method: input === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
  return { status: response.status, value: await response.json() }
}
function exchange(code: string) { return { grant_type: 'authorization_code', client_id: 'sim-client', client_secret: 'sim-secret', code, code_verifier: 'v'.repeat(43), test_token: true } }
function refresh(token: string) { return { grant_type: 'refresh_token', client_id: 'sim-client', client_secret: 'sim-secret', refresh_token: token, test_token: true } }
function payload(terminalId: string) { return { type: 'point', external_reference: 'synthetic-order', config: { point: { terminal_id: terminalId } }, transactions: { payments: [{ amount: '760.68' }] } } }
async function create(url: string, token: string, terminalId: string) {
  const response = await fetch(url + '/v1/orders', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-idempotency-key': 'same-key' }, body: JSON.stringify(payload(terminalId)) })
  expect(response.status).toBe(201)
  return response.json()
}

describe('local Point fixture accounts', () => {
  it('isolates OAuth identities, controls, terminals, orders, payments and webhook receivers', async () => {
    const sim = await startSimulator()
    try {
      await create(sim.url, 'sim-access-1', 'NEWLAND_N950__SERIAL-1')
      const baseline = (await request(sim.url, '/__control')).value
      const token = (await request(sim.url, '/oauth/token', exchange(`sim-code-${receiver}`))).value.access_token
      expect((await request(sim.url, '/users/me', undefined, token)).value.id).toBe(Number(receiver))
      const terminal = (await request(sim.url, '/terminals/v1/list', undefined, token)).value.data.terminals[0]
      expect(terminal.id).toBe(`NEWLAND_N950__TST${receiver}`)
      const order = await create(sim.url, token, terminal.id)
      expect(order.user_id).toBe(receiver)
      const proof = await request(sim.url, `/v1/payments/${order.transactions.payments[0].reference_id}`, undefined, token)
      expect(proof.value.collector_id).toBe(Number(receiver))
      expect(Number.isSafeInteger(proof.value.id)).toBe(true)
      expect((await request(sim.url, `/v1/orders/${order.id}`, undefined, 'sim-access-910123457-1')).status).toBe(404)
      expect(sim.webhook(order.id).body.user_id).toBe(Number(receiver))
      await request(sim.url, '/__control', { receiverId: receiver, scenario: 'revoked', terminalMode: 'STANDALONE' })
      expect((await request(sim.url, '/users/me', undefined, token)).status).toBe(401)
      expect((await request(sim.url, '/__control')).value).toEqual(baseline)
    } finally { await sim.close() }
  })

  it('rotates each account independently and retains the historical development token format', async () => {
    const sim = await startSimulator()
    try {
      const token = (await request(sim.url, '/oauth/token', exchange(`sim-code-${receiver}`))).value
      const next = await request(sim.url, '/oauth/token', refresh(token.refresh_token))
      expect(next.value.refresh_token).toBe(`sim-refresh-${receiver}-2`)
      expect((await request(sim.url, '/oauth/token', refresh(token.refresh_token))).status).toBe(401)
      const other = await request(sim.url, '/oauth/token', exchange('sim-code-910123457'))
      expect(other.value.refresh_token).toBe('sim-refresh-910123457-1')
      const development = await request(sim.url, '/oauth/token', exchange('sim-code'))
      expect(development.value).toMatchObject({ user_id: 900001, access_token: 'sim-access-1', refresh_token: 'sim-refresh-1' })
      expect(sim.state.refreshes).toBe(0)
    } finally { await sim.close() }
  })

  it('loads legacy persisted development state and retains it while fixture accounts survive restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'point-fixture-'))
    const stateFile = join(directory, 'state.json')
    let sim = await startSimulator({ stateFile })
    try {
      await create(sim.url, 'sim-access-1', 'NEWLAND_N950__SERIAL-1')
      const baseline = (await request(sim.url, '/__control')).value
      await sim.close()
      const legacy = JSON.parse(await readFile(stateFile, 'utf8'))
      delete legacy.fixtureAccounts
      await writeFile(stateFile, JSON.stringify(legacy))
      sim = await startSimulator({ stateFile })
      expect((await request(sim.url, '/__control')).value).toEqual(baseline)
      const token = (await request(sim.url, '/oauth/token', exchange(`sim-code-${receiver}`))).value.access_token
      const order = await create(sim.url, token, `NEWLAND_N950__TST${receiver}`)
      expect((await request(sim.url, '/__control', { receiverId: receiver, reset: true })).status).toBe(400)
      await sim.close()
      sim = await startSimulator({ stateFile })
      expect((await request(sim.url, `/v1/orders/${order.id}`, undefined, token)).value.id).toBe(order.id)
      expect((await request(sim.url, '/__control')).value).toEqual(baseline)
      expect((await request(sim.url, '/__control', { receiverId: '../dev', reset: true })).status).toBe(400)
      expect((await request(sim.url, '/__control')).value).toEqual(baseline)
    } finally { await sim.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
