import { useCallback, useEffect, useRef, useState } from 'react'
import type { BusinessPeriodReport, ReportPeriod } from '../../lib/operations-contracts'
import { posRequest, type PosAccess } from '../../lib/pos'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'
import { businessDate } from '../../lib/reporting'

export interface ReportQuery { date: string; period: ReportPeriod }

interface ReportControllerState {
  scope: string
  requestedQuery: ReportQuery
  displayedQuery: ReportQuery | null
  report: BusinessPeriodReport | null
  failedQuery: ReportQuery | null
  loading: boolean
  error: string
  stale: boolean
}

const sameQuery = (left: ReportQuery, right: ReportQuery) => left.date === right.date && left.period === right.period
const initialState = (scope: string, timezone: string): ReportControllerState => ({
  scope, requestedQuery: { date: businessDate(timezone), period: 'day' },
  displayedQuery: null, report: null, failedQuery: null, loading: false, error: '', stale: false,
})

/** One in-memory snapshot shared by Inicio and Reportes for the current operator. */
export function useReportController(access: PosAccess, timezone: string, onSessionError?: (error: AccountClientError) => void, active = true, authorized = true) {
  const scope = JSON.stringify([access.businessId, access.operatorToken, access.deviceToken ?? '', authorized])
  const enabled = active && authorized
  const [state, setState] = useState(() => ({ ...initialState(scope, timezone), loading: enabled }))
  const currentState = useRef(state)
  const currentScope = useRef(scope); currentScope.current = scope
  const currentTimezone = useRef(timezone); currentTimezone.current = timezone
  const activeRef = useRef(enabled); activeRef.current = enabled
  const handler = useRef(onSessionError); handler.current = onSessionError
  const alive = useRef(true)
  const sequence = useRef(0)
  const lastRequestAt = useRef(0)
  const inFlight = useRef<{ scope: string; sequence: number; query: ReportQuery; promise: Promise<void> } | null>(null)

  const commit = useCallback((next: ReportControllerState) => {
    currentState.current = next
    setState(next)
  }, [])
  const scopedState = useCallback(() => currentState.current.scope === scope
    ? currentState.current : initialState(scope, currentTimezone.current), [scope])

  const requestReport = useCallback((query: ReportQuery): Promise<void> => {
    if (!alive.current || !activeRef.current || currentScope.current !== scope) return Promise.resolve()
    const pending = inFlight.current
    if (pending?.scope === scope && pending.sequence === sequence.current && sameQuery(pending.query, query)) return pending.promise
    const request = ++sequence.current
    lastRequestAt.current = Date.now()
    commit({ ...scopedState(), requestedQuery: query, loading: true, error: '', stale: false, failedQuery: null })
    const isCurrent = () => alive.current && activeRef.current && currentScope.current === scope && request === sequence.current
    const promise = (async () => {
      try {
        const report = await posRequest(access, { command: 'report_period', ...query })
        if (!isCurrent()) return
        commit({ ...scopedState(), requestedQuery: query, displayedQuery: query, report, loading: false, error: '', stale: false, failedQuery: null })
      } catch (error) {
        if (!isCurrent()) return
        const previous = scopedState()
        const message = error instanceof Error ? error.message : 'No pudimos cargar el reporte.'
        if (error instanceof AccountClientError && accessErrorCodes.includes(error.code)) {
          commit({ ...previous, report: null, displayedQuery: null, loading: false, error: message, stale: false, failedQuery: query })
          handler.current?.(error)
        } else {
          commit({ ...previous, requestedQuery: previous.displayedQuery ?? query, loading: false, error: message, stale: !!previous.report, failedQuery: query })
        }
      } finally {
        if (inFlight.current?.sequence === request) inFlight.current = null
      }
    })()
    inFlight.current = { scope, sequence: request, query, promise }
    return promise
  }, [scope, access.businessId, access.operatorToken, access.deviceToken, commit, scopedState])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; sequence.current++; inFlight.current = null }
  }, [])

  useEffect(() => {
    const current = scopedState()
    if (!enabled) {
      if (currentState.current.scope !== scope || current.loading) commit({ ...current, loading: false })
      return
    }
    void requestReport(current.requestedQuery)
    const revalidate = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastRequestAt.current < 1_000) return
      void requestReport(scopedState().requestedQuery)
    }
    const reconnect = () => {
      if (document.visibilityState !== 'hidden') void requestReport(scopedState().requestedQuery)
    }
    window.addEventListener('focus', revalidate)
    window.addEventListener('online', reconnect)
    document.addEventListener('visibilitychange', revalidate)
    return () => {
      sequence.current++
      inFlight.current = null
      window.removeEventListener('focus', revalidate)
      window.removeEventListener('online', reconnect)
      document.removeEventListener('visibilitychange', revalidate)
    }
  }, [enabled, scope, requestReport, scopedState, commit])

  const setDate = useCallback((date: string) => {
    const current = scopedState()
    if (!date || date === current.requestedQuery.date) return
    const query = { ...current.requestedQuery, date }
    if (activeRef.current) void requestReport(query)
    else commit({ ...current, requestedQuery: query })
  }, [scopedState, requestReport, commit])
  const setPeriod = useCallback((period: ReportPeriod) => {
    const current = scopedState()
    if (period === current.requestedQuery.period) return
    const query = { ...current.requestedQuery, period }
    if (activeRef.current) void requestReport(query)
    else commit({ ...current, requestedQuery: query })
  }, [scopedState, requestReport, commit])
  const refresh = useCallback(() => requestReport(scopedState().requestedQuery), [requestReport, scopedState])
  const retry = useCallback(() => {
    const current = scopedState()
    return requestReport(current.failedQuery ?? current.requestedQuery)
  }, [requestReport, scopedState])

  // A render in a new access scope must hide the prior operator's figures before effects run.
  const visible = state.scope === scope ? state : initialState(scope, timezone)
  const loading = enabled && (visible.loading || state.scope !== scope || (!visible.report && !visible.error))
  return {
    report: visible.report, date: visible.requestedQuery.date, period: visible.requestedQuery.period,
    requestedQuery: visible.requestedQuery, displayedQuery: visible.displayedQuery,
    loading, initialLoading: loading && !visible.report, error: visible.error, stale: visible.stale,
    setDate, setPeriod, refresh, retry,
  }
}

