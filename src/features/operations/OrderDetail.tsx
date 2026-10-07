import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { BusinessContext, PaymentMethod } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { BalanceWaiver, CheckoutAttempt, OperationalOrder, OrderDiscount } from '../../lib/operations-contracts'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import { CheckoutClosingContext, CheckoutInteractionContext } from '../../components/CheckoutPanel'
import { paymentLabels } from '../../components/PosShared'
import PaymentMethodPicker from '../../components/PaymentMethodPicker'
import ExternalCardConfirmation from '../../components/ExternalCardConfirmation'
import AttemptPanel from './AttemptPanel'
import type { OperationalMutation } from './useOperations'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'
import { checkoutTotals, checkoutSelectionKey, type CheckoutDraft } from '../../lib/checkout-selection'
import { collectionPaymentMethod, collectionPaymentMethods, isManualCollectionMethod, pointCardReady } from '../../lib/payment-methods'
import { useCurrentAttempt } from './useCurrentAttempt'
import PointPayment from '../../components/PointPayment'
import type { PointCheckout, PointSettings } from '../../lib/point-contracts'
import { PendingIndicator } from '../../components/LoadingPlaceholder'
import OrderDiscountEditor from './OrderDiscountEditor'
import { amountInput, amountPlan, checkoutAmountTotals } from '../../lib/checkout-amounts'
import CheckoutAmountSelection from './CheckoutAmountSelection'
import CheckoutItemSelection from './CheckoutItemSelection'
import CheckoutPaymentTransition from './CheckoutPaymentTransition'
import './checkout-selection.css'

