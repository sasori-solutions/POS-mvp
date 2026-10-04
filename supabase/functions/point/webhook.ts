import { digest } from './crypto.ts'
export class SignatureError extends Error {}
export async function verifySignature(request: Request, secrets: string[]): Promise<{ remoteOrderId: string; eventKey: string; signatureTimestamp: string }> {
  const url = new URL(request.url), ids = url.searchParams.getAll('data.id')
  const requestId = request.headers.get('x-request-id')
  const signature = request.headers.get('x-signature')
  if (ids.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(ids[0]) || !requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
    || !signature || signature.length > 1024 || url.searchParams.getAll('type').length !== 1 || url.searchParams.get('type') !== 'order') throw new SignatureError()
  const parts = signature.split(',').map(part => part.trim().split('='))
  if (parts.length !== 2 || parts.some(part => part.length !== 2) || new Set(parts.map(p => p[0])).size !== 2) throw new SignatureError()
  const fields = Object.fromEntries(parts), ts = String(fields.ts ?? ''), hex = String(fields.v1 ?? '')
  if (!/^\d{1,20}$/.test(ts ?? '') || !/^[a-fA-F0-9]{64}$/.test(hex ?? '')) throw new SignatureError()
  // Official manifest signs QUERY id (lowercased), request ID and timestamp; the JSON body is not signed.
  const manifest = `id:${ids[0].toLowerCase()};request-id:${requestId};ts:${ts};`
  const signatureBytes = Uint8Array.from(hex.match(/../g)!, part => parseInt(part, 16))
  let valid = false
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    valid = await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(manifest)) || valid
  }
  if (!valid) throw new SignatureError()
  // No freshness rejection: MP retries hours/days later. Persistent deduplication and authoritative GET prevent replay effects.
  return { remoteOrderId: ids[0], eventKey: await digest(manifest + hex.toLowerCase()), signatureTimestamp: ts }
}
