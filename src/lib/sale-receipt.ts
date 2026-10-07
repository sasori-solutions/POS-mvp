import receiptFont from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url'
import type { Sale } from './pos-contracts'
import { money, saleDate } from './pos'
import { paymentLabels } from './payment-methods'
import { vatSummary } from './vat'

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

/** Only accepted sale snapshots belong on a receipt; never consult today's catalog. */
export function saleReceiptHtml(sale: Sale, businessName = ''): string {
  const reference = sale.id.slice(0, 8).toUpperCase()
  const vat = vatSummary(sale.items)
  const discount = sale.items.reduce((sum, item) => sum + (item.discountCents ?? 0), 0)
  const rows = sale.items.map(item => {
    const freeAmount = 'kind' in item && item.kind === 'amount'
    const detail = freeAmount ? 'Importe libre' : item.selectionLabel ?? ''
    const quantity = item.allocatedGrossCents !== undefined ? 'Parte de cuenta' : `${item.quantity} × ${money(item.unitPriceCents)}`
    const components = (item.comboComponents ?? []).map(component => `<p>${escape(item.allocatedGrossCents !== undefined ? `Por combo: ${component.quantity}` : String(item.quantity * component.quantity))} × ${escape(component.name)}${component.selectionLabel ? ` · ${escape(component.selectionLabel)}` : ''}</p>`).join('')
    return `<tr><td><strong>${escape(item.name)}</strong>${detail ? `<p>${escape(detail)}</p>` : ''}${components}<p>${escape(quantity)}</p></td><td class="amount">${escape(money(item.totalCents))}</td></tr>`
  }).join('')
  const breakdown = vat.groups.map(group => `<div><dt>${escape(group.label)}</dt><dd>${escape(money(group.cents))}</dd></div>`).join('')
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Venta ${escape(reference)}</title><style>
@font-face{font-family:ReceiptPlex;src:url("${receiptFont}") format("woff2");font-weight:400;font-display:swap}
*{box-sizing:border-box}body{margin:0;color:#111;background:white;font:14px/1.45 ReceiptPlex,Arial,sans-serif}main{max-width:720px;margin:0 auto;padding:24px}h1{margin:0 0 4px;font-size:24px;line-height:1.2;overflow-wrap:anywhere}header{margin-bottom:24px}header p{margin:4px 0}h2{font-size:18px;margin:0 0 8px}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{font-weight:400;text-align:left;padding:8px 0;border-bottom:1px solid #ccc}th:last-child{width:112px;text-align:right}td{vertical-align:top;padding:12px 0;border-bottom:1px solid #ddd;overflow-wrap:anywhere}td:first-child{padding-right:16px}td p{margin:3px 0 0;font-size:12px;color:#444}td.amount{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}tr{break-inside:avoid}dl{margin:24px 0}dl>div{display:flex;justify-content:space-between;gap:16px;margin:8px 0;break-inside:avoid}dt{min-width:0;overflow-wrap:anywhere}dd{margin:0;text-align:right;overflow-wrap:anywhere}.total{font-size:20px;font-weight:bold;border-top:1px solid #111;padding-top:12px}.reference{font-size:12px;overflow-wrap:anywhere}.note{font-size:12px;color:#444}.receipt-summary{break-inside:avoid}footer{margin-top:24px;break-inside:avoid}@page{size:auto;margin:12mm}@media print{main{max-width:none;padding:0}body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
</style></head><body><main><header>${businessName ? `<h1>${escape(businessName)}</h1>` : ''}<h2>Comprobante de venta</h2><p>Venta #${escape(reference)}</p><p>${escape(saleDate(sale.createdAt, sale.timezone))}</p></header><table><thead><tr><th scope="col">Concepto</th><th scope="col">Importe MXN</th></tr></thead><tbody>${rows}</tbody></table><section class="receipt-summary"><dl>${discount ? `<div><dt>Descuento aplicado</dt><dd>${escape(money(discount))}</dd></div>` : ''}${breakdown}<div class="total"><dt>Total MXN</dt><dd>${escape(money(sale.totalCents))}</dd></div><div><dt>Método de pago</dt><dd>${escape(paymentLabels[sale.paymentMethod])}</dd></div><div><dt>Registró</dt><dd>${escape(sale.operatorName)}</dd></div></dl>${vat.unknown ? '<p class="note">Este registro no tiene un desglose completo de IVA.</p>' : ''}<footer><p class="note">Comprobante de venta. No es CFDI.</p><p class="reference">Referencia: ${escape(sale.id)}</p></footer></section></main></body></html>`
}

/** Uses the browser's print/PDF destination, without opening an unauthenticated route. */
export function printSaleReceipt(sale: Sale, businessName: string, onReady: () => void, onError: (message: string) => void): () => void {
  const frame = document.createElement('iframe')
  frame.title = 'Comprobante para imprimir'
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
  frame.tabIndex = -1
  frame.dataset.saleReceipt = sale.id
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '800px', height: '600px', border: '0', pointerEvents: 'none' })
  let cancelled = false
  let notified = false
  let loaded = false
  const dispose = () => { cancelled = true; window.clearTimeout(timeout); frame.remove() }
  const ready = () => { if (!cancelled && !notified) { notified = true; onReady() } }
  const fail = () => {
    if (cancelled) return
    onError('No pudimos abrir el comprobante para imprimir. Reintenta desde esta venta.')
    dispose()
  }
  const timeout = window.setTimeout(fail, 10000)
  frame.onload = async () => {
    if (cancelled || loaded) return
    loaded = true
    try {
      const target = frame.contentWindow
      if (!target || typeof target.print !== 'function' || !frame.contentDocument) throw new Error('Print unavailable')
      await frame.contentDocument.fonts?.ready
      if (cancelled) return
      window.clearTimeout(timeout)
      target.addEventListener('afterprint', () => { ready(); dispose() }, { once: true })
      target.focus()
      target.print()
      // Some browsers return as the destination dialog opens; only preparation is complete.
      ready()
    } catch { fail() }
  }
  frame.srcdoc = saleReceiptHtml(sale, businessName)
  document.body.append(frame)
  return dispose
}
