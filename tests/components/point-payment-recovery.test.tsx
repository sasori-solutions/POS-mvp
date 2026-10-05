// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import PointPayment from '../../src/components/PointPayment'
import { AccountClientError } from '../../src/lib/account'
import { pointRequest } from '../../src/lib/point-client'
import type { PointCheckout, PointSimulationStatus } from '../../src/lib/point-contracts'
import { pointAccess, pointCheckout, pointPaid, pointSettings } from '../fixtures/point'

vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
vi.mock('../../src/components/PosShared', () => ({ SaleDetail: () => <p>Recibo sintético</p> }))

let online = true, hidden = false
function pending(): PointCheckout { return pointCheckout({ state: 'pending', remoteOrderId: 'ORDER-SYNTHETIC', cancelCapability: 'backend' }) }
function sandbox() { return { ...pointSettings(), sandbox: { official: true, available: true, testBusiness: true } } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function advance(milliseconds: number) { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) }) }
async function dispatch(target: Document | Window, event: string) { await act(async () => { target.dispatchEvent(new Event(event)) }) }

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00Z'))
  online = true; hidden = false
  vi.stubGlobal('navigator', { get onLine() { return online } })
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

test('the global pause blocks new orders while an already sent payment still reconciles', async () => {
  const settings = { ...sandbox(), chargesEnabled: false }
  const quote = pointCheckout()
  const view = render(<PointPayment access={pointAccess} attempt={quote.checkout} settings={settings} />)
  expect(screen.getByRole('button', { name: /Enviar a terminal/ }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /Enviar a terminal/ }))
  expect(pointRequest).not.toHaveBeenCalled()
  view.unmount()
  vi.mocked(pointRequest).mockResolvedValue(pointPaid())
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={settings} />)
  await advance(3_000)
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
})

test('an unresolved payment keeps checking after two minutes and presents only the materialized result', async () => {
  const initial = pending(), paid = { ...pointPaid(), remoteOrderId: initial.remoteOrderId }, resolved = vi.fn()
  const start = Date.now()
  vi.mocked(pointRequest).mockImplementation(async () => Date.now() - start >= 180_000 ? paid : initial)
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} />)
  await advance(180_000)
  expect(screen.getByRole('heading', { name: 'Pago aprobado' })).toBeTruthy()
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
  expect(resolved).toHaveBeenCalledExactlyOnceWith(paid)
  const requests = vi.mocked(pointRequest).mock.calls.length
  expect(requests).toBeGreaterThan(40)
  expect(requests).toBeLessThan(60)
  await advance(30_000)
  expect(pointRequest).toHaveBeenCalledTimes(requests)
})

test('returning to the PWA after it was hidden resumes immediately without spending its polling lifetime', async () => {
  hidden = true
  vi.mocked(pointRequest).mockResolvedValue(pointPaid())
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} />)
  await advance(180_000)
  expect(pointRequest).not.toHaveBeenCalled()
  hidden = false
  await dispatch(document, 'visibilitychange')
  expect(pointRequest).toHaveBeenCalledExactlyOnceWith(pointAccess, { command: 'status', checkoutId: pending().id })
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
})

test('reconnecting after a prolonged outage immediately retrieves the persisted payment result', async () => {
  online = false
  vi.mocked(pointRequest).mockResolvedValue(pointPaid())
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} />)
  await advance(180_000)
  expect(pointRequest).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('Sin conexión')
  online = true
  await dispatch(window, 'online')
  expect(pointRequest).toHaveBeenCalledTimes(1)
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

test('focusing a visible payment retrieves a new terminal result without waiting for its timer', async () => {
  vi.mocked(pointRequest).mockResolvedValue(pointPaid())
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} />)
  await dispatch(window, 'focus')
  expect(pointRequest).toHaveBeenCalledTimes(1)
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
})

test('a slow status request cannot overlap with timers, focus, online or visibility events', async () => {
  const result = deferred<PointCheckout>()
  vi.mocked(pointRequest).mockReturnValue(result.promise)
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} />)
  await advance(3_000)
  await dispatch(window, 'focus'); await dispatch(window, 'online'); await dispatch(document, 'visibilitychange')
  await advance(60_000)
  expect(pointRequest).toHaveBeenCalledTimes(1)
  await act(async () => { result.resolve(pointPaid()); await result.promise })
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
})

test('a status network error stays visible and automatic recovery shows the verified result without another simulation', async () => {
  const resolved = vi.fn()
  vi.mocked(pointRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Conexión interrumpida')).mockResolvedValue(pointPaid())
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} onResolved={resolved} />)
  await advance(3_000)
  expect(screen.getByRole('alert').textContent).toBe('Conexión interrumpida')
  expect(resolved).not.toHaveBeenCalled()
  await advance(3_000)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(resolved).toHaveBeenCalledExactlyOnceWith(pointPaid())
  expect(vi.mocked(pointRequest).mock.calls.every(([, command]) => command.command === 'status')).toBe(true)
})

