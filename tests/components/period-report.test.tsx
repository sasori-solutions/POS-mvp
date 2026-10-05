// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { usePeriodReport, useReportController } from '../../src/features/operations/usePeriodReport'
import { AccountClientError } from '../../src/lib/account'
import { posRequest } from '../../src/lib/pos'
import type { BusinessPeriodReport, ReportPeriod } from '../../src/lib/operations-contracts'
import { businessDate } from '../../src/lib/reporting'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access = { businessId: 'synthetic-business', operatorToken: 'memory-only' }
const report = (date: string) => ({ startDate: date, asOf: '2026-10-03T12:00:00Z' }) as BusinessPeriodReport
function deferred() {
  let resolve!: (value: BusinessPeriodReport) => void, reject!: (reason: Error) => void
  const promise = new Promise<BusinessPeriodReport>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks() })

test('own metrics use the actor-scoped command and never reuse a business-wide snapshot', async () => {
  const next = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03')).mockReturnValueOnce(next.promise)
  const view = renderHook(({ reportScope }) => useReportController(access, 'UTC', undefined, true, true, reportScope), { initialProps: { reportScope: 'business' as 'business' | 'own' } })
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  view.rerender({ reportScope: 'own' })
  expect(view.result.current.report).toBeNull()
  expect(view.result.current.initialLoading).toBe(true)
  expect(posRequest).toHaveBeenLastCalledWith(access, { command: 'report_own_period', date: businessDate('UTC'), period: 'day' })
  await act(async () => next.resolve(report('2026-10-04')))
  expect(view.result.current.report?.startDate).toBe('2026-10-04')
})

test('losing reports permission clears the memory snapshot even while the analytics view is inactive', async () => {
  vi.mocked(posRequest).mockResolvedValue(report('2026-10-03'))
  const view = renderHook(({ active, authorized }) => useReportController(access, 'UTC', undefined, active, authorized), { initialProps: { active: true, authorized: true } })
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  view.rerender({ active: false, authorized: false })
  expect(view.result.current.report).toBeNull()
  expect(view.result.current.displayedQuery).toBeNull()
  const next = deferred()
  vi.mocked(posRequest).mockReturnValueOnce(next.promise)
  view.rerender({ active: true, authorized: true })
  expect(view.result.current.report).toBeNull()
  expect(view.result.current.initialLoading).toBe(true)
  await act(async () => { next.resolve(report('2026-10-03')) })
  expect(view.result.current.report).not.toBeNull()
})

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

test('the shared controller starts on today in the business timezone and commits the displayed query', async () => {
  const today = businessDate('America/Mexico_City')
  vi.mocked(posRequest).mockResolvedValueOnce(report(today))
  const view = renderHook(() => useReportController(access, 'America/Mexico_City'))
  await waitFor(() => expect(view.result.current.report?.startDate).toBe(today))
  expect(posRequest).toHaveBeenCalledExactlyOnceWith(access, { command: 'report_period', date: today, period: 'day' })
  expect(view.result.current.displayedQuery).toEqual({ date: today, period: 'day' })
  expect(view.result.current.requestedQuery).toEqual(view.result.current.displayedQuery)
  expect(view.result.current.initialLoading).toBe(false)
})

test('changing filters retains the confirmed snapshot and commits its query and new report together', async () => {
  const today = businessDate('UTC'), next = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report(today)).mockReturnValueOnce(next.promise)
  const view = renderHook(() => useReportController(access, 'UTC'))
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  act(() => view.result.current.setPeriod('week'))
  expect(view.result.current.period).toBe('week')
  expect(view.result.current.displayedQuery?.period).toBe('day')
  expect(view.result.current.report?.startDate).toBe(today)
  expect(view.result.current.loading).toBe(true)
  expect(view.result.current.initialLoading).toBe(false)
  await act(async () => next.resolve(report('2026-10-01')))
  expect(view.result.current.report?.startDate).toBe('2026-10-01')
  expect(view.result.current.displayedQuery).toEqual({ date: today, period: 'week' })
  expect(view.result.current.loading).toBe(false)
  expect(posRequest).toHaveBeenCalledTimes(2)
})

