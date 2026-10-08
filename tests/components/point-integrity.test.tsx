// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import PointPayment from '../../src/components/PointPayment'
import PointRefund from '../../src/components/PointRefund'
import PointDashboard from '../../src/components/PointDashboard'
import PointStatements from '../../src/components/PointStatements'
import { pointStatementKey, readPointStatement, type PointStatementCommand } from '../../src/lib/point-pending'
import { AccountClientError } from '../../src/lib/account'
import { usePoint } from '../../src/components/usePoint'
import { pointRequest, downloadPointCsv } from '../../src/lib/point-client'
import { pointAccess, pointCheckout, pointId, pointPaid, pointSettings, pointReport } from '../fixtures/point'
import type { PointCheckout, PointRefundRequest } from '../../src/lib/point-contracts'
vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn(), downloadPointCsv: vi.fn() }))
vi.mock('../../src/components/PosShared', () => ({ SaleDetail: () => <div>Recibo sintético</div> }))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const request = (operationId = pointId(31), status: PointRefundRequest['status'] = 'pending'): PointRefundRequest => ({ id: pointId(30), operationId, status, amountCents: 2000, merchandiseCents: 2000, tipCents: 0, reason: 'Corrección', remoteRefundId: null, firstSentAt: null })
beforeEach(() => { localStorage.clear(); vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_key: string, callback: () => unknown) => callback()) } }); vi.resetAllMocks() })
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

test('disabling Point immediately hides settings and invalidates a late private response', async () => {
  const pending = deferred<ReturnType<typeof pointSettings>>()
  vi.mocked(pointRequest).mockReturnValue(pending.promise)
  const view = renderHook(({ enabled }) => usePoint(pointAccess, enabled), { initialProps: { enabled: true } })
  view.rerender({ enabled: false })
  await act(async () => { pending.resolve(pointSettings()); await pending.promise })
  expect(view.result.current.settings).toBeNull(); expect(view.result.current.loading).toBe(false)
})

test('changing credentials while offline cannot restore another operator settings', async () => {
  const pending = deferred<ReturnType<typeof pointSettings>>()
  vi.mocked(pointRequest).mockReturnValue(pending.promise)
  const view = renderHook(({ token }) => usePoint({ ...pointAccess, operatorToken: token }, true), { initialProps: { token: 'first' } })
  vi.stubGlobal('navigator', { onLine: false }); view.rerender({ token: 'second' })
  await act(async () => { pending.resolve(pointSettings()); await pending.promise })
  expect(view.result.current.settings).toBeNull(); expect(view.result.current.loading).toBe(false)
})

test('a newer settings mutation cannot be replaced by an earlier refresh', async () => {
  const pending = deferred<ReturnType<typeof pointSettings>>()
  vi.mocked(pointRequest).mockReturnValue(pending.promise)
  const view = renderHook(() => usePoint(pointAccess, true))
  act(() => view.result.current.setSettings({ ...pointSettings(), enabled: false }))
  await act(async () => { pending.resolve(pointSettings()); await pending.promise })
  expect(view.result.current.settings?.enabled).toBe(false)
})

test('double tapping starts only one prepared collection', async () => {
  const quote = pointCheckout(), pending = deferred<PointCheckout>()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'prepare' ? pending.promise : { ...quote, state: 'pending' })
  render(<PointPayment access={pointAccess} attempt={quote.checkout} settings={pointSettings()} />)
  const start = await screen.findByRole('button', { name: /^Enviar a terminal/ })
  fireEvent.click(start); fireEvent.click(start)
  await act(async () => { pending.resolve(quote); await pending.promise })
  await waitFor(() => expect(vi.mocked(pointRequest).mock.calls.filter(([, value]) => value.command === 'start')).toHaveLength(1))
  expect(vi.mocked(pointRequest).mock.calls.filter(([, value]) => value.command === 'prepare')).toHaveLength(1)
})

test('logout after preparing cannot start a provider charge from the obsolete component', async () => {
  const quote = pointCheckout(), pending = deferred<PointCheckout>()
  vi.mocked(pointRequest).mockReturnValue(pending.promise)
  const view = render(<PointPayment access={pointAccess} attempt={quote.checkout} settings={pointSettings()} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Enviar a terminal/ })); view.unmount()
  await act(async () => { pending.resolve(quote); await pending.promise })
  expect(pointRequest).toHaveBeenCalledTimes(1)
})