test('expired authorization stops polling and does not repeatedly call the obsolete session', async () => {
  const denied = new AccountClientError('SESSION_EXPIRED', 'Tu sesión venció.'), onSessionError = vi.fn()
  vi.mocked(pointRequest).mockRejectedValue(denied)
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} onSessionError={onSessionError} />)
  await advance(3_000)
  expect(onSessionError).toHaveBeenCalledExactlyOnceWith(denied)
  await advance(30_000); await dispatch(window, 'focus')
  expect(pointRequest).toHaveBeenCalledTimes(1)
})

test('a response from an old operator cannot confirm a payment after changing the session', async () => {
  const result = deferred<PointCheckout>(), resolved = vi.fn()
  vi.mocked(pointRequest).mockReturnValue(result.promise)
  const view = render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} onResolved={resolved} />)
  await advance(3_000)
  view.rerender(<PointPayment access={{ ...pointAccess, operatorToken: 'next-synthetic-session' }} initialCheckout={pending()} settings={sandbox()} onResolved={resolved} />)
  await act(async () => { result.resolve(pointPaid()); await result.promise })
  expect(screen.getByRole('heading', { name: 'Esperando la terminal' })).toBeTruthy()
  expect(resolved).not.toHaveBeenCalled()
})

test('approval without materialization keeps polling and cannot offer Continue or a receipt', async () => {
  const approved = { ...pending(), state: 'approved_verified' as const }, resolved = vi.fn(), blocked = vi.fn()
  vi.mocked(pointRequest).mockResolvedValueOnce(approved).mockResolvedValue(pointPaid())
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} onResolved={resolved} onDone={vi.fn()} onBlocked={blocked} />)
  await advance(3_000)
  expect(screen.getByText('Guardando el pago en tu cuenta.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull()
  expect(screen.queryByText('Recibo sintético')).toBeNull()
  expect(resolved).not.toHaveBeenCalled()
  expect(blocked).toHaveBeenLastCalledWith(true)
  await advance(3_000)
  expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy()
  expect(resolved).toHaveBeenCalledExactlyOnceWith(pointPaid())
  expect(blocked).toHaveBeenLastCalledWith(false)
})

test('intermediate terminal states cannot unlock a second simulation before the requested result arrives', async () => {
  const initial = pending()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate' ? { accepted: true } : { ...initial, state: 'sent_to_terminal', updatedAt: '2026-10-04T12:00:01Z' })
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await act(async () => {})
  expect(screen.getByRole('status', { name: 'Verificando el resultado de prueba' })).toBeTruthy()
  await advance(3_000)
  expect((screen.getByRole('button', { name: 'Resultado solicitado' }) as HTMLButtonElement).disabled).toBe(true)
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'simulate')).toHaveLength(1)
})

test.each<{ event: PointSimulationStatus; state: PointCheckout['state']; title: string }>([
  { event: 'processed', state: 'approved_verified', title: 'Pago aprobado' },
  { event: 'failed', state: 'rejected', title: 'Pago rechazado' },
  { event: 'canceled', state: 'cancelled', title: 'Pago cancelado' },
  { event: 'expired', state: 'expired', title: 'Pago expirado' },
  { event: 'action_required', state: 'unknown_review', title: 'Pago por confirmar' },
])('the simulated $event result reaches the screen after independent polling through intermediate states', async ({ event, state, title }) => {
  const initial = pending(), resolved = vi.fn(), done = vi.fn()
  const result = event === 'processed' ? pointPaid() : { ...initial, state, statusDetail: event === 'action_required' ? 'check_on_terminal' : event, checkout: { ...initial.checkout, status: event === 'action_required' ? 'prepared' as const : 'aborted' as const } }
  let reads = 0
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'simulate') return { accepted: true }
    return ++reads < 3 ? { ...initial, state: reads === 1 ? 'sent_to_terminal' : 'processing' } : result
  })
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} onDone={done} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Resultado de prueba' }), { target: { value: event } })
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await act(async () => {})
  expect(resolved).not.toHaveBeenCalled()
  expect(done).not.toHaveBeenCalled()
  expect(screen.queryByText('Recibo sintético')).toBeNull()
  await advance(3_000)
  expect((screen.getByRole('button', { name: 'Resultado solicitado' }) as HTMLButtonElement).disabled).toBe(true)
  expect(resolved).not.toHaveBeenCalled()
  await advance(3_000)
  expect(screen.getByRole('heading', { name: title })).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Verificando el resultado de prueba' })).toBeNull()
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'simulate')).toHaveLength(1)
  expect(done).not.toHaveBeenCalled()
  if (event === 'action_required') {
    expect(resolved).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Continuar|Volver a la cuenta/ })).toBeNull()
    expect((screen.getByRole('button', { name: 'Simular resultado' }) as HTMLButtonElement).disabled).toBe(false)
  } else {
    expect(resolved).toHaveBeenCalledExactlyOnceWith(result)
    expect(screen.getByRole('button', { name: event === 'processed' ? 'Continuar' : 'Volver a la cuenta' })).toBeTruthy()
    expect(Boolean(screen.queryByText('Recibo sintético'))).toBe(event === 'processed')
  }
})