test('a failed filter restores the confirmed selection and retry remembers the failed query', async () => {
  const today = businessDate('UTC')
  vi.mocked(posRequest).mockResolvedValueOnce(report(today)).mockRejectedValueOnce(new Error('Sin conexión'))
  const view = renderHook(() => useReportController(access, 'UTC'))
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  act(() => view.result.current.setPeriod('month'))
  await waitFor(() => expect(view.result.current.error).toBe('Sin conexión'))
  expect(view.result.current.period).toBe('day')
  expect(view.result.current.requestedQuery).toEqual(view.result.current.displayedQuery)
  expect(view.result.current.report?.startDate).toBe(today)
  expect(view.result.current.stale).toBe(true)
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-01'))
  await act(async () => { await view.result.current.retry() })
  expect(posRequest).toHaveBeenLastCalledWith(access, { command: 'report_period', date: today, period: 'month' })
  expect(view.result.current.period).toBe('month')
  expect(view.result.current.error).toBe('')
  expect(view.result.current.stale).toBe(false)
})

test('a failed refresh retains explicitly stale data and revocation clears the controller snapshot', async () => {
  const onSessionError = vi.fn()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03'))
  const view = renderHook(() => useReportController(access, 'UTC', onSessionError))
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  vi.mocked(posRequest).mockRejectedValueOnce(new Error('Sin conexión'))
  await act(async () => { await view.result.current.refresh() })
  expect(view.result.current.report).not.toBeNull()
  expect(view.result.current.stale).toBe(true)
  const revoked = new AccountClientError('PERMISSION_DENIED', 'Permiso revocado')
  vi.mocked(posRequest).mockRejectedValueOnce(revoked)
  await act(async () => { await view.result.current.refresh() })
  expect(view.result.current.report).toBeNull()
  expect(view.result.current.displayedQuery).toBeNull()
  expect(view.result.current.stale).toBe(false)
  expect(onSessionError).toHaveBeenCalledExactlyOnceWith(revoked)
})

test('rapid filter changes discard earlier results and earlier permission failures', async () => {
  const onSessionError = vi.fn(), week = deferred(), month = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03')).mockReturnValueOnce(week.promise).mockReturnValueOnce(month.promise)
  const view = renderHook(() => useReportController(access, 'UTC', onSessionError))
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  act(() => view.result.current.setPeriod('week'))
  act(() => view.result.current.setPeriod('month'))
  await act(async () => month.resolve(report('2026-10-01')))
  await act(async () => week.reject(new AccountClientError('SESSION_INVALID', 'Respuesta anterior')))
  expect(view.result.current.displayedQuery?.period).toBe('month')
  expect(view.result.current.report?.startDate).toBe('2026-10-01')
  expect(view.result.current.error).toBe('')
  expect(onSessionError).not.toHaveBeenCalled()
})

test('date and period selections in the same render use the latest requested query', async () => {
  const dateRequest = deferred(), periodRequest = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03')).mockReturnValueOnce(dateRequest.promise).mockReturnValueOnce(periodRequest.promise)
  const view = renderHook(() => useReportController(access, 'UTC'))
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  act(() => {
    view.result.current.setDate('2026-09-02')
    view.result.current.setPeriod('week')
  })
  expect(posRequest).toHaveBeenLastCalledWith(access, { command: 'report_period', date: '2026-09-02', period: 'week' })
  await act(async () => periodRequest.reject(new Error('Sin conexión')))
  expect(view.result.current.requestedQuery).toEqual(view.result.current.displayedQuery)
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-08-31'))
  await act(async () => { await view.result.current.retry() })
  await act(async () => dateRequest.resolve(report('2026-09-02')))
  expect(view.result.current.displayedQuery).toEqual({ date: '2026-09-02', period: 'week' })
  expect(view.result.current.report?.startDate).toBe('2026-08-31')
})

