import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { SharedModifierGroup } from '../lib/pos-contracts'
import { posRequest, type PosAccess } from '../lib/pos'
import { accessErrorCodes } from './useCatalog'

export function useModifierLibrary(access: PosAccess, enabled: boolean, onSessionError?: (error: AccountClientError) => void) {
  const [groups, setGroups] = useState<SharedModifierGroup[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const current = useRef(0), alive = useRef(true), errorHandler = useRef(onSessionError)
  errorHandler.current = onSessionError
  useEffect(() => { alive.current = true; return () => { alive.current = false; current.current++ } }, [])
  const refresh = useCallback(async () => {
    if (!enabled) return
    const sequence = ++current.current
    setLoading(true)
    try {
      const result = await posRequest(access, { command: 'modifier_groups' })
      if (!alive.current || sequence !== current.current) return
      setGroups(result.groups); setError('')
    } catch (caught) {
      if (!alive.current || sequence !== current.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar la biblioteca de extras.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
    } finally { if (alive.current && sequence === current.current) setLoading(false) }
  }, [access.businessId, access.operatorToken, access.deviceToken, enabled])
  useEffect(() => { void refresh(); return () => { current.current++ } }, [refresh])
  return { groups, loading, error, refresh }
}