test.each(['scope', 'quote', 'shift'])('a changed %s while preparing cannot start the old charge', async kind => {
  const quote = pointCheckout(), pending = deferred<PointCheckout>()
  vi.mocked(pointRequest).mockReturnValue(pending.promise)
  const props = { access: pointAccess, attempt: quote.checkout, settings: pointSettings(), canStart: true, collectionAllowed: true }
  const view = render(<PointPayment {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Enviar a terminal/ }))
  view.rerender(<PointPayment {...props} {...(kind === 'scope' ? { access: { ...pointAccess, operatorToken: 'new-session' } } : kind === 'quote' ? { canStart: false } : { collectionAllowed: false })} />)
  await act(async () => { pending.resolve(quote); await pending.promise })
  expect(pointRequest).toHaveBeenCalledTimes(1)
})

test('cancelled prepared checkout releases the panel and passes its final result to onDone', async () => {
  const quote = pointCheckout(), cancelled: PointCheckout = { ...quote, state: 'cancelled', checkout: { ...quote.checkout, status: 'aborted' } }
  vi.mocked(pointRequest).mockResolvedValue(cancelled)
  const blocked = vi.fn(), done = vi.fn()
  render(<PointPayment access={pointAccess} initialCheckout={quote} settings={pointSettings()} onBlocked={blocked} onDone={done} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar cobro' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Volver a la cuenta' }))
  expect(blocked).toHaveBeenLastCalledWith(false); expect(done).toHaveBeenCalledWith(cancelled)
})

test('reload restores server pending partial refund and prevents a second request', async () => {
  vi.mocked(pointRequest).mockResolvedValue({ ...pointPaid(), refundRequests: [request()] })
  render(<PointRefund access={pointAccess} saleId={pointId(12)} />)
  expect(await screen.findByText(/Devolución pendiente:/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Solicitar devolución/ })).toBeNull()
  expect((screen.getByLabelText('Importe a devolver MXN') as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Consultar devolución' }))
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(2))
  expect(pointRequest).toHaveBeenLastCalledWith(pointAccess, { command: 'refund_context', saleId: pointId(12) })
})

test('another refund cannot confirm the current request by reaching the same aggregate amount', async () => {
  let current = pointPaid(); let ownId = ''
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'refund') { ownId = command.operationId; current = { ...current, refundedCents: 2000, refundRequests: [request(ownId)] } }
    return current
  })
  render(<PointRefund access={pointAccess} saleId={pointId(12)} />)
  fireEvent.change(await screen.findByLabelText('Importe a devolver MXN'), { target: { value: '20.00' } })
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Corrección' } })
  fireEvent.click(screen.getByRole('button', { name: 'Solicitar devolución parcial' }))
  await screen.findByRole('button', { name: 'Reintentar la misma devolución' })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Consultar devolución' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar la misma devolución' }))
  await waitFor(() => expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'refund')).toHaveLength(2))
  const calls = vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'refund')
  expect(calls[1][1]).toEqual(calls[0][1])
  current = { ...current, refundRequests: [request(ownId, 'confirmed')] }
  await waitFor(() => expect((screen.getByRole('button', { name: 'Consultar devolución' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Consultar devolución' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reintentar la misma devolución' })).toBeNull())
})

