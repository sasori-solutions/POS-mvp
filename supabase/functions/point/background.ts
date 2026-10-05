import { runWorker } from './service.ts'
import type { Configuration, RpcClient, WorkerScope } from './service.ts'

export interface BackgroundRuntime { waitUntil(task: Promise<unknown>): void }
interface BackgroundOptions { enabled?: boolean; runtime?: BackgroundRuntime; configuration?: Configuration }

/** Wake only work identified by an authorized command or authenticated webhook.
 * The durable queue/leases remain authoritative when an instance is interrupted.
 */
export function backgroundPointWork(admin: RpcClient, scope: WorkerScope, options: BackgroundOptions = {}): void {
  const runtime = options.runtime ?? (globalThis as unknown as { EdgeRuntime?: BackgroundRuntime }).EdgeRuntime
  if (!runtime || !(options.enabled ?? Deno.env.get('POINT_IMMEDIATE_WORK_ENABLED') !== 'false')) return
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!scope || !uuid.test(scope.businessId) || !uuid.test(scope.attemptId)) return
  const target = { businessId: scope.businessId, attemptId: scope.attemptId }
  const task = Promise.resolve().then(() => runWorker(admin, options.configuration, target)).catch(() => {
    // Do not log provider credentials or turn a wake-up failure into a rejected
    // charge. Persisted jobs and expired leases remain available to the scheduler.
  })
  try { runtime.waitUntil(task) } catch { /* The periodic worker still owns recovery. */ }
}
