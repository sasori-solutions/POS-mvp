import { useEffect, useId, useRef, useState } from 'react'
import { NumericFormat } from 'react-number-format'
import MoneyInput from '../../components/MoneyInput'
import { PendingIndicator } from '../../components/LoadingPlaceholder'
import type { OperationalOrder, OrderDiscount } from '../../lib/operations-contracts'
import { maxOperationalMoneyCents } from '../../lib/operational-money'
import { money } from '../../lib/pos'
import { discountInputValue, discountReason, orderDiscountPreview, parseOrderDiscount } from './order-discount-model'
import './discount-editor.css'

export interface OrderDiscountEditorProps {
  order: OperationalOrder
  disabled?: boolean
  onApply: (discount: OrderDiscount | null) => Promise<void> | void
  onCancel: () => void
}

/** One inline step. Parent owns reservations, persistence and errors. */
export default function OrderDiscountEditor({ order, disabled = false, onApply, onCancel }: OrderDiscountEditorProps) {
  const id = useId()
  const firstKind = useRef<HTMLButtonElement>(null)
  useEffect(() => { firstKind.current?.focus({ preventScroll: true }) }, [])
  const [kind, setKind] = useState<OrderDiscount['kind']>(order.discount?.kind ?? 'percent')
  const [inputs, setInputs] = useState({
    fixed: order.discount?.kind === 'fixed' ? discountInputValue(order.discount.value) : '',
    percent: order.discount?.kind === 'percent' ? discountInputValue(order.discount.value) : '',
  })
  const [reason, setReason] = useState(order.discount?.reason ?? '')
  const [submitting, setSubmitting] = useState(false)
  const applying = useRef(false)
  const value = inputs[kind]
  const parsed = parseOrderDiscount(kind, value, order.grossCents)
  const preview = orderDiscountPreview(order.grossCents, kind, parsed)
  const normalizedReason = discountReason(reason)
  const busy = disabled || submitting
  const invalidAmount = value !== '' && parsed === null
  const valid = preview !== null && (parsed ?? 0) > 0 && normalizedReason !== null
  const setValue = (next: string) => setInputs(previous => ({ ...previous, [kind]: next }))

  async function apply(discount: OrderDiscount | null) {
    if (busy || applying.current) return
    applying.current = true
    setSubmitting(true)
    try {
      await onApply(discount)
    } catch { /* Parent retains the server error and retry. */ } finally { applying.current = false; setSubmitting(false) }
  }

  return <form className="order-discount-editor" aria-labelledby={`${id}-title`} aria-busy={busy} onSubmit={event => {
    event.preventDefault()
    if (valid && parsed !== null && normalizedReason !== null) void apply({ kind, value: parsed, reason: normalizedReason })
  }}>
    <div className="order-discount-heading"><h3 id={`${id}-title`}>{order.discount ? 'Editar descuento' : 'Aplicar descuento'}</h3><p id={`${id}-scope`}>Se aplica a toda la cuenta.</p></div>
    <div className="order-discount-kind" role="group" aria-label="Tipo de descuento">
      <button ref={firstKind} type="button" aria-pressed={kind === 'fixed'} disabled={busy} onClick={() => setKind('fixed')}>Importe</button>
      <button type="button" aria-pressed={kind === 'percent'} disabled={busy} onClick={() => setKind('percent')}>Porcentaje</button>
    </div>
    <div className="order-discount-amount">
      <label className="sr-only" htmlFor={`${id}-amount`}>{kind === 'fixed' ? 'Importe del descuento' : 'Porcentaje'}</label>
      {kind === 'fixed'
        ? <MoneyInput id={`${id}-amount`} value={value} onValueChange={setValue} maxCents={maxOperationalMoneyCents} placeholder="$0.00" disabled={busy} aria-invalid={invalidAmount} aria-describedby={`${id}-scope${invalidAmount ? ` ${id}-amount-error` : ''}`} autoComplete="off" />
        : <NumericFormat id={`${id}-amount`} value={value} valueIsNumericString onValueChange={next => setValue(next.value)} suffix="%" decimalScale={2} allowedDecimalSeparators={['.', ',']} allowNegative={false} inputMode="decimal" placeholder="0%" disabled={busy} aria-invalid={invalidAmount} aria-describedby={`${id}-scope${invalidAmount ? ` ${id}-amount-error` : ''}`} autoComplete="off" isAllowed={next => {
          const digits = next.value.match(/^(\d*)(?:\.(\d{0,2}))?$/)
          return Boolean(digits && Number(digits[1]) * 100 + Number((digits[2] ?? '').padEnd(2, '0')) <= 10_000)
        }} />}
      {invalidAmount && <p className="order-discount-error" id={`${id}-amount-error`} role="alert">{kind === 'fixed' ? `Máximo ${money(order.grossCents)}.` : 'Usa un porcentaje de 0 a 100.'}</p>}
      {kind === 'percent' && <div className="order-discount-presets" role="group" aria-label="Porcentajes rápidos">{[10, 15, 20].map(preset => <button key={preset} type="button" disabled={busy} aria-pressed={parsed === preset * 100} onClick={() => setValue(String(preset))}>{preset}%</button>)}</div>}
    </div>
    <label className="order-discount-reason" htmlFor={`${id}-reason`}>Motivo<input id={`${id}-reason`} value={reason} onChange={event => setReason(event.target.value)} maxLength={200} disabled={busy} required autoComplete="off" placeholder="Ej. cortesía" /></label>
    <dl className="order-discount-preview" aria-label="Vista previa del descuento"><div><dt>Descuento</dt><dd>{preview ? `−${money(preview.discountCents)}` : '—'}</dd></div><div><dt>Total de la cuenta</dt><dd>{preview ? money(preview.totalCents) : '—'}</dd></div></dl>
    <div className="order-discount-actions"><button type="submit" className="pos-button pos-primary" aria-label={order.discount ? 'Guardar descuento' : 'Aplicar descuento'} disabled={busy || !valid}>{submitting && <PendingIndicator label="Aplicando descuento" />}{order.discount ? 'Guardar descuento' : 'Aplicar descuento'}</button><button type="button" className="pos-button pos-secondary" disabled={busy} onClick={onCancel}>Cancelar</button></div>
    {order.discount && <button className="order-discount-remove" type="button" disabled={busy} onClick={() => void apply(null)}>Quitar descuento</button>}
  </form>
}
