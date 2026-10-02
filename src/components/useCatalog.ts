import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { PaymentMethod } from '../lib/contracts'
import type { Product } from '../lib/pos-contracts'
import { posRequest, type PosAccess } from '../lib/pos'

export const accessErrorCodes = ['AUTH_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'BUSINESS_ACCESS_DENIED', 'DEVICE_REVOKED', 'EMPLOYEE_INACTIVE', 'DEVICE_LINK_REQUIRED', 'DEVICE_APPROVAL_REQUIRED', 'DEVICE_PROOF_INVALID']

export function useCatalog(access: PosAccess, enabled: boolean, onSessionError?: (error: AccountClientError) => void) {
  const [products, setProducts] = useState<Product[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(enabled)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const sequence = useRef(0)
  const errorHandler = useRef(onSessionError)
  errorHandler.current = onSessionError
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current += 1 } }, [])

  const refresh = useCallback(async () => {
    if (!enabled) return
    const request = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const catalog = await posRequest(access, { command: 'catalog' })
      if (!alive.current || sequence.current !== request) return
      setProducts(catalog.products)
      setPaymentMethods(catalog.paymentMethods)
      setLoaded(true)
    } catch (caught) {
      if (!alive.current || sequence.current !== request) return
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar el catálogo.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
    } finally { if (alive.current && sequence.current === request) setLoading(false) }
  }, [access.businessId, access.operatorToken, access.deviceToken, enabled])

  useEffect(() => {
    void refresh()
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    window.addEventListener('online', focus)
    const interval = window.setInterval(focus, 60_000)
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('online', focus); window.clearInterval(interval) }
  }, [refresh])

  function upsert(product: Product) {
    sequence.current += 1
    setLoading(false)
    setProducts(previous => [...previous.filter(item => item.id !== product.id), product].sort((a, b) => a.name.localeCompare(b.name, 'es')))
  }
  return { products, paymentMethods, loading, loaded, error, refresh, upsert }
}

export type CatalogState = ReturnType<typeof useCatalog>