test('a review result offers only the supported sandbox approval and still waits for a verified receipt', async () => {
  const initial = { ...pending(), state: 'unknown_review' as const, statusDetail: 'check_on_terminal' }, resolved = vi.fn()
  let reads = 0
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate'
    ? { accepted: true } : ++reads < 2 ? initial : pointPaid())
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} />)
  const options = screen.getByRole('combobox', { name: 'Resultado de prueba' }).querySelectorAll('option')
  expect(Array.from(options).map(option => option.value)).toEqual(['processed'])
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await act(async () => {})
  expect(pointRequest).toHaveBeenCalledWith(pointAccess, { command: 'simulate', checkoutId: initial.id, status: 'processed' })
  expect(screen.getByRole('button', { name: 'Resultado solicitado' }).hasAttribute('disabled')).toBe(true)
  expect(resolved).not.toHaveBeenCalled()
  await advance(3_000)
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
  expect(resolved).toHaveBeenCalledExactlyOnceWith(pointPaid())
})

test('a stale status response cannot replace a newer confirmed checkout supplied by the controller', async () => {
  const request = deferred<PointCheckout>(), initial = pending(), paid = { ...pointPaid(), updatedAt: '2026-10-04T12:00:01Z' }, resolved = vi.fn()
  vi.mocked(pointRequest).mockReturnValue(request.promise)
  const view = render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} />)
  await advance(3_000)
  view.rerender(<PointPayment access={pointAccess} initialCheckout={paid} settings={sandbox()} onResolved={resolved} />)
  await act(async () => { request.resolve(initial); await request.promise })
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
  expect(resolved).toHaveBeenCalledExactlyOnceWith(paid)
  await advance(30_000)
  expect(pointRequest).toHaveBeenCalledTimes(1)
})

test('simulating a long-open payment checks immediately and restarts three-second observation without treating acceptance as approval', async () => {
  const initial = pending(), resolved = vi.fn()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate' ? { accepted: true } : initial)
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} />)
  await advance(180_000)
  const previousReads = vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'status').length
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await act(async () => {})
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'status')).toHaveLength(previousReads + 1)
  expect(screen.getByRole('button', { name: 'Resultado solicitado' }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByText('Recibo sintético')).toBeNull()
  expect(resolved).not.toHaveBeenCalled()
  await advance(3_000)
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'status')).toHaveLength(previousReads + 2)
})

test('starting a collection checks its persisted result immediately after the start request finishes', async () => {
  const initial = pending(), start = deferred<PointCheckout>(), resolved = vi.fn()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'prepare') return pointCheckout()
    if (command.command === 'start') return start.promise
    return initial
  })
  render(<PointPayment access={pointAccess} attempt={pointCheckout().checkout} settings={sandbox()} onResolved={resolved} />)
  fireEvent.click(screen.getByRole('button', { name: /Enviar a terminal/ }))
  await act(async () => {})
  await advance(10_000)
  await dispatch(window, 'focus')
  expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare', 'start'])
  await act(async () => { start.resolve(initial); await start.promise })
  expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare', 'start', 'status'])
  expect(screen.getByRole('heading', { name: 'Esperando la terminal' })).toBeTruthy()
  expect(resolved).not.toHaveBeenCalled()
  await advance(3_000)
  expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare', 'start', 'status', 'status'])
})

test.each(['focus', 'online', 'visibilitychange'] as const)('resuming a long-open payment through %s restores three-second observation', async event => {
  vi.mocked(pointRequest).mockResolvedValue(pending())
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} />)
  await advance(180_000)
  const previousReads = vi.mocked(pointRequest).mock.calls.length
  await dispatch(event === 'visibilitychange' ? document : window, event)
  expect(pointRequest).toHaveBeenCalledTimes(previousReads + 1)
  await advance(3_000)
  expect(pointRequest).toHaveBeenCalledTimes(previousReads + 2)
})

