import type { ShiftPaymentSummary } from '../../lib/operations-contracts'
import type { PaymentMethod } from '../../lib/contracts'
import { integerCurrency as money } from '../../lib/integer-currency'
import './CashPaymentSummary.css'

const labels: Record<PaymentMethod, string> = {
  cash: 'Efectivo', card_external: 'Tarjeta externa', card_integrated: 'Mercado Pago Point', transfer: 'Transferencia',
}

export default function CashPaymentSummary({ summary }: { summary: ShiftPaymentSummary }) {
  return <section className="cash-payment-summary" aria-label="Cobros por método del turno">
    <h3>Cobros por método</h3>
    <p className="operations-caption">Cobros y devoluciones registrados en este turno. Fondo y movimientos van por separado.</p>
    <ul className="cash-payment-list">
      {summary.payments.map(row => <li key={row.paymentMethod}>
        <strong>{labels[row.paymentMethod]}</strong>
        <dl className="cash-payment-amounts">
          <div><dt>Cobrado</dt><dd>{money(row.collectedCents)}</dd></div>
          <div><dt>Devuelto</dt><dd>{row.paymentMethod === 'card_integrated' ? <span aria-label="Consultar devoluciones en Pagos integrados">—</span> : money(row.refundedCents)}</dd></div>
          <div><dt>Neto</dt><dd>{row.paymentMethod === 'card_integrated' ? <span aria-label="Neto de Point sin atribución completa al turno">—</span> : money(row.netCents)}</dd></div>
        </dl>
      </li>)}
      <li className="cash-payment-total">
        <strong>Total registrado</strong>
        <dl className="cash-payment-amounts">
          <div><dt>Cobrado</dt><dd>{money(summary.collectedCents)}</dd></div>
          <div><dt>Devuelto registrado</dt><dd>{money(summary.refundedCents)}</dd></div>
          <div><dt>Neto registrado</dt><dd>{money(summary.netCents)}</dd></div>
        </dl>
      </li>
    </ul>
    <p className="operations-caption">Las devoluciones de Point no se atribuyen a turnos. Consúltalas en Pagos integrados; el neto registrado aquí no las descuenta.</p>
  </section>
}
