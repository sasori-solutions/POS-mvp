// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readOperation, useOperationalMutation } from '../../src/features/operations/useOperations'
import { AccountClientError } from '../../src/lib/account'
import type { PromotionCommand } from '../../src/lib/promotion-contracts'
import { posRequest, type PosAccess } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const access: PosAccess = { businessId: id(1), operatorToken: 'synthetic-memory-only' }
const employee = id(2), key = `pos-operations:${access.businessId}:${employee}`
const save: Extract<PromotionCommand, { command: 'save_promotion' }> = {
  command: 'save_promotion', operationId: 'A1B2C3D4-0000-4000-8000-000000000003', promotionId: id(4), expectedRevision: null,
  name: '  Cafe\u0301   especial ', active: true, kind: 'percent', value: 1000,
  scope: { productIds: [id(6), id(5)], categories: [' Postres ', 'Cafe\u0301'] },
}
const apply: Extract<PromotionCommand, { command: 'apply_order_promotion' }> = {
  command: 'apply_order_promotion', operationId: 'A1B2C3D4-0000-4000-8000-000000000007', orderId: id(8),
  expectedRevision: 2, promotionId: id(4), promotionRevision: 1,
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_key: string, callback: () => unknown) => callback()) } })
})
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals() })

test.each([
  { command: 'save_promotion', operationId: id(3) },
  { ...save, value: undefined },
  { ...save, value: 10001 },
  { ...save, scope: { productIds: null, categories: ['Bebidas'] } },
  { ...save, scope: { productIds: [], categories: Array.from({ length: 25 }, (_, index) => `Categoría ${index}`) } },
  { ...save, scope: { productIds: [], categories: ['Cafe\u0301', 'Café'] } },
  { ...save, scope: { productIds: [], categories: [] } },
  { ...save, unrecognized: true },
  { command: 'apply_order_promotion', operationId: id(7) },
  { ...apply, expectedRevision: 0 },
  { ...apply, promotionRevision: '1' },
  { ...apply, promotionId: 'unrecognized' },
])('corrupt promotion recovery is retained for review without exposing a draft: %j', value => {
  const raw = JSON.stringify(value)
  localStorage.setItem(key, raw)
  expect(() => readOperation(key)).toThrow('El reintento guardado necesita revisión.')
  const view = renderHook(() => useOperationalMutation(access, employee))
  expect(view.result.current.pending).toBeNull()
  expect(view.result.current.error).toBe('No pudimos leer el reintento guardado. Conserva este dispositivo y pide ayuda.')
  expect(localStorage.getItem(key)).toBe(raw)
  expect(posRequest).not.toHaveBeenCalled()
})

test.each([save, apply])('a lost $command response replays the original UUID, text and selector order after reload', async command => {
  const raw = JSON.stringify(command)
  vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Respuesta perdida')).mockResolvedValueOnce({ accepted: true } as never)
  const first = renderHook(() => useOperationalMutation(access, employee))
  await act(async () => { await expect(first.result.current.execute(command)).rejects.toThrow('Respuesta perdida') })
  expect(localStorage.getItem(key)).toBe(raw)
  expect(readOperation(key)).toEqual(command)
  first.unmount()

  const nextAccess = { ...access, operatorToken: 'synthetic-next-session' }
  const second = renderHook(() => useOperationalMutation(nextAccess, employee))
  expect(second.result.current.pending).toEqual(command)
  await act(async () => { await second.result.current.execute(second.result.current.pending!) })
  expect(posRequest).toHaveBeenNthCalledWith(1, access, command)
  expect(posRequest).toHaveBeenNthCalledWith(2, nextAccess, command)
  expect(JSON.stringify(vi.mocked(posRequest).mock.calls[1][1])).toBe(raw)
  expect(localStorage.getItem(key)).toBeNull()
  expect(second.result.current.pending).toBeNull()
})

test('invalid new promotion payloads fail before storage and the HTTP mutation', async () => {
  const view = renderHook(() => useOperationalMutation(access, employee))
  await act(async () => { await expect(view.result.current.execute({ ...save, scope: { productIds: [], categories: [] } })).rejects.toThrow('El reintento guardado necesita revisión.') })
  expect(localStorage.getItem(key)).toBeNull()
  expect(posRequest).not.toHaveBeenCalled()
})
