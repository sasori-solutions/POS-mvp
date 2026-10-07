import { describe, expect, it, vi } from 'vitest'
import { authorizedPointRpcClient } from '../../supabase/functions/point/service'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

describe('Point RPC browser context from verified Edge proof', () => {
  it('transports only the verified hash into Point settings and service calls', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { connected: true }, error: null })
    const hash = 'a'.repeat(64), client = authorizedPointRpcClient({ rpc }, hash)
    const payload = { operatorToken: 'synthetic-operator', stateHash: 'synthetic-state', serverDeviceKeyHash: 'b'.repeat(64) }
    await client.rpc('point_service', { p_action: 'oauth_connection_save', p_payload: payload })
    await client.rpc('point_execute', { p_user_id: 'synthetic-owner', p_payload: { command: 'settings' } })
    expect(rpc.mock.calls).toEqual([
      ['point_service', { p_action: 'oauth_connection_save', p_payload: { ...payload, serverDeviceKeyHash: hash } }],
      ['point_execute', { p_user_id: 'synthetic-owner', p_payload: { command: 'settings', serverDeviceKeyHash: hash } }],
    ])
    expect(payload.serverDeviceKeyHash).toBe('b'.repeat(64))
  })
  it('never borrows an unverified hash or modifies the restricted device or worker call', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null })
    const client = authorizedPointRpcClient({ rpc }, null)
    await client.rpc('point_service', { p_action: 'claim_jobs', p_payload: { limit: 20, serverDeviceKeyHash: 'a'.repeat(64) } })
    await client.rpc('point_device', { p_payload: { command: 'settings' } })
    expect(rpc.mock.calls).toEqual([
      ['point_service', { p_action: 'claim_jobs', p_payload: { limit: 20 } }],
      ['point_device', { p_payload: { command: 'settings' } }],
    ])
  })
  it('keeps the server-only field outside the exact HTTP command contract', () => {
    const request = { action: 'point', businessId: '93d511be-8863-4d9a-8d61-d3dd883e0770', operatorToken: 'a'.repeat(64), command: 'settings' }
    expect(parseAccountRequest(request).action).toBe('point')
    expect(() => parseAccountRequest({ ...request, serverDeviceKeyHash: 'a'.repeat(64) })).toThrow()
    expect(() => authorizedPointRpcClient({ rpc: vi.fn() }, 'invalid')).toThrow('POINT_SERVICE_UNAVAILABLE')
  })
})
