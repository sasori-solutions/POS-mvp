import { ArrowLeftRight, Banknote, CreditCard } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { PaymentMethod } from '../lib/contracts'
import './point-payment.css'
import { paymentLabels } from './PosShared'

const icons = { cash: Banknote, card_external: CreditCard, card_integrated: CreditCard, transfer: ArrowLeftRight }

export default function PaymentMethodPicker({ methods, value, onChange, disabled, name }: {
  methods: PaymentMethod[]
  value: PaymentMethod
  onChange: (method: PaymentMethod) => void
  disabled: boolean
  name: string
}) {
  return <fieldset className="checkout-methods" data-many={methods.length > 3} disabled={disabled} style={{ '--payment-columns': Math.max(1, methods.length) } as CSSProperties}>
    <legend>Método de pago</legend>
    {methods.map(method => {
      const Icon = icons[method]
      return <label key={method}>
        <input className="sr-only" type="radio" name={name} value={method} checked={value === method} disabled={disabled} onChange={() => { if (!disabled) onChange(method) }} />
        <Icon size={26} strokeWidth={1.6} aria-hidden="true" />
        <span>{paymentLabels[method]}</span>
        {(method === 'card_integrated' || method === 'card_external') && <small>{method === 'card_integrated' ? 'A terminal' : 'Registro manual'}</small>}
      </label>
    })}
  </fieldset>
}
