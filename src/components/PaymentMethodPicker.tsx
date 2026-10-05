import { ArrowLeftRight, Banknote, CreditCard } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { PaymentMethod } from '../lib/contracts'
import { collectionPaymentMethods } from '../lib/payment-methods'
import './point-payment.css'
import { paymentLabels } from './PosShared'

const icons = { cash: Banknote, card_external: CreditCard, card_integrated: CreditCard, transfer: ArrowLeftRight }

export default function PaymentMethodPicker({ methods, value, onChange, disabled, disabledMethods = [], name }: {
  methods: PaymentMethod[]
  value: PaymentMethod
  onChange: (method: PaymentMethod) => void
  disabled: boolean
  disabledMethods?: PaymentMethod[]
  name: string
}) {
  const choices = collectionPaymentMethods(methods)
  return <fieldset className="checkout-methods" disabled={disabled} style={{ '--payment-columns': Math.max(1, choices.length) } as CSSProperties}>
    <legend>Método de pago</legend>
    {choices.map(method => {
      const Icon = icons[method]
      const unavailable = disabled || disabledMethods.includes(method)
      return <label key={method}>
        <input className="sr-only" type="radio" name={name} value={method} aria-label={method === 'card_integrated' ? 'Tarjeta Mercado Pago' : paymentLabels[method]} checked={value === method} disabled={unavailable} onChange={() => { if (!unavailable) onChange(method) }} />
        <Icon size={26} strokeWidth={1.6} aria-hidden="true" />
        <span>{paymentLabels[method]}</span>
        {method === 'card_integrated' && <small>Mercado Pago</small>}
      </label>
    })}
  </fieldset>
}
