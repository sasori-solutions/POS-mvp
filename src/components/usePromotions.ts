import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { Promotion } from '../lib/promotion-contracts'
import { posRequest, type PosAccess } from '../lib/pos'
import { accessErrorCodes } from './useCatalog'
import { parsePromotionCommand } from '../../supabase/functions/account/promotion-validation'

export function usePromotions(access: PosAccess, onSessionError?: (error: AccountClientError) => void) {
  const [promotions, setPromotions] = useState<Promotion[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const sequence = useRef(0), alive = useRef(false), errorHandler = useRef(onSessionError)
  errorHandler.current = onSessionError
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current
    setLoading(true)
    try {
      const response = await posRequest(access, { command: 'promotions' })
      if (!Array.isArray(response.promotions)) throw new Error('No pudimos consultar las promociones. Vuelve a intentar.')
      for (const promotion of response.promotions) {
        if (!promotion || Object.keys(promotion).length !== 7) throw new Error('No pudimos consultar las promociones. Vuelve a intentar.')
        parsePromotionCommand({ command: 'save_promotion', operationId: promotion.id, promotionId: promotion.id, expectedRevision: promotion.revision,
          name: promotion.name, active: promotion.active, kind: promotion.kind, value: promotion.value, scope: promotion.scope }, [])
      }
      if (alive.current && ticket === sequence.current) { setPromotions(response.promotions); setError('') }
    } catch (caught) {
      if (!alive.current || ticket !== sequence.current) return
      setPromotions([]); setError(caught instanceof Error ? caught.message : 'No pudimos consultar las promociones.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
    } finally { if (alive.current && ticket === sequence.current) setLoading(false) }
  }, [access.businessId, access.operatorToken, access.deviceToken])
  useEffect(() => { alive.current = true; setPromotions([]); void refresh(); return () => { alive.current = false; sequence.current++ } }, [refresh])
  return { promotions, loading, error, refresh }
}
