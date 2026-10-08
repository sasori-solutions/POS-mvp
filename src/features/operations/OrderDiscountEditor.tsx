import { useEffect, useId, useRef, useState } from 'react'
import { NumericFormat } from 'react-number-format'
import MoneyInput from '../../components/MoneyInput'
import { PendingIndicator } from '../../components/LoadingPlaceholder'
import type { OperationalOrder, OrderDiscount } from '../../lib/operations-contracts'
import { maxOperationalMoneyCents } from '../../lib/operational-money'
import { money, type PosAccess } from '../../lib/pos'
import type { AccountClientError } from '../../lib/account'
import type { Promotion } from '../../lib/promotion-contracts'
import { discountEligibleGross, promotionCategory } from '../../lib/promotion-math'
import SavedPromotionPicker from './SavedPromotionPicker'
import { discountInputValue, discountReason, orderDiscountPreview, parseOrderDiscount } from './order-discount-model'
import './discount-editor.css'

export interface OrderDiscountEditorProps {
  order: OperationalOrder
  disabled?: boolean
  onApply: (discount: OrderDiscount | null) => Promise<void> | void
  onCancel: () => void
  access?: PosAccess
  onApplyPromotion?: (promotion: Promotion) => Promise<void> | void
  onSessionError?: (error: AccountClientError) => void
}

