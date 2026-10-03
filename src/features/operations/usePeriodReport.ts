import { useCallback, useEffect, useRef, useState } from 'react'
import type { BusinessPeriodReport, ReportPeriod } from '../../lib/operations-contracts'
import { posRequest, type PosAccess } from '../../lib/pos'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'

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
