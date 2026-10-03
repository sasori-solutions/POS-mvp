// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { usePeriodReport } from '../../src/features/operations/usePeriodReport'
import { AccountClientError } from '../../src/lib/account'
import { posRequest } from '../../src/lib/pos'
import type { BusinessPeriodReport, ReportPeriod } from '../../src/lib/operations-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access = { businessId: 'synthetic-business', operatorToken: 'memory-only' }
const report = (date: string) => ({ startDate: date, asOf: '2026-10-03T12:00:00Z' }) as BusinessPeriodReport
function deferred() {
  let resolve!: (value: BusinessPeriodReport) => void, reject!: (reason: Error) => void
  const promise = new Promise<BusinessPeriodReport>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('filter changes hide prior figures immediately and discard late responses', async () => {
  const first = deferred(), second = deferred()
  vi.mocked(posRequest).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const view = renderHook(({ date, period }) => usePeriodReport(access, date, period), { initialProps: { date: '2026-10-02', period: 'day' as ReportPeriod } })
  view.rerender({ date: '2026-10-03', period: 'week' })
  expect(view.result.current.report).toBeNull()
  await act(async () => { second.resolve(report('2026-10-03')) })
  await act(async () => { first.resolve(report('2026-10-02')) })
  expect(view.result.current.report?.startDate).toBe('2026-10-03')
  expect(posRequest).toHaveBeenLastCalledWith(access, { command: 'report_period', date: '2026-10-03', period: 'week' })
  vi.mocked(posRequest).mockReturnValueOnce(new Promise(() => {}))
  view.rerender({ date: '2026-10-04', period: 'day' })
  expect(view.result.current.report).toBeNull()
})

test('failed same-filter refresh keeps explicitly stale data, while revocation clears private figures', async () => {
  const onSessionError = vi.fn()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03'))
  const view = renderHook(() => usePeriodReport(access, '2026-10-03', 'day', onSessionError))
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  vi.mocked(posRequest).mockRejectedValueOnce(new Error('Sin conexión'))
  await act(async () => { await view.result.current.refresh() })
  expect(view.result.current.report).not.toBeNull()
  expect(view.result.current.error).toBe('Sin conexión')
  const revoked = new AccountClientError('PERMISSION_DENIED', 'Permiso revocado')
  vi.mocked(posRequest).mockRejectedValueOnce(revoked)
  await act(async () => { await view.result.current.refresh() })
  expect(view.result.current.report).toBeNull()
  expect(onSessionError).toHaveBeenCalledWith(revoked)
})

test('a late revoked response from an old session cannot invalidate the new operator', async () => {
  const old = deferred(), onSessionError = vi.fn()
  vi.mocked(posRequest).mockReturnValueOnce(old.promise).mockResolvedValueOnce(report('2026-10-03'))
  const view = renderHook(({ token }) => usePeriodReport({ ...access, operatorToken: token }, '2026-10-03', 'day', onSessionError), { initialProps: { token: 'old-session' } })
  view.rerender({ token: 'new-session' })
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  await act(async () => { old.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior')) })
  expect(onSessionError).not.toHaveBeenCalled()
  expect(view.result.current.error).toBe('')
  expect(view.result.current.report).not.toBeNull()
})
