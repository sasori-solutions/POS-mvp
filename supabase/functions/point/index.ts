import { boundedBody, HttpError, json } from './http.ts'
/** Dedicated authenticated facade. account owns identity, browser proof and SQL authorization. */
Deno.serve(async request => {
  try {
    if (request.method !== 'POST' && request.method !== 'OPTIONS') return json({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405)
    const url = Deno.env.get('SUPABASE_URL')
    if (!url) return json({ error: { code: 'SERVER_ERROR' } }, 503)
    const headers = new Headers()
    for (const name of ['authorization', 'apikey', 'origin', 'content-type', 'access-control-request-headers', 'access-control-request-method']) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    let body: string | undefined
    if (request.method === 'POST') {
      const value = await boundedBody(request)
      if (!value || typeof value !== 'object' || !['point', 'device_point'].includes(String((value as Record<string, unknown>).action))) return json({ error: { code: 'VALIDATION_ERROR' } }, 400)
      body = JSON.stringify(value)
    }
    const response = await fetch(`${url}/functions/v1/account`, { method: request.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(25000) })
    return new Response(response.body, { status: response.status, headers: response.headers })
  } catch (error) {
    return json({ error: { code: error instanceof HttpError ? 'VALIDATION_ERROR' : 'SERVER_ERROR' } }, error instanceof HttpError ? error.status : 503)
  }
})
