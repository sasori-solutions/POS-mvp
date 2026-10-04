import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { PointSettings } from '../lib/point-contracts'
import { pointRequest } from '../lib/point-client'
import type { PosAccess } from '../lib/pos'
import { accessErrorCodes } from './useCatalog'

/** Recovery keeps working when new collections have been disabled. Only the backend decides capabilities. */
export function usePoint(access: PosAccess, enabled: boolean, onSessionError?: (error: AccountClientError) => void) {
  const [settings, setSettings] = useState<PointSettings | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(enabled)
  const errorHandler = useRef(onSessionError); errorHandler.current = onSessionError
  const alive = useRef(true), sequence = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current += 1 } }, [])
  const refresh = useCallback(async () => {
    if (!enabled || !navigator.onLine) return
    const request = ++sequence.current
    setLoading(true)
    try {
      const result = await pointRequest(access, { command: 'settings' })
      if (!alive.current || request !== sequence.current) return
      setSettings(result); setError('')
    } catch (caught) {
      if (!alive.current || request !== sequence.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos consultar los cobros integrados.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
    } finally { if (alive.current && request === sequence.current) setLoading(false) }
  }, [access.businessId, access.operatorToken, access.deviceToken, enabled])
  useEffect(() => {
    setSettings(null); void refresh()
    const update = () => { void refresh() }
    window.addEventListener('focus', update); window.addEventListener('online', update)
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 30_000)
    return () => { window.removeEventListener('focus', update); window.removeEventListener('online', update); window.clearInterval(interval) }
  }, [refresh])
  return { settings, setSettings, error, loading, refresh }
}
export type PointController = ReturnType<typeof usePoint>
