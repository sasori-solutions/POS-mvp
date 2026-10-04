import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { json, serviceKey, workerAuthorized } from '../point/http.ts'
import { runWorker } from '../point/service.ts'
export async function handleWorker(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405)
  try {
    if (!await workerAuthorized(request, Deno.env.get('POINT_WORKER_SECRET') ?? '')) return json({ error: { code: 'AUTH_REQUIRED' } }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } })
    return json({ data: await runWorker(admin) })
  } catch {
    // No request, credential, provider response, user or DB error is logged.
    return json({ error: { code: 'SERVER_ERROR' } }, 503)
  }
}
Deno.serve(handleWorker)
