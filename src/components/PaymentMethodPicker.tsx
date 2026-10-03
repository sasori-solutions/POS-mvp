import { ArrowLeftRight, Banknote, CreditCard } from 'lucide-react'
import type { PaymentMethod } from '../lib/contracts'
import { paymentLabels } from './PosShared'

const icons = { cash: Banknote, card_external: CreditCard, transfer: ArrowLeftRight }

export default function PaymentMethodPicker({ methods, value, onChange, disabled, name }: {
  methods: PaymentMethod[]
  value: PaymentMethod
  onChange: (method: PaymentMethod) => void
  disabled: boolean
  name: string
}) {
  return <fieldset className="checkout-methods" disabled={disabled}>
    <legend>Método de pago</legend>
    {methods.map(method => {
      const Icon = icons[method]
      return <label key={method}>
        <input className="sr-only" type="radio" name={name} value={method} checked={value === method} onChange={() => onChange(method)} />
        <Icon size={26} strokeWidth={1.6} aria-hidden="true" />
        <span>{paymentLabels[method]}</span>
      </label>
    })}
  </fieldset>
}