export default function OrderDetail({ order, business, methods: configuredMethods, attempts, mutation, onSaved, onPaymentRecorded, onReceipt, onEdit, refresh, collectionAllowed, access, onSessionError, checkoutView = false, serviceAccount = order.orderKind === 'service', onStartCheckout, onOpenCash, draft, onDraftChange, pointSettings, onPointBlocked }: { checkoutView?: boolean; serviceAccount?: boolean; onStartCheckout?: () => void; order: OperationalOrder; business: BusinessContext; methods: PaymentMethod[]; attempts: CheckoutAttempt[]; mutation: OperationalMutation; onSaved: (order: OperationalOrder) => void; onPaymentRecorded?: (order: OperationalOrder, saleId?: string) => void; onReceipt?: (saleId: string) => void; onEdit: () => void; refresh: () => Promise<void>; collectionAllowed: boolean; access?: PosAccess; onSessionError?: (error: AccountClientError) => void; onOpenCash?: () => void; draft?: CheckoutDraft; onDraftChange?: (draft: CheckoutDraft) => void; pointSettings?: PointSettings | null; onPointBlocked?: (blocked: boolean) => void }) {
  const checkoutEnabled = checkoutView || !onStartCheckout
  const choices = collectionPaymentMethods(configuredMethods)
  const cardReady = pointCardReady(configuredMethods, pointSettings)
  const cardHint = pointSettings?.chargesEnabled === false ? 'Los cobros con Mercado Pago Point están pausados.'
    : !configuredMethods.includes('card_integrated')
      ? business.role === 'owner' ? 'Activa Mercado Pago Point en Formas de pago.' : 'El dueño debe activar Mercado Pago Point en Formas de pago.'
      : 'Vincula una terminal Point para cobrar con Mercado Pago.'
  const methods = choices.filter(method => method !== 'card_integrated' || cardReady)
  const methodsKey = methods.join('|')
  const [pointBusy, setPointBusy] = useState(false)
  const checkoutClosing = useContext(CheckoutClosingContext)
  const lockCheckoutInteraction = useContext(CheckoutInteractionContext)
  const workflowGeneration = useRef(0)
  const closingRef = useRef(checkoutClosing); closingRef.current = checkoutClosing
  useEffect(() => {
    workflowGeneration.current++
    return () => { workflowGeneration.current++ }
  }, [order.id, access?.businessId, access?.operatorToken, access?.deviceToken])
  const recovered = useRef(attempts.find(a => a.orderId === order.id && a.kind === 'payment'))
  const initialDraft = useRef(draft?.orderId === order.id ? draft : undefined)
  const selectionAttemptId = useRef(recovered.current?.id ?? null)
  const [split, setSplit] = useState(() => recovered.current ? !recovered.current.amountsCents && order.items.some(l => (recovered.current!.items.find(i => i.lineId === l.lineId)?.quantity ?? 0) !== l.quantity - l.paidQuantity) : initialDraft.current?.split ?? false)
  const initialAmounts = recovered.current?.amountsCents ?? (order.amountParts?.length ? order.amountParts : undefined)
  const [amountSplit, setAmountSplit] = useState(Boolean(recovered.current?.amountsCents || initialDraft.current?.amountSplit || order.amountSplit))
  const [amountInputs, setAmountInputs] = useState<string[]>(initialAmounts ? initialAmounts.slice(0, -1).map(amountInput) : initialDraft.current?.amountInputs ?? [''])
  const [paymentRevision, setPaymentRevision] = useState(0)
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries(order.items.map(l => [l.lineId, Math.min(l.quantity - l.paidQuantity, recovered.current ? recovered.current.items.find(i => i.lineId === l.lineId)?.quantity ?? 0 : initialDraft.current?.quantities[l.lineId] ?? 0)])))
  const [method, setMethod] = useState<PaymentMethod>(() => recovered.current
    ? recovered.current.status === 'prepared' ? collectionPaymentMethod(recovered.current.paymentMethod) : recovered.current.paymentMethod
    : initialDraft.current ? collectionPaymentMethod(initialDraft.current.method) : methods[0] ?? choices[0] ?? 'cash')
  const [externalApproved, setExternalApproved] = useState(false)
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null)
  const completedAttempts = useRef(new Set<string>())
  const notifiedPayments = useRef(new Set<string>())
  const loadingPaymentResults = useRef(new Set<string>())
  const handledPaymentResult = useRef(mutation.lastResult)
  const [reason, setReason] = useState('')
  const [discountOpen, setDiscountOpen] = useState(false)
  const discountTrigger = useRef<HTMLButtonElement>(null)
  const [discountApplying, setDiscountApplying] = useState(false)
  const [discountError, setDiscountError] = useState('')
  const discountNeedsReload = useRef(false)
  const discountAbortingId = useRef<string | null>(null)
  const acceptedDiscountResults = useRef(new WeakSet<object>())
  const handledDiscountResult = useRef(mutation.lastResult)
  const [registeringPayment, setRegisteringPayment] = useState(false)
  const [sendingKitchen, setSendingKitchen] = useState(false)
  const kitchenSubmission = useRef(false)
  const paymentSubmission = useRef<number | null>(null)
  const [lastPartialPayment, setLastPartialPayment] = useState<{ amountCents: number; method: PaymentMethod; saleId?: string } | null>(null)
  useEffect(() => {
    lockCheckoutInteraction?.(discountApplying || registeringPayment)
    return () => lockCheckoutInteraction?.(false)
  }, [lockCheckoutInteraction, discountApplying, registeringPayment])
  const [waiver, setWaiver] = useState<BalanceWaiver | null>(null)
  const [waiverConfirmed, setWaiverConfirmed] = useState(false)
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const disabled = mutation.busy || Boolean(mutation.pending) || pointBusy || sendingKitchen
  const settled = ['paid', 'cancelled', 'waived', 'closed'].includes(order.status)
  const unsentItems = order.items.some(line => line.quantity > line.sentQuantity)
  const canSendKitchen = !checkoutView && serviceAccount && order.orderKind !== 'counter' && !settled && !order.frozen && order.phase === 'service' && allowed('orders.manage') && unsentItems
  const requested = useRef('')
  const reserveTimer = useRef<number | null>(null)
  const [reservationError, setReservationError] = useState(false)
  const [reservationRetry, setReservationRetry] = useState(0)
  const [preparingCheckout, setPreparingCheckout] = useState(false)
  const remaining = order.items.map(l => `${l.lineId}:${l.quantity - l.paidQuantity}`).join('|')
  const remainingKey = useRef(remaining)
  const confirmedPayment = useRef({ orderId: order.id, paidCents: order.paidCents, amountPaidParts: order.amountPaidParts ?? 0 })
  useLayoutEffect(() => {
    const previous = confirmedPayment.current
    const progress = { orderId: order.id, paidCents: order.paidCents, amountPaidParts: order.amountPaidParts ?? 0 }
    if (previous.orderId !== order.id) { confirmedPayment.current = progress; return }
    if (progress.paidCents <= previous.paidCents && progress.amountPaidParts <= previous.amountPaidParts) return
    confirmedPayment.current = progress
    // Point can refresh the paid account before its receipt's Continue action.
    // Reconcile the selection before painting the new balance, keeping that receipt.
    if (order.amountSplit) {
      setAmountSplit(true)
      setSplit(false)
      setAmountInputs((order.amountParts ?? []).slice(0, -1).map(amountInput))
    }
    setQuantities(Object.fromEntries(order.items.map(line => [line.lineId, 0])))
  }, [order.id, order.paidCents, order.amountPaidParts, order.amountSplit, order.amountParts, order.items])
  useEffect(() => {
    if (remainingKey.current !== remaining) {
      remainingKey.current = remaining
      setQuantities(previous => Object.fromEntries(order.items.map(l => [l.lineId, Math.min(previous[l.lineId] ?? 0, l.quantity - l.paidQuantity)])))
    }
  }, [order.id, remaining])
  const persistedAttempt = attempts.find(a => a.orderId === order.id && a.kind === 'payment' && !completedAttempts.current.has(a.id))
  useEffect(() => { if (persistedAttempt && (!attempt || persistedAttempt.id !== attempt.id || persistedAttempt.revision > attempt.revision)) setAttempt(persistedAttempt) }, [persistedAttempt, attempt])
  useEffect(() => {
    if (mutation.lastResult && ['prepare_checkout', 'update_checkout'].includes(mutation.lastResult.command)) {
      const accepted = mutation.lastResult.result as CheckoutAttempt
      if (accepted.orderId === order.id && !completedAttempts.current.has(accepted.id)) setAttempt(previous => !previous || accepted.id !== previous.id || accepted.revision > previous.revision ? accepted : previous)
    }
  }, [mutation.lastResult, order.id])
  useEffect(() => {
    if (mutation.lastResult?.command !== 'resolve_checkout') return
    const resolved = mutation.lastResult.result as CheckoutAttempt
    if (resolved.orderId !== order.id || resolved.id !== discountAbortingId.current || resolved.status !== 'aborted') return
    completedAttempts.current.add(resolved.id)
    discountNeedsReload.current = true
    selectionAttemptId.current = null
    requested.current = ''
    setAttempt(null)
  }, [mutation.lastResult, order.id])
  const selectedAttempt = persistedAttempt && persistedAttempt.id !== attempt?.id ? persistedAttempt : attempt ?? persistedAttempt
  const current = useCurrentAttempt(access, selectedAttempt, attempts, onSessionError)
  const currentAttempt = current.attempt
  const adoptingReservation = Boolean(currentAttempt && currentAttempt.id !== selectionAttemptId.current)
  useLayoutEffect(() => {
    if (!currentAttempt || !adoptingReservation) return
    selectionAttemptId.current = currentAttempt.id
    setMethod(currentAttempt.status === 'prepared' ? collectionPaymentMethod(currentAttempt.paymentMethod) : currentAttempt.paymentMethod)
    setQuantities(Object.fromEntries(order.items.map(l => [l.lineId, currentAttempt.items.find(i => i.lineId === l.lineId)?.quantity ?? 0])))
    setAmountSplit(Boolean(currentAttempt.amountsCents || order.amountSplit))
    if (currentAttempt.amountsCents) setAmountInputs(currentAttempt.amountsCents.slice(0, -1).map(amountInput))
    setSplit(!currentAttempt.amountsCents && order.items.some(l => (currentAttempt.items.find(i => i.lineId === l.lineId)?.quantity ?? 0) !== l.quantity - l.paidQuantity))
  }, [currentAttempt?.id, adoptingReservation])
  useLayoutEffect(() => {
    // A late authoritative result can reveal collection already in progress.
    // Restore its method before painting; changing a radio never changes that charge.
    if (currentAttempt && currentAttempt.status !== 'prepared' && method !== currentAttempt.paymentMethod) setMethod(currentAttempt.paymentMethod)
  }, [currentAttempt?.paymentMethod, currentAttempt?.status, method])
  const usingAmounts = amountSplit || Boolean(order.amountSplit)
  const amountsCents = usingAmounts ? amountSplit ? amountPlan(order.balanceCents, amountInputs) : order.balanceCents > 0 ? [order.balanceCents] : null : null
  const items = usingAmounts ? [] : order.items.map(l => ({ lineId: l.lineId, quantity: split ? Math.min(quantities[l.lineId] ?? 0, l.quantity - l.paidQuantity) : l.quantity - l.paidQuantity })).filter(l => l.quantity > 0)
  const selectionKey = usingAmounts ? JSON.stringify(amountsCents) : checkoutSelectionKey(items)
  const totals = usingAmounts ? checkoutAmountTotals(order, amountsCents?.[0] ?? 0) : checkoutTotals(order, items)
  const hasSelection = usingAmounts ? Boolean(amountsCents?.length) : items.length > 0
  const pendingLines = order.items.filter(line => line.quantity > line.paidQuantity)
  const remainderCents = Math.max(0, order.balanceCents - totals.totalCents)
  useEffect(() => {
    if (!settled) onDraftChange?.({ orderId: order.id, split, amountSplit, amountInputs, quantities, method })
  }, [order.id, split, amountSplit, amountInputs, quantities, method, settled, onDraftChange])
  function changeSplit(next: boolean) {
    if (selectionLocked || next === split && !amountSplit || next && order.amountSplit) return
    setAmountSplit(false)
    setSplit(next)
    if (next) setQuantities(Object.fromEntries(order.items.map(line => [line.lineId, 0])))
  }
  function changeAmountSplit() {
    if (selectionLocked || amountSplit) return
    setSplit(false)
    setAmountSplit(true)
    setAmountInputs(order.amountParts?.length ? order.amountParts.slice(0, -1).map(amountInput) : [''])
  }
  const reservationMatches = Boolean(hasSelection && currentAttempt?.status === 'prepared' && currentAttempt.paymentMethod === method && (usingAmounts ? JSON.stringify(currentAttempt.amountsCents) === selectionKey : !currentAttempt.amountsCents && checkoutSelectionKey(currentAttempt.items) === selectionKey) && currentAttempt.totalCents === totals.totalCents && currentAttempt.discountCents === totals.discountCents && currentAttempt.taxCents === totals.taxCents)
  useEffect(() => { setExternalApproved(false) }, [method, order.id, selectionKey, totals.totalCents, currentAttempt?.id, currentAttempt?.revision])
  const editableReservation = !pointBusy && (!currentAttempt || currentAttempt.status === 'prepared')
  const adjustingDiscount = discountOpen || discountApplying
  useEffect(() => {
    const accepted = mutation.lastResult
    if (!accepted || accepted === handledDiscountResult.current || checkoutClosing || discountApplying) return
    handledDiscountResult.current = accepted
    if (!adjustingDiscount || !['resume_order_service', 'set_order_discount'].includes(accepted.command)) return
    const saved = accepted.result as OperationalOrder
    if (saved.id !== order.id || acceptedDiscountResults.current.has(saved)) return
    acceptedDiscountResults.current.add(saved)
    discountNeedsReload.current = false
    setDiscountError('')
    if (saved.revision >= order.revision) onSaved(saved)
    if (accepted.command === 'set_order_discount') {
      setDiscountOpen(false)
      discountAbortingId.current = null
      setLastPartialPayment(null)
      requested.current = ''
    }
  }, [mutation.lastResult, checkoutClosing, discountApplying, adjustingDiscount, order.id, order.revision])
  useEffect(() => {
    const accepted = mutation.lastResult
    if (!accepted || accepted === handledPaymentResult.current) return
    handledPaymentResult.current = accepted
    if (!checkoutClosing && accepted.command === 'record_checkout') notifyRecordedPayment(accepted.result as { order: OperationalOrder; attempt: CheckoutAttempt })
  }, [mutation.lastResult, checkoutClosing, order.id])
  useEffect(() => {
    if (!checkoutEnabled || order.revision < paymentRevision || checkoutClosing || adjustingDiscount || registeringPayment || adoptingReservation || settled || !allowed('sales.create') || !collectionAllowed || !methods.includes(method) || !hasSelection || disabled || !editableReservation || current.blocked) return
    if (reservationMatches) return
    const requestKey = `${order.id}:${currentAttempt?.id ?? order.revision}:${currentAttempt?.revision ?? 0}:${method}:${selectionKey}:${reservationRetry}`
    if (requested.current === requestKey) return
    requested.current = requestKey
    setReservationError(false)
    const request = currentAttempt
      ? { command: 'update_checkout' as const, operationId: crypto.randomUUID(), attemptId: currentAttempt.id, expectedRevision: currentAttempt.revision, items, ...(usingAmounts ? { amountsCents: amountsCents! } : {}), paymentMethod: method }
      : { command: 'prepare_checkout' as const, operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, items, ...(usingAmounts ? { amountsCents: amountsCents! } : {}), paymentMethod: method }
    reserveTimer.current = window.setTimeout(() => {
      reserveTimer.current = null
      setPreparingCheckout(true)
      const generation = workflowGeneration.current
      void mutation.execute(request).then(saved => {
        if (generation !== workflowGeneration.current || closingRef.current) return
        selectionAttemptId.current = saved.id; setAttempt(saved); void refresh()
      }).catch(() => {
        if (generation === workflowGeneration.current && !closingRef.current) setReservationError(true)
      }).finally(() => { if (generation === workflowGeneration.current) setPreparingCheckout(false) })
    }, 140)
    return () => {
      if (reserveTimer.current === null) return
      window.clearTimeout(reserveTimer.current)
      reserveTimer.current = null
      if (requested.current === requestKey) requested.current = ''
    }
  }, [checkoutEnabled, order.id, order.revision, paymentRevision, selectionKey, method, methodsKey, disabled, collectionAllowed, checkoutClosing, currentAttempt?.id, currentAttempt?.revision, current.blocked, editableReservation, reservationMatches, settled, reservationRetry, adoptingReservation, adjustingDiscount, registeringPayment])
  const preparingReservation = mutation.pending && ['prepare_checkout', 'update_checkout'].includes(mutation.pending.command)
  const selectionLocked = order.revision < paymentRevision || registeringPayment || adjustingDiscount || Boolean(mutation.busy && !preparingReservation && !preparingCheckout) || Boolean(mutation.pending && !mutation.busy) || Boolean(current.error) || !editableReservation || settled
  const reservingCheckout = Boolean(checkoutEnabled && collectionAllowed && methods.includes(method) && hasSelection && !reservationMatches && !reservationError && !current.error && (!mutation.pending || mutation.busy))
  const showingPoint = Boolean(method === 'card_integrated' && currentAttempt?.paymentMethod === 'card_integrated' && access)
  async function transition(command: 'resume_order_service' | 'cancel_order' | 'close_order') {
    try {
      const common = { operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision }
      let saved: OperationalOrder
      switch (command) {
        case 'cancel_order': saved = await mutation.execute({ command, ...common, reason: reason.trim() }); break
        case 'resume_order_service': saved = await mutation.execute({ command, ...common }); break
        case 'close_order': saved = await mutation.execute({ command, ...common }); break
      }
      onSaved(saved); await refresh()
    } catch { /* Shell recovery. */ }
  }
  async function sendKitchen() {
    if (!canSendKitchen || disabled || current.blocked || kitchenSubmission.current) return
    kitchenSubmission.current = true
    setSendingKitchen(true)
    const generation = workflowGeneration.current
    try {
      const saved = await mutation.execute({ command: 'send_order', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision })
      if (generation !== workflowGeneration.current || closingRef.current) return
      onSaved(saved)
      await refresh()
    } catch { /* Preserve the exact command for recovery in the shell. */ }
    finally {
      kitchenSubmission.current = false
      if (generation === workflowGeneration.current) setSendingKitchen(false)
    }
  }
  async function applyDiscount(discount: OrderDiscount | null) {
    if (disabled || discountApplying || current.blocked || !editableReservation || order.frozen) return
    setDiscountApplying(true)
    setDiscountError('')
    const generation = workflowGeneration.current
    const active = () => generation === workflowGeneration.current && !closingRef.current
    try {
      let editableOrder = order
      if (currentAttempt?.status === 'prepared') {
        if (!access || current.blocked) return
        discountAbortingId.current = currentAttempt.id
        await mutation.execute({ command: 'resolve_checkout', operationId: crypto.randomUUID(), attemptId: currentAttempt.id, expectedRevision: currentAttempt.revision, resolution: 'abort', confirmed: true, reason: 'Reserva cancelada al cambiar descuento' })
        if (!active()) return
        completedAttempts.current.add(currentAttempt.id)
        setAttempt(null)
        selectionAttemptId.current = null
        requested.current = ''
        discountNeedsReload.current = true
      }
      if (discountNeedsReload.current) {
        editableOrder = await readDiscountOrder()
        if (!active()) return
        discountNeedsReload.current = false
        onSaved(editableOrder)
      }
      if (editableOrder.phase === 'checkout') {
        editableOrder = await mutation.execute({ command: 'resume_order_service', operationId: crypto.randomUUID(), orderId: editableOrder.id, expectedRevision: editableOrder.revision })
        if (!active()) return
        acceptedDiscountResults.current.add(editableOrder)
        onSaved(editableOrder)
      }
      editableOrder = await mutation.execute({ command: 'set_order_discount', operationId: crypto.randomUUID(), orderId: editableOrder.id, expectedRevision: editableOrder.revision, discount })
      if (!active()) return
      acceptedDiscountResults.current.add(editableOrder)
      onSaved(editableOrder)
      // prepare_checkout returns the saved account to checkout and reserves its new amount.
      setDiscountOpen(false)
      discountAbortingId.current = null
      setLastPartialPayment(null)
      requested.current = ''
      await refresh()
    } catch (caught) {
      if (active()) setDiscountError(caught instanceof Error ? caught.message : 'No pudimos cambiar el descuento. Inténtalo de nuevo.')
    } finally { if (active()) setDiscountApplying(false) }
  }
  async function readDiscountOrder() {
    if (!access) throw new Error('No pudimos consultar la cuenta. Reabre la cuenta para continuar.')
    const generation = workflowGeneration.current
    try { return await posRequest(access, { command: 'order', orderId: order.id }) }
    catch (caught) {
      if (generation === workflowGeneration.current && !closingRef.current && caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
      throw caught
    }
  }
  async function closeDiscount() {
    if (disabled || discountApplying) return
    const generation = workflowGeneration.current
    const active = () => generation === workflowGeneration.current && !closingRef.current
    setDiscountApplying(true)
    setDiscountError('')
    try {
      let editableOrder = order
      if (discountNeedsReload.current) {
        editableOrder = await readDiscountOrder()
        if (!active()) return
        discountNeedsReload.current = false
        onSaved(editableOrder)
      }
      setDiscountOpen(false)
      discountAbortingId.current = null
      requested.current = ''
      window.requestAnimationFrame(() => { if (active()) discountTrigger.current?.focus() })
    } catch (caught) {
      if (active()) setDiscountError(caught instanceof Error ? caught.message : 'No pudimos volver al cobro. Inténtalo de nuevo.')
    } finally { if (active()) setDiscountApplying(false) }
  }
  function acceptRecordedPayment(result: { order: OperationalOrder; attempt: CheckoutAttempt }) {
    if (result.order.id !== order.id || completedAttempts.current.has(result.attempt.id)) return
    completedAttempts.current.add(result.attempt.id)
    setPaymentRevision(result.order.revision)
    if (result.attempt.amountsCents) {
      setAmountSplit(true)
      setSplit(false)
      setAmountInputs((result.order.amountParts ?? result.attempt.amountsCents.slice(1)).slice(0, -1).map(amountInput))
    }
    if (result.order.items.some(line => line.quantity > line.paidQuantity) && !['paid', 'closed', 'waived', 'cancelled'].includes(result.order.status)) {
      setQuantities(Object.fromEntries(result.order.items.map(line => [line.lineId, 0])))
      setLastPartialPayment({ amountCents: result.attempt.totalCents, method: result.attempt.paymentMethod, saleId: result.attempt.saleId ?? undefined })
      setAttempt(null)
      selectionAttemptId.current = null
      requested.current = ''
    } else setAttempt(result.attempt)
  }
  function notifyRecordedPayment(result: { order: OperationalOrder; attempt: CheckoutAttempt }) {
    if (result.order.id !== order.id || result.attempt.status !== 'completed' || notifiedPayments.current.has(result.attempt.id)) return
    notifiedPayments.current.add(result.attempt.id)
    acceptRecordedPayment(result)
    if (onPaymentRecorded) onPaymentRecorded(result.order, result.attempt.saleId ?? undefined)
    else onSaved(result.order)
  }
  async function finishManualAttempt(value: CheckoutAttempt) {
    setAttempt(value)
    if (value.status !== 'completed' || value.kind !== 'payment' || value.paymentMethod === 'card_integrated' || value.orderId !== order.id || !access || notifiedPayments.current.has(value.id)) { void refresh(); return }
    const generation = workflowGeneration.current
    const resultKey = `${generation}:${value.id}:${value.revision}`
    if (loadingPaymentResults.current.has(resultKey)) return
    loadingPaymentResults.current.add(resultKey)
    setPointResultError('')
    try {
      const saved = await posRequest(access, { command: 'order', orderId: order.id })
      if (generation !== workflowGeneration.current || closingRef.current) return
      notifyRecordedPayment({ order: saved, attempt: value })
      void refresh()
    } catch (caught) {
      if (generation !== workflowGeneration.current || closingRef.current) return
      setPointResultError(caught instanceof Error ? caught.message : 'No pudimos cargar la cuenta. El pago registrado sigue guardado.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
    } finally { loadingPaymentResults.current.delete(resultKey) }
  }
  useEffect(() => {
    if (currentAttempt?.status === 'completed' && currentAttempt.paymentMethod !== 'card_integrated') void finishManualAttempt(currentAttempt)
  }, [currentAttempt?.id, currentAttempt?.revision, currentAttempt?.status])
  async function recordPayment() {
    const generation = workflowGeneration.current
    if (!isManualCollectionMethod(method) || method === 'card_external' && !externalApproved || paymentSubmission.current === generation) return
    if (disabled || registeringPayment || adjustingDiscount || !collectionAllowed || !allowed('sales.create') || !methods.includes(method) || !hasSelection || !currentAttempt || !reservationMatches || current.blocked) return
    // Guard synchronously: a second tap can arrive before React commits the disabled state.
    paymentSubmission.current = generation
    setRegisteringPayment(true)
    try {
      const result = await mutation.execute({ command: 'record_checkout', operationId: crypto.randomUUID(), attemptId: currentAttempt.id, expectedRevision: currentAttempt.revision, confirmed: true })
      if (generation !== workflowGeneration.current || closingRef.current) return
      notifyRecordedPayment(result)
      void refresh()
    } catch { /* Retry the same persisted payment; never request payment again. */ }
    finally { if (generation === workflowGeneration.current) { paymentSubmission.current = null; setRegisteringPayment(false) } }
  }
  const [pointResultError, setPointResultError] = useState('')
  async function finishPoint(value: PointCheckout) {
    if (!access) return
    const generation = workflowGeneration.current
    setPointResultError('')
    try {
      const saved = await posRequest(access, { command: 'order', orderId: order.id })
      if (generation !== workflowGeneration.current || closingRef.current) return
      if (value.saleState === 'materialized') acceptRecordedPayment({ order: saved, attempt: value.checkout })
      else {
        completedAttempts.current.add(value.checkout.id)
        selectionAttemptId.current = null
        requested.current = ''
        setAttempt(null)
      }
      setPointBusy(false)
      onPointBlocked?.(false)
      if (value.saleState === 'materialized') notifyRecordedPayment({ order: saved, attempt: value.checkout })
      else onSaved(saved)
      void refresh()
    } catch (caught) {
      if (generation !== workflowGeneration.current || closingRef.current) return
      setPointResultError(caught instanceof Error ? caught.message : 'No pudimos cargar la cuenta. El resultado del cobro sigue guardado.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
    }
  }
  async function prepareWaiver() { try { setWaiver(await mutation.execute({ command: 'prepare_waiver', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, reason: reason.trim() })); setWaiverConfirmed(false) } catch { /* Shell recovery. */ } }
  return <div className={checkoutView ? 'checkout-layout' : 'ops-form'} aria-busy={sendingKitchen || registeringPayment || discountApplying || preparingCheckout || current.loading}>
    <div className={checkoutView ? 'checkout-summary' : 'ops-form'}>
    {checkoutView && <div className={`checkout-balance${split || amountSplit ? ' is-split' : ''}`}><div className="checkout-amount"><p>{split || amountSplit ? 'Este cobro' : order.paidCents > 0 ? 'Saldo pendiente' : 'Total a cobrar'} · MXN</p><strong>{money(totals.totalCents)}</strong></div>{(split || amountSplit) && <dl className="checkout-pending-amount"><dt>Queda pendiente</dt><dd>{money(remainderCents)}</dd></dl>}</div>}
    {checkoutView && <h3 className="checkout-section-title">{order.name}</h3>}
    {lastPartialPayment && !settled && <div className="checkout-payment-success" role="status"><Check size={18} aria-hidden="true" /><span><strong>Pago registrado · {money(lastPartialPayment.amountCents)}</strong><small>{paymentLabels[lastPartialPayment.method]}</small></span>{lastPartialPayment.saleId && onReceipt && <button type="button" className="pos-button pos-secondary" onClick={() => onReceipt(lastPartialPayment.saleId!)}>Ver comprobante</button>}</div>}
    {!checkoutView && <p>{order.phase === 'checkout' ? 'Cuenta final' : 'En servicio'}{order.frozen ? ' · Artículos y descuento fijos' : ''}</p>}
    {checkoutEnabled && !settled && allowed('sales.create') && <fieldset className="checkout-split-mode" disabled={selectionLocked}>
      <legend className="sr-only">Cómo dividir el cobro</legend>
      <label><input className="sr-only" type="radio" name={`split-${order.id}`} checked={!split && !amountSplit} disabled={selectionLocked} onChange={() => changeSplit(false)} /><span>Cobrar todo</span></label>
      <label><input className="sr-only" type="radio" name={`split-${order.id}`} checked={split && !amountSplit} disabled={selectionLocked || Boolean(order.amountSplit)} onChange={() => changeSplit(true)} /><span>Dividir cuenta</span></label>
      <label><input className="sr-only" type="radio" name={`split-${order.id}`} checked={amountSplit} disabled={selectionLocked} onChange={changeAmountSplit} /><span>Dividir por cantidad</span></label>
    </fieldset>}
    {checkoutEnabled && amountSplit && !settled ? <CheckoutAmountSelection balanceCents={order.balanceCents} inputs={amountInputs} onChange={setAmountInputs} disabled={selectionLocked} paidParts={order.amountPaidParts} /> : checkoutEnabled && split && !settled ? <CheckoutItemSelection order={order} quantities={quantities} disabled={selectionLocked} onChange={setQuantities} /> : <ul className="ops-list">{(checkoutView ? pendingLines : order.items).map(line => {
      const remainingQuantity = line.quantity - line.paidQuantity
      const selectedQuantity = split ? Math.min(quantities[line.lineId] ?? 0, remainingQuantity) : remainingQuantity
      const amount = usingAmounts && line.paidTotalCents !== undefined ? line.totalCents - line.paidTotalCents : checkoutView || split ? checkoutTotals(order, [{ lineId: line.lineId, quantity: selectedQuantity }]).totalCents : line.totalCents
      return <li key={line.lineId}>
        <span><strong>{checkoutView ? remainingQuantity : line.quantity} × {line.name}</strong><small>{line.selectionLabel}{line.note ? ` · ${line.note}` : ''}</small>{!checkoutView && <small>{line.sentQuantity} enviados · {line.paidQuantity} pagados</small>}</span>
        <span className="checkout-line-amount">{money(amount)}</span>
      </li>
    })}</ul>}
    <dl className="ops-totals"><div><dt>Subtotal</dt><dd>{money(checkoutView ? totals.grossCents : order.grossCents)}</dd></div>{order.discount && <div><dt>Descuento · {order.discount.reason}</dt><dd>−{money(checkoutView ? totals.discountCents : order.discountCents)}</dd></div>}<div><dt>IVA incluido conocido</dt><dd>{money(checkoutView ? totals.taxCents : order.taxCents)}</dd></div>{(!checkoutView || order.paidCents > 0) && <div><dt>Pagado</dt><dd>{money(order.paidCents)}</dd></div>}{order.waivedCents > 0 && <div><dt>Condonado</dt><dd>{money(order.waivedCents)}</dd></div>}{order.cancelledCents > 0 && <div><dt>Cancelado</dt><dd>{money(order.cancelledCents)}</dd></div>}{!checkoutView && <div><dt>Saldo</dt><dd>{money(order.balanceCents)}</dd></div>}</dl>
    </div><div className={checkoutView ? 'checkout-controls ops-form' : 'ops-form'}>
    {canSendKitchen && <button type="button" className="pos-button pos-primary" aria-busy={sendingKitchen} disabled={disabled || current.blocked} onClick={() => void sendKitchen()}><span className="checkout-action-progress" data-active={sendingKitchen || undefined} aria-hidden={!sendingKitchen}><PendingIndicator label="Enviando comanda" /></span>Enviar a cocina</button>}
    {!checkoutView && onStartCheckout && !settled && allowed('sales.create') && <button type="button" className={`pos-button ${canSendKitchen ? 'pos-secondary' : 'pos-primary'}`} disabled={disabled || sendingKitchen || !collectionAllowed || current.blocked} onClick={onStartCheckout}>Cobrar {money(order.balanceCents)}</button>}
    {!checkoutView && order.status !== 'closed' && !settled && order.phase === 'service' && !order.frozen && <>
      {(allowed('orders.manage') || allowed('sales.create')) && <button className="pos-button pos-secondary" disabled={disabled} onClick={onEdit}>Editar artículos</button>}
    </>}
    {!settled && !order.frozen && editableReservation && allowed('sales.discount') && discountOpen && <OrderDiscountEditor key={order.id} order={order} disabled={disabled || discountApplying || current.blocked} onApply={applyDiscount} onCancel={closeDiscount} />}
    {discountError && <p className="checkout-discount-error" role="alert">{discountError}</p>}
    {(checkoutEnabled && !settled && allowed('sales.create') && !(currentAttempt?.paymentMethod === 'card_external' && currentAttempt.status !== 'prepared') || showingPoint) && <section className="ops-card checkout-collection">
      <h3 className={checkoutView ? 'sr-only' : undefined}>{split ? 'Cobrar selección' : 'Cobrar cuenta'}</h3>
      {checkoutView ? <PaymentMethodPicker name="order-payment" methods={choices} value={method} onChange={setMethod} disabled={selectionLocked} disabledMethods={cardReady ? [] : ['card_integrated']} /> : <label>Método de pago<select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} disabled={selectionLocked}>{choices.map(m => <option key={m} value={m} disabled={!methods.includes(m)}>{paymentLabels[m]}</option>)}</select></label>}
      {choices.includes('card_integrated') && !cardReady && <p className="point-payment-hint" role="status">{cardHint}</p>}
      <CheckoutPaymentTransition transitionKey={method}>
      {method === 'card_external' && (!currentAttempt || currentAttempt.status === 'prepared') && !discountOpen && <ExternalCardConfirmation checked={externalApproved} onChange={setExternalApproved} disabled={disabled || adjustingDiscount || registeringPayment || current.blocked || !reservationMatches || !collectionAllowed || !methods.includes(method) || !hasSelection} />}
      {isManualCollectionMethod(method) && (!currentAttempt || currentAttempt.status === 'prepared') && <button hidden={discountOpen} className="pos-button pos-primary checkout-register-payment" aria-label="Registrar pago" aria-busy={registeringPayment || reservingCheckout || current.loading} data-updating={registeringPayment || reservingCheckout || current.loading || undefined} disabled={disabled || adjustingDiscount || registeringPayment || current.blocked || !reservationMatches || !collectionAllowed || !methods.includes(method) || !hasSelection || method === 'card_external' && !externalApproved} onClick={() => void recordPayment()}><span className="checkout-action-progress" data-active={registeringPayment || reservingCheckout || current.loading || undefined} aria-hidden={!registeringPayment && !reservingCheckout && !current.loading}><PendingIndicator label={registeringPayment ? 'Registrando pago' : current.loading ? 'Consultando el cobro' : 'Reservando el cobro'} /></span><span>Registrar pago</span>{hasSelection && <strong aria-hidden="true">{money(totals.totalCents)}</strong>}</button>}
      {showingPoint && currentAttempt && access ? <PointPayment key={currentAttempt.id} businessName={business.name} embedded={checkoutView} access={access} attempt={currentAttempt} initialCheckout={pointSettings?.pending.find(checkout => checkout.checkout.id === currentAttempt.id)} settings={pointSettings ?? null} collectionAllowed={collectionAllowed} canStart={checkoutEnabled && cardReady && reservationMatches && !adjustingDiscount && !reservingCheckout && !current.blocked && !mutation.pending && !mutation.busy} onSessionError={onSessionError} onBlocked={blocked => { setPointBusy(blocked); onPointBlocked?.(blocked) }} onResolved={() => { void refresh() }} onDone={value => { void finishPoint(value) }} />
        : method === 'card_integrated' && <button type="button" className="pos-button pos-primary checkout-register-payment" aria-label="Enviar a terminal" aria-busy={reservingCheckout || current.loading} disabled><span className="checkout-action-progress" data-active={reservingCheckout || current.loading || undefined} aria-hidden={!reservingCheckout && !current.loading}><PendingIndicator label="Reservando el cobro" /></span><span>Enviar a terminal</span>{hasSelection && <strong aria-hidden="true">{money(totals.totalCents)}</strong>}</button>}
      <div className="checkout-reservation">
        {!collectionAllowed ? onOpenCash && <button className="pos-button pos-secondary" disabled={disabled} onClick={onOpenCash}>Ir a Caja</button>
          : adjustingDiscount ? null
          : reservationMatches && !current.blocked ? null
          : current.error ? null
          : reservationError ? <p role="alert">No pudimos reservar este cobro.</p>
          : hasSelection ? null
          : <p>{usingAmounts ? 'Ingresa los importes para continuar.' : 'Selecciona artículos para cobrar.'}</p>}
      </div>
      {collectionAllowed && reservationError && !mutation.pending && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => setReservationRetry(n => n + 1)}>Reintentar reserva</button>}
      </CheckoutPaymentTransition>
      {!checkoutView && order.phase === 'checkout' && !order.frozen && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void transition('resume_order_service')}>Volver al servicio</button>}
    </section>}
    <span className="checkout-sync-progress" data-active={current.loading && Boolean(currentAttempt) || undefined} aria-hidden={!current.loading || !currentAttempt}><PendingIndicator label="Consultando el estado del intento" /></span>
    {current.error && <p role="alert">{current.error}<button className="pos-button pos-secondary" onClick={current.retry}>Reintentar consulta</button></p>}
    {pointResultError && <div role="alert"><p>{pointResultError}</p>{currentAttempt?.status === 'completed' && currentAttempt.paymentMethod !== 'card_integrated' && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => void finishManualAttempt(currentAttempt)}>Reintentar consulta del pago</button>}</div>}
    {currentAttempt && currentAttempt.paymentMethod !== 'card_integrated' && currentAttempt.status !== 'prepared' && <><AttemptPanel attempt={currentAttempt} mutation={{ ...mutation, busy: mutation.busy || current.blocked }} collectionAllowed={collectionAllowed} actionAllowed={allowed('sales.create')} onSaved={a => { void finishManualAttempt(a) }} />{['completed', 'aborted'].includes(currentAttempt.status) && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => {
      const generation = workflowGeneration.current, resolvedId = currentAttempt.id
      void refresh().then(() => {
      if (generation !== workflowGeneration.current || closingRef.current) return
      completedAttempts.current.add(resolvedId)
      setQuantities({})
      selectionAttemptId.current = null
      requested.current = ''
      setAttempt(null)
    }) }}>Continuar con la cuenta</button>}</>}
    {!settled && !order.frozen && editableReservation && allowed('sales.discount') && !discountOpen && <button ref={discountTrigger} className="checkout-discount-entry" type="button" data-updating={reservingCheckout || current.loading || undefined} disabled={disabled || registeringPayment || current.blocked} onClick={() => setDiscountOpen(true)}><span>{order.discount ? 'Editar descuento' : 'Añadir descuento'}</span>{order.discount && <span className="checkout-discount-value">−{money(order.discountCents)}</span>}</button>}
    {!settled && !discountOpen && !currentAttempt && (allowed('orders.cancel') || business.role === 'owner') && <details><summary>Cancelar o condonar saldo pendiente</summary><div className="ops-form"><p>Las preparaciones enviadas quedan en el historial. Los pagos registrados se conservan.</p><label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label>{allowed('orders.cancel') && <button className="pos-button pos-secondary" disabled={disabled || !reason.trim()} onClick={() => void transition('cancel_order')}>Cancelar saldo de artículos sin preparar</button>}{business.role === 'owner' && <button className="pos-button pos-secondary" disabled={disabled || !reason.trim()} onClick={() => void prepareWaiver()}>Preparar condonación del saldo</button>}{waiver && waiver.status === 'prepared' && <section className="ops-card"><p>Condonar {money(waiver.amountCents)} · {waiver.reason}</p><label className="ops-check"><input type="checkbox" checked={waiverConfirmed} onChange={e => setWaiverConfirmed(e.target.checked)} /><span>Apruebo que este saldo preparado o entregado quede sin cobrar.</span></label><button className="pos-button pos-primary" disabled={disabled || !waiverConfirmed} onClick={() => { void (async () => { try { setWaiver(await mutation.execute({ command: 'confirm_waiver', operationId: crypto.randomUUID(), waiverId: waiver.id, expectedRevision: waiver.revision, confirmed: true })); await refresh() } catch { /* Shell recovery. */ } })() }}>Confirmar condonación</button></section>}</div></details>}
    {order.status !== 'closed' && settled && (allowed('orders.manage') || allowed('sales.create')) && <><p>El saldo está resuelto.</p><button className="pos-button pos-primary" disabled={disabled} onClick={() => void transition('close_order')}>Cerrar cuenta</button></>}
    </div>
  </div>
}
