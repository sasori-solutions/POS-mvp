import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { boundedBody, HttpError, json, serviceKey } from '../point/http.ts'
import { serviceRpc } from '../point/service.ts'
import { backgroundPointWork } from '../point/background.ts'
import { SignatureError, verifySignature, webhookSecrets } from '../point/webhook.ts'
export async function handleWebhook(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405)
  try {
    const secrets = webhookSecrets(name => Deno.env.get(name))
    if (secrets.length === 0) return json({ error: { code: 'SERVER_ERROR' } }, 503)
    const evidence = await verifySignature(request, secrets)
    const payload = await boundedBody(request)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400)
    const body = payload as Record<string, unknown>, data = body.data as Record<string, unknown> | undefined
    if (body.type !== 'order' || typeof data?.id !== 'string' || data.id.toLowerCase() !== evidence.remoteOrderId.toLowerCase()) throw new HttpError(400)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } })
    // ONLY authenticated locator is stored. Unsigned financial/account fields cannot establish a tenant or payment.
    const enqueued = await serviceRpc(admin, 'webhook_enqueue', evidence)
    // ACK only after durable storage; financial evidence is fetched separately.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (enqueued.accepted === true && enqueued.matched === true
      && typeof enqueued.businessId === 'string' && uuid.test(enqueued.businessId)
      && typeof enqueued.attemptId === 'string' && uuid.test(enqueued.attemptId)) {
      backgroundPointWork(admin, { businessId: enqueued.businessId, attemptId: enqueued.attemptId })
    }
    return json({ received: true }, 200)
  } catch (error) {
    if (error instanceof SignatureError) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } })
      try { await serviceRpc(admin, 'webhook_invalid_signature', {}) } catch { return json({ error: { code: 'SERVER_ERROR' } }, 503) }
      return json({ error: { code: 'SIGNATURE_INVALID' } }, 401)
    }
    if (error instanceof HttpError) return json({ error: { code: 'VALIDATION_ERROR' } }, error.status)
    // Durable write failure is deliberately not acknowledged; provider will retry.
    return json({ error: { code: 'SERVER_ERROR' } }, 503)
  }
}
if (import.meta.main) Deno.serve(handleWebhook)
