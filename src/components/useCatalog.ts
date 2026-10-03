import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { PaymentMethod } from '../lib/contracts'
import type { Product } from '../lib/pos-contracts'
import { posRequest, type PosAccess } from '../lib/pos'

export const accessErrorCodes = ['AUTH_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'BUSINESS_ACCESS_DENIED', 'DEVICE_REVOKED', 'EMPLOYEE_INACTIVE', 'DEVICE_LINK_REQUIRED', 'DEVICE_APPROVAL_REQUIRED', 'DEVICE_PROOF_INVALID', 'PERMISSION_DENIED']

export function useCatalog(access: PosAccess, enabled: boolean, onSessionError?: (error: AccountClientError) => void) {
  const [products, setProducts] = useState<Product[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(enabled)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const sequence = useRef(0)
  const inFlight = useRef<{ sequence: number; promise: Promise<void> } | null>(null)
  const errorHandler = useRef(onSessionError)
  errorHandler.current = onSessionError
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current += 1 } }, [])

  const refresh = useCallback(() => {
    if (!enabled) return Promise.resolve()
    if (inFlight.current?.sequence === sequence.current) return inFlight.current.promise
    const request = ++sequence.current
    setLoading(true)
    const promise = (async () => {
      try {
        const catalog = await posRequest(access, { command: 'catalog' })
        if (!alive.current || sequence.current !== request) return
        setProducts(catalog.products)
        setPaymentMethods(catalog.paymentMethods)
        setLoaded(true)
        setError('')
      } catch (caught) {
        if (!alive.current || sequence.current !== request) return
        setError(caught instanceof Error ? caught.message : 'No pudimos cargar el catálogo.')
        if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
      } finally {
        if (alive.current && sequence.current === request) setLoading(false)
        if (inFlight.current?.sequence === request) inFlight.current = null
      }
    })()
    inFlight.current = { sequence: request, promise }
    return promise
  }, [access.businessId, access.operatorToken, access.deviceToken, enabled])

  useEffect(() => {
    void refresh()
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh() }
    window.addEventListener('focus', focus)
    window.addEventListener('online', focus)
    document.addEventListener('visibilitychange', focus)
    const interval = window.setInterval(focus, 15_000)
    return () => {
      // An access change must start its own request rather than reuse the old operator's response.
      sequence.current += 1
      window.removeEventListener('focus', focus)
      window.removeEventListener('online', focus)
      document.removeEventListener('visibilitychange', focus)
      window.clearInterval(interval)
    }
  }, [refresh])

  function upsert(product: Product) {
    sequence.current += 1
    setLoading(false)
    setProducts(previous => [...previous.filter(item => item.id !== product.id), product].sort((a, b) => a.name.localeCompare(b.name, 'es')))
  }
  function remove(id: string) {
    sequence.current += 1
    setLoading(false)
    setProducts(previous => previous.filter(product => product.id !== id))
  }
  return { products, paymentMethods, loading, loaded, error, refresh, upsert, remove }
}

export type CatalogState = ReturnType<typeof useCatalog>
