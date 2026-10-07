// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import SaleReceiptDialog from '../../src/components/SaleReceiptDialog'
import { AccountClientError } from '../../src/lib/account'
import { posRequest, type PosAccess } from '../../src/lib/pos'
import type { Sale } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access: PosAccess = { businessId: 'synthetic-business', operatorToken: 'synthetic-memory-only' }
const sale: Sale = { id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-10-06T18:00:00Z', timezone: 'America/Mexico_City', paymentMethod: 'cash', totalCents: 5801, itemCount: 1, operatorName: 'Caja sintética', items: [{ productId: 'synthetic-product', name: 'Café guardado', category: '', quantity: 1, unitPriceCents: 5801, totalCents: 5801 }] }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const props = { access, saleId: sale.id, businessName: 'Café sintético', onClose: vi.fn() }
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('a failed receipt read can retry without registering or collecting the sale again', async () => {
  vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'No hay conexión')).mockResolvedValueOnce(sale)
  render(<SaleReceiptDialog {...props} />)
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: 'Imprimir / guardar PDF' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  await screen.findByRole('button', { name: 'Imprimir / guardar PDF' })
  expect(screen.getByText('Café guardado')).toBeTruthy()
  expect(posRequest).toHaveBeenCalledTimes(2)
  expect(vi.mocked(posRequest).mock.calls.every(([actor, command]) => actor === access && command.command === 'sale')).toBe(true)
})

test('switching operators removes the old receipt immediately and ignores a late accepted response', async () => {
  const previous = deferred<Sale>(), current = deferred<Sale>()
  vi.mocked(posRequest).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
  const view = render(<SaleReceiptDialog {...props} />)
  view.rerender(<SaleReceiptDialog {...props} access={{ ...access, operatorToken: 'next-synthetic-memory-only' }} />)
  await act(async () => { previous.resolve(sale); await previous.promise })
  expect(screen.queryByText('Café guardado')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Imprimir / guardar PDF' })).toBeNull()
  await act(async () => { current.resolve({ ...sale, items: [{ ...sale.items[0], name: 'Comprobante actual' }] }); await current.promise })
  await screen.findByText('Comprobante actual')
  expect(screen.queryByText('Café guardado')).toBeNull()
})

test('a live authorization failure returns to session handling; a late failure after closing does not', async () => {
  const onSessionError = vi.fn(), old = deferred<Sale>()
  vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('SESSION_INVALID', 'Vuelve a entrar')).mockReturnValueOnce(old.promise)
  const view = render(<SaleReceiptDialog {...props} onSessionError={onSessionError} />)
  await waitFor(() => expect(onSessionError).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: 'Imprimir / guardar PDF' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  view.unmount()
  await act(async () => { old.reject(new AccountClientError('SESSION_INVALID', 'Respuesta anterior')); await old.promise.catch(() => {}) })
  expect(onSessionError).toHaveBeenCalledOnce()
})
