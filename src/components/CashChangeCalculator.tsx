import { useId, useLayoutEffect, useRef, useState } from 'react'
import { money } from '../lib/pos'
import { maxOperationalMoneyCents, parseOperationalMoney } from '../lib/operational-money'
import MoneyInput from './MoneyInput'

/** Tender is a local counting aid; the accepted payment remains the account amount. */
export default function CashChangeCalculator({ totalCents, disabled, onValidChange }: {
  totalCents: number; disabled: boolean; onValidChange: (valid: boolean) => void
}) {
  const id = useId(), [open, setOpen] = useState(false), [tender, setTender] = useState({ totalCents, input: '' })
  const input = tender.totalCents === totalCents ? tender.input : ''
  const setInput = (value: string) => setTender({ totalCents, input: value })
  const callback = useRef(onValidChange); callback.current = onValidChange
  const received = parseOperationalMoney(input)
  const sufficient = received !== null && received >= totalCents
  useLayoutEffect(() => { callback.current(!open || sufficient) }, [open, sufficient, totalCents])
  return <section className="ops-form" aria-label="Cambio de efectivo">
    <button type="button" className="pos-button pos-secondary" aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled} onClick={() => { setOpen(value => !value); setInput('') }}>{open ? 'Cobrar importe exacto' : 'Calcular cambio'}</button>
    {open && <div id={`${id}-panel`} className="ops-form">
      <label htmlFor={`${id}-received`}>Efectivo recibido<MoneyInput id={`${id}-received`} value={input} onValueChange={setInput} maxCents={maxOperationalMoneyCents} disabled={disabled} placeholder="$0.00" aria-invalid={Boolean(input && !sufficient)} /></label>
      <div className="order-discount-presets" role="group" aria-label="Billetes recibidos">{[50, 100, 200, 500, 1000].filter(amount => amount * 100 >= totalCents).map(amount => <button key={amount} type="button" disabled={disabled} onClick={() => setInput(String(amount))}>{money(amount * 100)}</button>)}</div>
      <dl className="ops-totals" aria-live="polite"><div><dt>Cambio a entregar</dt><dd>{sufficient ? money(received! - totalCents) : '—'}</dd></div></dl>
      {input && !sufficient && <p className="operations-caption" role="status">El efectivo recibido debe cubrir {money(totalCents)}.</p>}
    </div>}
  </section>
}
