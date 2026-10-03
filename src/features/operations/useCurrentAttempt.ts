import { useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../../lib/account'
import type { CheckoutAttempt } from '../../lib/operations-contracts'
import { posRequest, type PosAccess } from '../../lib/pos'
import { accessErrorCodes } from '../../components/useCatalog'

type Lookup = { scope: string; id: string; snapshot: CheckoutAttempt[]; revision: number; loading: boolean; value?: CheckoutAttempt; error?: string }
const terminal = (attempt: CheckoutAttempt) => ['completed', 'aborted'].includes(attempt.status)

/** A disappeared pending attempt may have been resolved by another operator. Read it before offering further collection. */
export function useCurrentAttempt(access: PosAccess | undefined, known: CheckoutAttempt | null | undefined, pendingAttempts: CheckoutAttempt[], onSessionError?: (error: AccountClientError) => void) {
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const [retryNumber, setRetryNumber] = useState(0)
  const errorHandler = useRef(onSessionError); errorHandler.current = onSessionError
  const scope = access ? `${access.businessId}:${access.operatorToken}:${access.deviceToken ?? ''}` : ''
  const live = known ? pendingAttempts.find(a => a.id === known.id) : undefined
  const cached = lookup?.scope === scope && lookup.id === known?.id ? lookup.value : undefined
  const attempt = [known, live, cached].reduce<CheckoutAttempt | null>((latest, value) => value && (!latest || value.revision > latest.revision) ? value : latest, null)
  const needsLookup = Boolean(attempt && !terminal(attempt) && !live)
  const checked = lookup?.scope === scope && lookup.id === known?.id && lookup.snapshot === pendingAttempts && lookup.revision >= (known?.revision ?? 0)
  const loading = needsLookup && Boolean(access) && (!checked || Boolean(lookup?.loading))
  const error = needsLookup ? !access ? 'No pudimos consultar el estado del intento.' : checked ? lookup?.error ?? '' : '' : ''

  useEffect(() => {
    if (!needsLookup || !access || !known) return
    let alive = true
    const base = { scope, id: known.id, snapshot: pendingAttempts, revision: known.revision }
    setLookup(previous => ({ ...base, loading: true, value: previous?.scope === scope && previous.id === known.id ? previous.value : undefined }))
    void posRequest(access, { command: 'attempt', attemptId: known.id }).then(value => {
      if (value.id !== known.id || !Number.isInteger(value.revision) || value.revision < known.revision || !['prepared', 'collection_started', 'uncertain', 'completed', 'aborted'].includes(value.status)) throw new Error('No pudimos confirmar el estado actual del intento.')
      if (alive) setLookup({ ...base, loading: false, value })
    }).catch(caught => {
      if (!alive) return
      setLookup({ ...base, loading: false, error: caught instanceof Error ? caught.message : 'No pudimos consultar el estado del intento.' })
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) errorHandler.current?.(caught)
    })
    return () => { alive = false }
  }, [scope, known?.id, known?.revision, live, pendingAttempts, needsLookup, retryNumber])

  return { attempt, loading, error, blocked: loading || Boolean(error), retry: () => setRetryNumber(n => n + 1) }
}
