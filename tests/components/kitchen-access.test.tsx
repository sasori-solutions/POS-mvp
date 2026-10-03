// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import OrdersScreen from '../../src/features/operations/OrdersScreen'
import { AccountClientError } from '../../src/lib/account'
import type { BusinessContext } from '../../src/lib/contracts'
import type { OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import { posRequest } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const business: BusinessContext = { id: 'business', name: 'Cocina sintética', businessType: 'cafe', role: 'cashier', permissions: ['kitchen.read'], timezone: 'America/Mexico_City', currency: 'MXN', createdAt: '2026-10-02T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
const mutation: OperationalMutation = { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
const snapshot: OperationsSnapshot = { enabled: false, shift: null, orders: [], tables: [], attempts: [] }
afterEach(() => { cleanup(); vi.clearAllMocks() })

test('does not query an inactive kitchen before owner cutover', () => {
  render(<OrdersScreen business={business} access={{ businessId: business.id, operatorToken: 'synthetic-memory-only' }} snapshot={snapshot} mutation={mutation} onOrder={vi.fn()} onNew={vi.fn()} refresh={vi.fn()} />)
  expect(posRequest).not.toHaveBeenCalled()
})

test('a current kitchen permission refusal invalidates loaded access through the session handler', async () => {
  const error = new AccountClientError('PERMISSION_DENIED', 'Permiso revocado'), onSessionError = vi.fn()
  vi.mocked(posRequest).mockRejectedValueOnce(error)
  render(<OrdersScreen business={business} access={{ businessId: business.id, operatorToken: 'synthetic-memory-only' }} snapshot={{ ...snapshot, enabled: true }} mutation={mutation} onOrder={vi.fn()} onNew={vi.fn()} refresh={vi.fn()} onSessionError={onSessionError} />)
  await waitFor(() => expect(onSessionError).toHaveBeenCalledWith(error))
})