test('a definitive rejected partial refund releases its request and leaves the original paid balance available', async () => {
  let current = pointPaid(), ownId = ''
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'refund') {
      ownId = command.operationId
      current = { ...current, refundRequests: [request(ownId)] }
    }
    return current
  })
  render(<PointRefund access={pointAccess} saleId={pointId(12)} />)
  fireEvent.change(await screen.findByLabelText('Importe a devolver MXN'), { target: { value: '20.00' } })
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Corrección' } })
  fireEvent.click(screen.getByRole('button', { name: 'Solicitar devolución parcial' }))
  await screen.findByText(/Devolución pendiente: \$20.00/)
  await waitFor(() => expect((screen.getByRole('button', { name: 'Consultar devolución' }) as HTMLButtonElement).disabled).toBe(false))
  current = { ...current, refundRequests: [request(ownId, 'rejected')] }
  fireEvent.click(screen.getByRole('button', { name: 'Consultar devolución' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'La devolución fue rechazada.')
  expect(screen.queryByText(/Devolución pendiente:/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reintentar la misma devolución' })).toBeNull()
  expect((screen.getByLabelText('Importe a devolver MXN') as HTMLInputElement).value).toBe('100.00')
  expect((screen.getByLabelText('Importe a devolver MXN') as HTMLInputElement).disabled).toBe(false)
  expect(screen.getByText(/Devuelto: \$0.00. Disponible: \$100.00/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Devolución total' } })
  expect((screen.getByRole('button', { name: 'Solicitar devolución total' }) as HTMLButtonElement).disabled).toBe(false)
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'refund')).toHaveLength(1)
})

test('a late refund context from a different sale cannot populate the new sale form', async () => {
  const first = deferred<PointCheckout>(), second = { ...pointPaid(), totalCents: 5000, sale: { ...pointPaid().sale!, id: pointId(55) } }
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'refund_context' && command.saleId === pointId(12) ? first.promise : second)
  const view = render(<PointRefund access={pointAccess} saleId={pointId(12)} />)
  view.rerender(<PointRefund access={pointAccess} saleId={pointId(55)} />)
  await screen.findByLabelText('Importe a devolver MXN')
  await act(async () => { first.resolve(pointPaid()); await first.promise })
  expect((screen.getByLabelText('Importe a devolver MXN') as HTMLInputElement).value).toBe('50.00')
})


test('a delayed report page cannot overwrite a newly confirmed reporting period', async () => {
  const delayed = deferred<ReturnType<typeof pointReport>>()
  const newer = { ...pointReport(), from: '2026-01-01', businesses: [{ ...pointReport().businesses[0], name: 'Negocio nuevo' }], nextCursor: null }
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => 'cursor' in command ? delayed.promise : 'from' in command && command.from === newer.from ? newer : pointReport())
  const settings = pointSettings(); settings.permissions.admin = true
  render(<PointDashboard access={pointAccess} timezone="America/Mexico_City" settings={settings} admin />)
  await screen.findByText('Negocio inicial')
  fireEvent.click(screen.getByRole('button', { name: 'Cargar más comercios' }))
  fireEvent.change(screen.getByLabelText('Desde'), { target: { value: newer.from } })
  fireEvent.click(screen.getByRole('button', { name: 'Consultar periodo' }))
  await screen.findByText('Negocio nuevo')
  await act(async () => { delayed.resolve({ ...pointReport(), businesses: [{ ...pointReport().businesses[0], name: 'Página obsoleta' }] }); await delayed.promise })
  expect(screen.queryByText('Página obsoleta')).toBeNull(); expect(screen.queryByText('Negocio inicial')).toBeNull()
  expect(screen.getByText('Negocio nuevo')).toBeTruthy()
})

test('revoking report access suppresses a delayed CSV export', async () => {
  const delayed = deferred<ReturnType<typeof pointReport>>()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => 'cursor' in command ? delayed.promise : pointReport())
  const settings = pointSettings(); settings.permissions.admin = true
  const view = render(<PointDashboard access={pointAccess} timezone="America/Mexico_City" settings={settings} admin />)
  await screen.findByText('Negocio inicial')
  fireEvent.click(screen.getByRole('button', { name: 'Exportar estado de cuenta CSV' }))
  view.rerender(<PointDashboard access={pointAccess} timezone="America/Mexico_City" settings={pointSettings()} admin />)
  await act(async () => { delayed.resolve({ ...pointReport(), nextCursor: '' }); await delayed.promise })
  expect(downloadPointCsv).not.toHaveBeenCalled(); expect(screen.queryByText('Negocio inicial')).toBeNull()
})


const commissionPayment: PointStatementCommand = { command: 'record_commission_payment', operationId: pointId(60), statementId: pointId(61), amountCents: 100, paidAt: '2026-10-03T12:00:00Z', evidence: 'Abono sintético' }
const statement = { id: pointId(61), period: '2026-09', status: 'invoiced' as const, exactNumerator: '10000000', netCents: 1000, vatCents: 160, totalCents: 1160, collectedCents: 0, remainingCents: 1160, closedAt: '2026-10-01T12:00:00Z' }

test('a commission payment with a lost response survives reload with the exact UUID and no credentials', async () => {
  const key = pointStatementKey(pointAccess.businessId, pointId(22)); localStorage.setItem(key, JSON.stringify(commissionPayment))
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'statements') return { statements: [statement] }
    throw new AccountClientError('NETWORK_ERROR', 'Respuesta perdida')
  })
  const view = render(<PointStatements access={pointAccess} actorId={pointId(22)} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reintentar solicitud guardada', hidden: true }))
  await screen.findByText('Respuesta perdida')
  expect(readPointStatement(key)).toEqual(commissionPayment)
  view.unmount()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'statements' ? { statements: [statement] } : statement)
  render(<PointStatements access={{ ...pointAccess, operatorToken: 'new-session' }} actorId={pointId(22)} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reintentar solicitud guardada', hidden: true }))
  await waitFor(() => expect(localStorage.getItem(key)).toBeNull())
  const payments = vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'record_commission_payment')
  expect(payments).toHaveLength(2); expect(payments[0][1]).toEqual(payments[1][1]); expect(payments[0][1]).toEqual(commissionPayment)
  expect(JSON.stringify(payments[0][1])).not.toContain(pointAccess.operatorToken)
})

