import { Plus, X } from 'lucide-react'
import { useId } from 'react'
import { amountPlan } from '../../lib/checkout-amounts'
import { money } from '../../lib/pos'
import { parseOperationalMoney } from '../../lib/operational-money'

export default function CheckoutAmountSelection({ balanceCents, inputs, onChange, disabled, paidParts = 0 }: {
  balanceCents: number; inputs: string[]; onChange: (inputs: string[]) => void; disabled: boolean; paidParts?: number
}) {
  const plan = amountPlan(balanceCents, inputs)
  const id = useId()
  const error = !plan && inputs.some(input => input !== '')
  return <section className="checkout-amount-selection" aria-label="Importes por persona">
    {inputs.map((value, index) => {
      const amount = parseOperationalMoney(value)
      const invalid = value !== '' && (amount === null || amount <= 0 || amount >= balanceCents)
      return <div className="checkout-person-amount" key={index}>
      <label htmlFor={`${id}-${index}`}>Persona {paidParts + index + 1}</label>
      <div className="checkout-person-input"><span aria-hidden="true">$</span><input id={`${id}-${index}`} type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={value} maxLength={11} disabled={disabled} aria-invalid={invalid} aria-describedby={error ? `${id}-error` : undefined} onChange={event => onChange(inputs.map((input, i) => i === index ? event.target.value : input))} /></div>
      <button type="button" aria-label={`Quitar persona ${paidParts + index + 1}`} disabled={disabled || inputs.length === 0} onClick={() => onChange(inputs.filter((_, i) => i !== index))}><X size={16} aria-hidden="true" /></button>
    </div>})}
    <div className="checkout-person-amount checkout-person-remainder"><span>Persona {paidParts + inputs.length + 1}<small>Restante automático</small></span><strong aria-live="polite">{plan ? money(plan.at(-1)!) : '—'}</strong></div>
    <button className="checkout-add-person" type="button" disabled={disabled || inputs.length >= 19 || Boolean(plan && plan.at(-1)! <= 1)} onClick={() => onChange([...inputs, ''])}><Plus size={16} aria-hidden="true" />Añadir persona</button>
    {error && <p id={`${id}-error`} className="checkout-discount-error" role="alert">Usa importes positivos y deja saldo para la última persona.</p>}
  </section>
}