test('a previous operator response cannot revoke the new controller scope', async () => {
  const old = deferred(), onSessionError = vi.fn()
  vi.mocked(posRequest).mockReturnValueOnce(old.promise).mockResolvedValueOnce(report('2026-10-03'))
  const view = renderHook(({ token }) => useReportController({ ...access, operatorToken: token }, 'UTC', onSessionError), { initialProps: { token: 'old-session' } })
  view.rerender({ token: 'new-session' })
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  await act(async () => old.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior')))
  expect(view.result.current.report?.startDate).toBe('2026-10-03')
  expect(view.result.current.error).toBe('')
  expect(onSessionError).not.toHaveBeenCalled()
})

test.each([
  { businessId: 'different-business', operatorToken: access.operatorToken },
  { ...access, operatorToken: 'different-operator' },
  { ...access, deviceToken: 'different-device' },
])('an access scope change hides the last snapshot before the new request resolves: %o', async nextAccess => {
  const next = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03')).mockReturnValueOnce(next.promise)
  const view = renderHook(({ currentAccess }) => useReportController(currentAccess, 'UTC'), { initialProps: { currentAccess: access } })
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  view.rerender({ currentAccess: nextAccess })
  expect(view.result.current.report).toBeNull()
  expect(view.result.current.displayedQuery).toBeNull()
  expect(view.result.current.error).toBe('')
  expect(view.result.current.initialLoading).toBe(true)
  await act(async () => next.resolve(report('2026-10-04')))
  expect(view.result.current.report?.startDate).toBe('2026-10-04')
})

test('inactive reports issue no requests and activating them revalidates the retained snapshot', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03'))
  const view = renderHook(({ active }) => useReportController(access, 'UTC', undefined, active), { initialProps: { active: false } })
  act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')) })
  expect(posRequest).not.toHaveBeenCalled()
  expect(view.result.current.loading).toBe(false)
  view.rerender({ active: true })
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  view.rerender({ active: false })
  act(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')) })
  expect(posRequest).toHaveBeenCalledTimes(1)
  expect(view.result.current.report?.startDate).toBe('2026-10-03')
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-04'))
  view.rerender({ active: true })
  await waitFor(() => expect(view.result.current.report?.startDate).toBe('2026-10-04'))
  expect(posRequest).toHaveBeenCalledTimes(2)
})

test('deactivation invalidates pending responses without losing the confirmed snapshot', async () => {
  const pending = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03')).mockReturnValueOnce(pending.promise)
  const view = renderHook(({ active }) => useReportController(access, 'UTC', undefined, active), { initialProps: { active: true } })
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  act(() => view.result.current.setPeriod('week'))
  view.rerender({ active: false })
  await act(async () => pending.resolve(report('2026-10-01')))
  expect(view.result.current.report?.startDate).toBe('2026-10-03')
  expect(view.result.current.displayedQuery?.period).toBe('day')
  expect(view.result.current.loading).toBe(false)
})

test('manual refresh and focus or reconnection events reuse the active request', async () => {
  const pending = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03')).mockReturnValueOnce(pending.promise)
  const view = renderHook(() => useReportController(access, 'UTC'))
  await waitFor(() => expect(view.result.current.report).not.toBeNull())
  let first!: Promise<void>, second!: Promise<void>
  act(() => {
    first = view.result.current.refresh()
    second = view.result.current.refresh()
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
  })
  expect(first).toBe(second)
  expect(posRequest).toHaveBeenCalledTimes(2)
  await act(async () => { pending.resolve(report('2026-10-04')); await first })
  expect(view.result.current.report?.startDate).toBe('2026-10-04')
  expect(posRequest).toHaveBeenCalledTimes(2)
})

test('an initial failure leaves no report and can retry without producing a fake zero snapshot', async () => {
  vi.mocked(posRequest).mockRejectedValueOnce(new Error('Sin conexión'))
  const view = renderHook(() => useReportController(access, 'UTC'))
  await waitFor(() => expect(view.result.current.error).toBe('Sin conexión'))
  expect(view.result.current.report).toBeNull()
  expect(view.result.current.displayedQuery).toBeNull()
  expect(view.result.current.initialLoading).toBe(false)
  vi.mocked(posRequest).mockResolvedValueOnce(report('2026-10-03'))
  await act(async () => { await view.result.current.retry() })
  expect(view.result.current.report?.startDate).toBe('2026-10-03')
  expect(view.result.current.error).toBe('')
})

test('late revocation after unmount cannot call the session handler', async () => {
  const pending = deferred(), onSessionError = vi.fn()
  vi.mocked(posRequest).mockReturnValueOnce(pending.promise)
  const view = renderHook(() => useReportController(access, 'UTC', onSessionError))
  view.unmount()
  await act(async () => pending.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior')))
  expect(onSessionError).not.toHaveBeenCalled()
})