/** One inline step. Parent owns reservations, persistence and errors. */
export default function OrderDiscountEditor({ order, disabled = false, onApply, onCancel, access, onApplyPromotion, onSessionError }: OrderDiscountEditorProps) {
  const id = useId()
  const firstKind = useRef<HTMLButtonElement>(null)
  useEffect(() => { firstKind.current?.focus({ preventScroll: true }) }, [])
  const [kind, setKind] = useState<OrderDiscount['kind']>(order.discount?.kind ?? 'percent')
  const [inputs, setInputs] = useState({
    fixed: order.discount?.kind === 'fixed' ? discountInputValue(order.discount.value) : '',
    percent: order.discount?.kind === 'percent' ? discountInputValue(order.discount.value) : '',
  })
  const [reason, setReason] = useState(order.discount?.reason ?? '')
  const [scoped, setScoped] = useState(Boolean(order.discount?.scope))
  const [productIds, setProductIds] = useState(order.discount?.scope?.productIds ?? [])
  const [categories, setCategories] = useState(order.discount?.scope?.categories ?? [])
  const currentProducts = new Map(order.items.filter(line => line.productId).map(line => [line.productId!, { id: line.productId!, label: `Producto: ${line.name}` }]))
  const inheritedProducts = productIds.filter(productId => !currentProducts.has(productId))
  const choices = [...currentProducts.values(), ...inheritedProducts.map((productId, index) => ({ id: productId, label: `Producto fuera de esta cuenta ${index + 1}` }))]
  const currentCategories = new Set(order.items.map(line => promotionCategory(line.category)).filter(Boolean))
  const categoryChoices = [...new Set([...currentCategories, ...categories])].sort()
  const hasInheritedCriteria = inheritedProducts.length > 0 || categories.some(category => !currentCategories.has(category))
  const scope = scoped ? { productIds: [...productIds].sort(), categories: [...categories].sort() } : undefined
  const eligibleGross = scoped && !productIds.length && !categories.length ? 0 : discountEligibleGross(order, scope)
  const [submitting, setSubmitting] = useState(false)
  const applying = useRef(false)
  const value = inputs[kind]
  const parsed = parseOrderDiscount(kind, value, eligibleGross)
  const preview = orderDiscountPreview(eligibleGross, kind, parsed)
  const normalizedReason = discountReason(reason)
  const busy = disabled || submitting
  const invalidAmount = value !== '' && parsed === null
  const validScope = !scoped || productIds.length <= 100 && categories.length <= 24
  const valid = validScope && preview !== null && (parsed ?? 0) > 0 && normalizedReason !== null && eligibleGross > 0
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
    if (valid && parsed !== null && normalizedReason !== null) void apply({ kind, value: parsed, reason: normalizedReason, ...(scope ? { scope } : {}) })
  }}>
    <div className="order-discount-heading"><h3 id={`${id}-title`}>{order.discount ? 'Editar descuento' : 'Aplicar descuento'}</h3><p id={`${id}-scope`}>{scoped ? `Se aplica a ${money(eligibleGross)} de consumos seleccionados.` : 'Se aplica a toda la cuenta.'}</p></div>
    {access && onApplyPromotion && <SavedPromotionPicker access={access} order={order} disabled={busy} onSessionError={onSessionError} onApply={promotion => {
      if (busy || applying.current) return
      applying.current = true; setSubmitting(true)
      void Promise.resolve().then(() => onApplyPromotion(promotion)).catch(() => {}).finally(() => { applying.current = false; setSubmitting(false) })
    }} />}
    <label>Aplicar descuento a<select value={scoped ? 'selected' : 'all'} disabled={busy} onChange={event => setScoped(event.target.value === 'selected')}><option value="all">Toda la cuenta</option><option value="selected">Productos o categorías</option></select></label>
    {scoped && <fieldset className="order-discount-scope" disabled={busy}>
      <legend>Consumos elegibles</legend>
      {hasInheritedCriteria && <p className="operations-caption">Los criterios fuera de esta cuenta se conservan. Desmárcalos para quitarlos.</p>}
      {categoryChoices.map(category => <label className="ops-check" key={category}>
        <input type="checkbox" checked={categories.includes(category)} disabled={!categories.includes(category) && categories.length >= 24} onChange={event => {
          const checked = event.target.checked
          setCategories(previous => checked ? previous.includes(category) || previous.length >= 24 ? previous : [...previous, category] : previous.filter(value => value !== category))
        }} /><span>Categoría: {category}</span>
      </label>)}
      {categories.length >= 24 && <p className="operations-caption">Máximo 24 categorías. Desmarca una para elegir otra.</p>}
      {choices.map(product => <label className="ops-check" key={product.id}>
        <input type="checkbox" checked={productIds.includes(product.id)} disabled={!productIds.includes(product.id) && productIds.length >= 100} onChange={event => {
          const checked = event.target.checked
          setProductIds(previous => checked ? previous.includes(product.id) || previous.length >= 100 ? previous : [...previous, product.id] : previous.filter(value => value !== product.id))
        }} /><span>{product.label}</span>
      </label>)}
      {!productIds.length && !categories.length && <p className="operations-caption">Selecciona al menos un producto o una categoría.</p>}
    </fieldset>}
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
      {invalidAmount && <p className="order-discount-error" id={`${id}-amount-error`} role="alert">{kind === 'fixed' ? `Máximo ${money(eligibleGross)}.` : 'Usa un porcentaje de 0 a 100.'}</p>}
      {kind === 'percent' && <div className="order-discount-presets" role="group" aria-label="Porcentajes rápidos">{[10, 15, 20].map(preset => <button key={preset} type="button" disabled={busy} aria-pressed={parsed === preset * 100} onClick={() => setValue(String(preset))}>{preset}%</button>)}</div>}
    </div>
    <label className="order-discount-reason" htmlFor={`${id}-reason`}>Motivo<input id={`${id}-reason`} value={reason} onChange={event => setReason(event.target.value)} maxLength={200} disabled={busy} required autoComplete="off" placeholder="Ej. cortesía" /></label>
    <dl className="order-discount-preview" aria-label="Vista previa del descuento"><div><dt>Descuento</dt><dd>{preview ? `−${money(preview.discountCents)}` : '—'}</dd></div><div><dt>Total de la cuenta</dt><dd>{preview ? money(order.grossCents - preview.discountCents) : '—'}</dd></div></dl>
    <div className="order-discount-actions"><button type="submit" className="pos-button pos-primary" aria-label={order.discount ? 'Guardar descuento' : 'Aplicar descuento'} disabled={busy || !valid}>{submitting && <PendingIndicator label="Aplicando descuento" />}{order.discount ? 'Guardar descuento' : 'Aplicar descuento'}</button><button type="button" className="pos-button pos-secondary" disabled={busy} onClick={onCancel}>Cancelar</button></div>
    {order.discount && <button className="order-discount-remove" type="button" disabled={busy} onClick={() => void apply(null)}>Quitar descuento</button>}
  </form>
}
