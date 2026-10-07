// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'
import { saleReceiptHtml, printSaleReceipt } from '../../src/lib/sale-receipt'
import type { Sale } from '../../src/lib/pos-contracts'

const sale: Sale = {
  id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-10-07T01:30:00Z', timezone: 'America/Mexico_City',
  totalCents: 10001, paymentMethod: 'card_external', itemCount: 2, operatorName: 'Caja sintética',
  items: [{ productId: '00000000-0000-4000-8000-000000000002', name: 'Café de temporada', category: 'Café', quantity: 2,
    unitPriceCents: 5501, totalCents: 10001, discountCents: 1001, selectionLabel: 'Grande · Leche de avena', taxBps: 1600, taxCents: 1379, taxTreatment: 'vat_16' }],
}
const receipt = (value: Sale = sale, name = 'Café sintético') => new DOMParser().parseFromString(saleReceiptHtml(value, name), 'text/html')

afterEach(() => { document.querySelectorAll('iframe').forEach(frame => frame.remove()); vi.useRealTimers(); vi.restoreAllMocks() })

test('receipt uses accepted labels, exact paid money and the sale timezone, including saved discount and IVA', () => {
  const result = receipt()
  expect(result.querySelector('h1')?.textContent).toBe('Café sintético')
  expect(result.body.textContent).toContain('6 oct 2026')
  expect(result.body.textContent).toContain('7:30 p.m.')
  expect(result.querySelector('tbody')?.textContent).toContain('Café de temporadaGrande · Leche de avena2 × $55.01$100.01')
  expect(result.querySelector('.total dd')?.textContent).toBe('$100.01')
  expect(result.body.textContent).toContain('Descuento aplicado$10.01')
  expect(result.body.textContent).toContain('$13.79')
  expect(result.body.textContent).toContain('Tarjeta externa')
  expect(result.body.textContent).toContain('No es CFDI')
  expect(result.querySelector('footer')?.textContent).toContain(sale.id)
})

test('payment parts print the allocated payment without claiming full product quantities or guessing legacy IVA', () => {
  const result = receipt({ ...sale, totalCents: 3401, items: [{ ...sale.items[0], quantity: 0, allocatedGrossCents: 3501, totalCents: 3401, discountCents: 100, taxCents: undefined, taxBps: null, taxTreatment: 'legacy' }] })
  expect(result.querySelector('tbody')?.textContent).toContain('Parte de cuenta')
  expect(result.querySelector('tbody')?.textContent).not.toContain('0 ×')
  expect(result.querySelector('.total dd')?.textContent).toBe('$34.01')
  expect(result.body.textContent).toContain('no tiene un desglose completo de IVA')
  expect(result.body.textContent).not.toContain('IVA 16 %')
})

test('free amount concepts and Unicode text are retained literally and cannot become executable receipt markup', () => {
  const value = { ...sale, operatorName: '<img src=x onerror=alert(1)>', items: [{ ...sale.items[0], kind: 'amount', name: 'Servicio <script>alert(1)</script> 🍵', selectionLabel: 'Ignore catalog selections' }] } as Sale
  const result = receipt(value, 'Café & "Bar" <svg onload=alert(1)>')
  expect(result.querySelector('h1')?.textContent).toBe('Café & "Bar" <svg onload=alert(1)>')
  expect(result.querySelector('tbody')?.textContent).toContain('Servicio <script>alert(1)</script> 🍵Importe libre')
  expect(result.body.textContent).not.toContain('Ignore catalog selections')
  expect(result.querySelectorAll('script,svg,img,[onerror],[onload]')).toHaveLength(0)
})

test('all accepted lines remain in the print document and rows may paginate without printing the application', () => {
  const result = receipt({ ...sale, items: Array.from({ length: 40 }, (_, index) => ({ ...sale.items[0], name: `Concepto ${index + 1}` })) })
  expect(result.querySelectorAll('tbody tr')).toHaveLength(40)
  expect(result.querySelector('tbody tr:last-child')?.textContent).toContain('Concepto 40')
  expect(result.querySelector('style')?.textContent).toContain('break-inside:avoid')
  expect(result.querySelectorAll('button,input,nav,a')).toHaveLength(0)
})

test('printing calls the isolated document and disposes it after the destination closes', async () => {
  const ready = vi.fn(), error = vi.fn()
  const dispose = printSaleReceipt(sale, 'Café sintético', ready, error)
  const frame = document.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals')
  expect(frame.getAttribute('aria-hidden')).toBe('true')
  const target = frame.contentWindow!
  const print = vi.spyOn(target, 'print').mockImplementation(() => { target.dispatchEvent(new Event('afterprint')) })
  vi.spyOn(target, 'focus').mockImplementation(() => {})
  frame.dispatchEvent(new Event('load'))
  await vi.waitFor(() => expect(print).toHaveBeenCalledOnce())
  expect(ready).toHaveBeenCalledOnce()
  expect(error).not.toHaveBeenCalled()
  expect(frame.isConnected).toBe(false)
  dispose()
})

test('leaving or locking before fonts are ready removes the private document and prevents late printing', async () => {
  const ready = vi.fn(), error = vi.fn()
  const dispose = printSaleReceipt(sale, 'Café sintético', ready, error)
  const frame = document.querySelector('iframe')!
  let finish!: () => void
  Object.defineProperty(frame.contentDocument, 'fonts', { value: { ready: new Promise<void>(resolve => { finish = resolve }) } })
  const print = vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => {})
  frame.dispatchEvent(new Event('load'))
  dispose()
  finish()
  await Promise.resolve()
  expect(print).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  expect(frame.isConnected).toBe(false)
})

test('a failed print destination exposes an error and releases the private document', async () => {
  const error = vi.fn()
  printSaleReceipt(sale, '', vi.fn(), error)
  const frame = document.querySelector('iframe')!
  vi.spyOn(frame.contentWindow!, 'focus').mockImplementation(() => {})
  vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => { throw new Error('Unavailable') })
  frame.dispatchEvent(new Event('load'))
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
  expect(frame.isConnected).toBe(false)
})

test('a loading failure has a bounded retryable error instead of leaving a pending print indefinitely', () => {
  vi.useFakeTimers()
  const ready = vi.fn(), error = vi.fn()
  printSaleReceipt(sale, '', ready, error)
  vi.advanceTimersByTime(10000)
  expect(error).toHaveBeenCalledOnce()
  expect(ready).not.toHaveBeenCalled()
  expect(document.querySelector('iframe')).toBeNull()
})
