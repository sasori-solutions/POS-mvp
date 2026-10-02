import { randomUUID, webcrypto } from 'node:crypto'

const keys = new Map<string, Promise<CryptoKeyPair>>()
/** Synthetic local integration identities have one stable browser key per person. */
export async function signedRequest(userId: string | undefined, request: Record<string, unknown>) {
  if (!userId || String(request.action).startsWith('device_') || ['pin_email_details', 'confirm_pin_email'].includes(String(request.action))) return request
  let pair = keys.get(userId)
  if (!pair) {
    pair = webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as Promise<CryptoKeyPair>
    keys.set(userId, pair)
  }
  const key = await pair
  const nonce = randomUUID()
  const issuedAt = Date.now()
  const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(JSON.stringify({ request, nonce, issuedAt })))
  const publicKey = await webcrypto.subtle.exportKey('spki', key.publicKey)
  return { ...request, deviceProof: { publicKey: Buffer.from(publicKey).toString('base64url'), nonce, issuedAt, signature: Buffer.from(signature).toString('base64url') } }
}
