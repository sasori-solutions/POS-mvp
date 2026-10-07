import { useEffect, useRef, useState } from 'react'
import { Printer } from 'lucide-react'
import type { Sale } from '../lib/pos-contracts'
import { printSaleReceipt } from '../lib/sale-receipt'

export default function SaleReceiptActions({ sale, businessName = '' }: { sale: Sale; businessName?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const printing = useRef(false)
  const dispose = useRef<(() => void) | null>(null)
  useEffect(() => {
    printing.current = false
    setBusy(false)
    setError('')
    return () => { dispose.current?.(); dispose.current = null }
  }, [sale.id, businessName])
  function print() {
    if (printing.current) return
    printing.current = true
    dispose.current?.()
    setError('')
    setBusy(true)
    dispose.current = printSaleReceipt(sale, businessName, () => { printing.current = false; setBusy(false) }, message => { printing.current = false; setBusy(false); setError(message) })
  }
  return <div className="mt-6 flex flex-col gap-3" aria-busy={busy}>
    <button type="button" className="pos-button pos-secondary w-full" disabled={busy} onClick={print}>
      <Printer size={20} aria-hidden="true" />{busy ? 'Preparando comprobante…' : 'Imprimir / guardar PDF'}
    </button>
    <p className="text-sm text-muted">Elige impresora o Guardar como PDF en el diálogo del dispositivo. No es CFDI.</p>
    {error && <p role="alert">{error}</p>}
  </div>
}