test.each(['hidden', 'offline'] as const)('finishing a simulation while %s pauses all status requests until the payment view resumes', async pause => {
  const event = deferred<{ accepted: true }>(), initial = pending(), resolved = vi.fn()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate' ? event.promise : initial)
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  if (pause === 'hidden') { hidden = true; await dispatch(document, 'visibilitychange') }
  else { online = false; await dispatch(window, 'offline') }
  await act(async () => { event.resolve({ accepted: true }); await event.promise })
  await advance(180_000)
  expect(pointRequest).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  expect(resolved).not.toHaveBeenCalled()
  if (pause === 'hidden') { hidden = false; await dispatch(document, 'visibilitychange') }
  else { online = true; await dispatch(window, 'online') }
  expect(pointRequest).toHaveBeenLastCalledWith(pointAccess, { command: 'status', checkoutId: initial.id })
  expect(pointRequest).toHaveBeenCalledTimes(2)
  await advance(3_000)
  expect(pointRequest).toHaveBeenCalledTimes(3)
  expect(screen.getByRole('button', { name: 'Resultado solicitado' }).hasAttribute('disabled')).toBe(true)
})

test('simulation response from a closed operator session cannot arm polling or restore a requested result', async () => {
  const event = deferred<{ accepted: true }>(), initial = pending(), resolved = vi.fn()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate' ? event.promise : initial)
  const view = render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  view.rerender(<PointPayment access={{ ...pointAccess, operatorToken: 'next-synthetic-session' }} initialCheckout={initial} settings={sandbox()} onResolved={resolved} />)
  await act(async () => { event.resolve({ accepted: true }); await event.promise })
  expect(screen.queryByRole('button', { name: 'Resultado solicitado' })).toBeNull()
  expect(pointRequest).toHaveBeenCalledTimes(1)
  await advance(3_000)
  expect(pointRequest).toHaveBeenLastCalledWith({ ...pointAccess, operatorToken: 'next-synthetic-session' }, { command: 'status', checkoutId: initial.id })
  expect(resolved).not.toHaveBeenCalled()
})

test('an immediate post-simulation check observes rejection without manufacturing a receipt', async () => {
  const initial = pending(), rejected = { ...initial, state: 'rejected' as const }, resolved = vi.fn()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate' ? { accepted: true } : rejected)
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={sandbox()} onResolved={resolved} onDone={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await act(async () => {})
  expect(screen.getByRole('heading', { name: 'Pago rechazado' })).toBeTruthy()
  expect(screen.queryByText('Recibo sintético')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Volver a la cuenta' })).toBeTruthy()
  expect(resolved).toHaveBeenCalledExactlyOnceWith(rejected)
  await advance(30_000)
  expect(pointRequest).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

test('a slow simulation queues its first status request after completion without overlapping wake events or timers', async () => {
  const event = deferred<{ accepted: true }>(), status = deferred<PointCheckout>(), resolved = vi.fn()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate' ? event.promise : status.promise)
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} onResolved={resolved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await dispatch(window, 'focus'); await dispatch(window, 'online'); await dispatch(document, 'visibilitychange')
  await advance(30_000)
  expect(pointRequest).toHaveBeenCalledTimes(1)
  await act(async () => { event.resolve({ accepted: true }); await event.promise })
  expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['simulate', 'status'])
  await dispatch(window, 'focus'); await dispatch(window, 'online'); await dispatch(document, 'visibilitychange')
  await advance(30_000)
  expect(pointRequest).toHaveBeenCalledTimes(2)
  expect(resolved).not.toHaveBeenCalled()
  await act(async () => { status.resolve(pointPaid()); await status.promise })
  expect(resolved).toHaveBeenCalledExactlyOnceWith(pointPaid())
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
  await advance(30_000)
  expect(pointRequest).toHaveBeenCalledTimes(2)
})

test('denied access in the immediate post-simulation read stops all old-session wake events and timers', async () => {
  const denied = new AccountClientError('SESSION_EXPIRED', 'Tu sesión venció.'), onSessionError = vi.fn(), resolved = vi.fn()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'simulate') return { accepted: true }
    throw denied
  })
  render(<PointPayment access={pointAccess} initialCheckout={pending()} settings={sandbox()} onSessionError={onSessionError} onResolved={resolved} />)
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await act(async () => {})
  expect(onSessionError).toHaveBeenCalledExactlyOnceWith(denied)
  expect(screen.getByRole('alert').textContent).toBe('Tu sesión venció.')
  await dispatch(window, 'focus'); await dispatch(window, 'online'); await dispatch(document, 'visibilitychange')
  await advance(180_000)
  expect(pointRequest).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
  expect(resolved).not.toHaveBeenCalled()
})
