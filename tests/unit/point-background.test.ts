import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { backgroundPointWork } from '../../supabase/functions/point/background'
import { runWorker } from '../../supabase/functions/point/service'

vi.mock('../../supabase/functions/point/service', () => ({ runWorker: vi.fn() }))
const scope = { businessId: '10000000-0000-4000-8000-000000000001', attemptId: '20000000-0000-4000-8000-000000000001' }
const admin = { rpc: vi.fn() }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(runWorker).mockResolvedValue({ processed: 1, failed: 0 }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('registers one scoped task without awaiting provider work in the HTTP response', async () => {
  let finish!: (value: { processed: number; failed: number }) => void
  vi.mocked(runWorker).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const waitUntil = vi.fn()
  expect(backgroundPointWork(admin, scope, { enabled: true, runtime: { waitUntil } })).toBeUndefined()
  expect(waitUntil).toHaveBeenCalledTimes(1)
  expect(runWorker).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(runWorker).toHaveBeenCalledExactlyOnceWith(admin, undefined, scope)
  finish({ processed: 1, failed: 0 })
  await expect(waitUntil.mock.calls[0][0]).resolves.toEqual({ processed: 1, failed: 0 })
})

test('captures the server scope before scheduling an asynchronous task', async () => {
  const target = { ...scope }, waitUntil = vi.fn()
  backgroundPointWork(admin, target, { enabled: true, runtime: { waitUntil } })
  target.businessId = '30000000-0000-4000-8000-000000000001'
  await waitUntil.mock.calls[0][0]
  expect(runWorker).toHaveBeenCalledExactlyOnceWith(admin, undefined, scope)
})

test('leaves explicit manual-worker test mode untouched', async () => {
  const waitUntil = vi.fn()
  backgroundPointWork(admin, scope, { enabled: false, runtime: { waitUntil } })
  await Promise.resolve()
  expect(waitUntil).not.toHaveBeenCalled()
  expect(runWorker).not.toHaveBeenCalled()
})

test('does not launch untracked work when a runtime cannot retain a task', async () => {
  vi.stubGlobal('EdgeRuntime', undefined)
  backgroundPointWork(admin, scope, { enabled: true })
  await Promise.resolve()
  expect(runWorker).not.toHaveBeenCalled()
})

test.each([
  { businessId: '', attemptId: scope.attemptId },
  { businessId: scope.businessId, attemptId: '' },
  { businessId: 'another-business', attemptId: scope.attemptId },
])('rejects malformed server scope without launching provider work: %j', async target => {
  const waitUntil = vi.fn()
  backgroundPointWork(admin, target, { enabled: true, runtime: { waitUntil } })
  await Promise.resolve()
  expect(waitUntil).not.toHaveBeenCalled()
  expect(runWorker).not.toHaveBeenCalled()
})

test('contains a worker failure and preserves response/recovery without logging provider data', async () => {
  const waitUntil = vi.fn(), error = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(runWorker).mockRejectedValue(new Error('synthetic provider failure'))
  backgroundPointWork(admin, scope, { enabled: true, runtime: { waitUntil } })
  await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined()
  expect(error).not.toHaveBeenCalled()
})

test('a runtime registration failure cannot reject the accepted command or duplicate work', async () => {
  const waitUntil = vi.fn(() => { throw new Error('synthetic runtime interruption') })
  expect(() => backgroundPointWork(admin, scope, { enabled: true, runtime: { waitUntil } })).not.toThrow()
  await Promise.resolve()
  expect(runWorker).toHaveBeenCalledTimes(1)
})
