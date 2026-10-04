export class HttpError extends Error { constructor(readonly status: number) { super('Invalid request') } }
export const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
export function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: responseHeaders }) }
export async function boundedBody(request: Request, maximum = 8192): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) throw new HttpError(400)
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new HttpError(413)
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let count = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      count += part.value.length
      if (count > maximum) { await reader.cancel(); throw new HttpError(413) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(count)
  let index = 0
  for (const part of chunks) { bytes.set(part, index); index += part.length }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new HttpError(400) }
}
export function serviceKey(env = (name: string) => Deno.env.get(name)): string {
  const direct = env('SUPABASE_SERVICE_ROLE_KEY') ?? env('SUPABASE_SECRET_KEY')
  if (direct) return direct
  const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}')
  if (typeof keys.default !== 'string') throw new Error('Missing backend key')
  return keys.default
}
export async function workerAuthorized(request: Request, secret: string): Promise<boolean> {
  const candidate = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  if (secret.length < 32 || candidate.length > 256) return false
  // Constant-size digest comparison avoids credential-dependent comparison length/timing.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const message = new TextEncoder().encode('point-worker')
  const signature = await crypto.subtle.sign('HMAC', key, message)
  const supplied = await crypto.subtle.importKey('raw', new TextEncoder().encode(candidate || 'invalid'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return await crypto.subtle.verify('HMAC', supplied, signature, message)
}