test('storage failure prevents any new commission mutation from reaching the server', async () => {
  vi.mocked(pointRequest).mockResolvedValue({ statements: [statement] })
  render(<PointStatements access={pointAccess} actorId={pointId(22)} />)
  fireEvent.change(screen.getByLabelText('Periodo para cerrar'), { target: { value: '2026-09' } })
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar periodo mensual', hidden: true }))
  await screen.findByText('Storage unavailable'); storage.mockRestore()
  expect(vi.mocked(pointRequest).mock.calls.every(([, command]) => command.command === 'statements')).toBe(true)
})

test('a commission response received after logout cannot erase another session recovery', async () => {
  const key = pointStatementKey(pointAccess.businessId, pointId(22)), pending = deferred<typeof statement>()
  localStorage.setItem(key, JSON.stringify(commissionPayment))
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'statements' ? { statements: [statement] } : pending.promise)
  const view = render(<PointStatements access={pointAccess} actorId={pointId(22)} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reintentar solicitud guardada', hidden: true }))
  await waitFor(() => expect(pointRequest).toHaveBeenCalledWith(pointAccess, commissionPayment))
  view.rerender(<PointStatements access={{ ...pointAccess, operatorToken: 'next-session' }} actorId={pointId(22)} />)
  await act(async () => { pending.resolve(statement); await pending.promise })
  expect(readPointStatement(key)).toEqual(commissionPayment)
  expect(screen.getByRole('button', { name: 'Reintentar solicitud guardada', hidden: true })).toBeTruthy()
})

test('durable Point commission payload rejects credentials and unexpected fields', () => {
  const key = pointStatementKey(pointAccess.businessId, pointId(22))
  localStorage.setItem(key, JSON.stringify({ ...commissionPayment, operatorToken: 'must-never-persist' }))
  expect(() => readPointStatement(key)).toThrow(/revisión/)
})


test('Point never starts a reservation changed by another register before prepare responded', async () => {
  const expected = pointCheckout(), changed = { ...expected, checkout: { ...expected.checkout, revision: 2, totalCents: 5000 }, totalCents: 5000 }
  vi.mocked(pointRequest).mockResolvedValue(changed)
  render(<PointPayment access={pointAccess} attempt={expected.checkout} settings={pointSettings()} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Enviar a terminal/ }))
  await screen.findByText('La reserva cambió. Revisa el importe actualizado o cancela este intento.')
  expect((screen.getByRole('button', { name: /^Enviar a terminal/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare'])
  expect(screen.getByRole('button', { name: 'Cancelar cobro' })).toBeTruthy()
})

test('Point cannot start a different amount concept even when reservation identity and money match', async () => {
  const expected = pointCheckout()
  expected.checkout.items = expected.checkout.items.map(line => ({ ...line, kind: 'amount', productId: null, name: 'Servicio original' }))
  expected.items = expected.items.map(line => ({ ...line, kind: 'amount', productId: null, name: 'Servicio original' }))
  const changed = { ...expected, checkout: { ...expected.checkout, items: expected.checkout.items.map(line => ({ ...line, name: 'Otro concepto' })) }, items: expected.items.map(line => ({ ...line, name: 'Otro concepto' })) }
  vi.mocked(pointRequest).mockResolvedValue(changed)
  render(<PointPayment access={pointAccess} attempt={expected.checkout} settings={pointSettings()} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Enviar a terminal/ }))
  await screen.findByText('La reserva cambió. Revisa el importe actualizado o cancela este intento.')
  expect((screen.getByRole('button', { name: /^Enviar a terminal/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare'])
})


test('an externally verified full refund keeps an uncorrelated pending request visible and cannot offer another refund', async () => {
  const paid = pointPaid()
  vi.mocked(pointRequest).mockResolvedValue({ ...paid, state: 'refunded', refundedCents: paid.totalCents, refundRequests: [{ ...request(), status: 'unknown_review', amountCents: paid.totalCents, merchandiseCents: paid.totalCents }] })
  render(<PointRefund access={pointAccess} saleId={paid.sale!.id} />)
  await screen.findByText(/Devolución pendiente:/)
  expect(screen.queryByRole('button', { name: /Solicitar devolución|Reintentar la misma devolución/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Consultar devolución' }))
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(2))
  expect(vi.mocked(pointRequest).mock.calls.every(([, command]) => command.command === 'refund_context')).toBe(true)
})
