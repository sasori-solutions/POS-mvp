import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { PointSettings } from '../lib/point-contracts'
import { pointRequest } from '../lib/point-client'
import type { PosAccess } from '../lib/pos'
import { accessErrorCodes } from './useCatalog'

/** Private results and pending work are scoped to the exact unlocked session. */
export function usePoint(access: PosAccess, enabled: boolean, onSessionError?: (error: AccountClientError) => void) {
  const scope = `${access.businessId}:${access.operatorToken}:${access.deviceToken ?? ''}:${enabled}`
  const currentScope = useRef(scope), alive = useRef(true), sequence = useRef(0)
  if (currentScope.current !== scope) { currentScope.current = scope; sequence.current += 1 }
  const [state, setState] = useState<{ scope: string; settings: PointSettings | null; error: string; loading: boolean }>({ scope, settings: null, error: '', loading: enabled && navigator.onLine })
  const errorHandler = useRef(onSessionError); errorHandler.current = onSessionError
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current += 1 } }, [])
  const setSettings = useCallback((settings: PointSettings | null) => {
    if (!alive.current || currentScope.current !== scope || !enabled) return
    sequence.current += 1
    setState({ scope, settings, error: '', loading: false })
  }, [scope, enabled])
  const refresh = useCallback(async () => {
    if (!enabled || !navigator.onLine || currentScope.current !== scope) return
    const request = ++sequence.current
    const current = () => alive.current && currentScope.current === scope && request === sequence.current
    setState(previous => ({ scope, settings: previous.scope === scope ? previous.settings : null, error: '', loading: true }))
    try {
      const settings = await pointRequest(access, { command: 'settings' })
      if (current()) setState({ scope, settings, error: '', loading: false })
    } catch (caught) {
      if (!current()) return
      setState(previous => ({ ...previous, error: caught instanceof Error ? caught.message : 'No pudimos consultar los cobros integrados.', loading: false }))
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
    }
  }, [access.businessId, access.operatorToken, access.deviceToken, enabled, scope])
  useEffect(() => {
    setState({ scope, settings: null, error: '', loading: enabled && navigator.onLine })
    void refresh()
    const update = () => { void refresh() }
    window.addEventListener('focus', update); window.addEventListener('online', update)
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 30_000)
    return () => { sequence.current += 1; window.removeEventListener('focus', update); window.removeEventListener('online', update); window.clearInterval(interval) }
  }, [refresh])
  const visible = enabled && state.scope === scope
  return { settings: visible ? state.settings : null, setSettings, error: visible ? state.error : '', loading: enabled && (visible ? state.loading : navigator.onLine), refresh }
}
export type PointController = ReturnType<typeof usePoint>