export type ReportController = ReturnType<typeof useReportController>

export function usePeriodReport(access: PosAccess, date: string, period: ReportPeriod, onSessionError?: (error: AccountClientError) => void) {
  const key = `${access.businessId}:${access.operatorToken}:${access.deviceToken ?? ''}:${date}:${period}`
  const [result, setResult] = useState<{ key: string; report: BusinessPeriodReport } | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const currentKey = useRef(key); currentKey.current = key
  const sequence = useRef(0)
  const handler = useRef(onSessionError); handler.current = onSessionError
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    try {
      const report = await posRequest(access, { command: 'report_period', date, period })
      if (request !== sequence.current || currentKey.current !== key) return
      setResult({ key, report }); setFailure(null)
    } catch (error) {
      if (request !== sequence.current || currentKey.current !== key) return
      setFailure({ key, message: error instanceof Error ? error.message : 'No pudimos cargar el reporte.' })
      if (error instanceof AccountClientError && accessErrorCodes.includes(error.code)) { setResult(null); handler.current?.(error) }
    } finally { if (request === sequence.current) setLoading(false) }
  }, [key, date, period, access.businessId, access.operatorToken, access.deviceToken])
  useEffect(() => {
    void refresh()
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh() }
    window.addEventListener('online', focus); window.addEventListener('focus', focus)
    return () => { sequence.current++; window.removeEventListener('online', focus); window.removeEventListener('focus', focus) }
  }, [refresh])
  return { report: result?.key === key ? result.report : null, error: failure?.key === key ? failure.message : '', loading, refresh }
}
