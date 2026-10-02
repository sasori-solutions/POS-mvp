import { isUuid, RequestValidationError } from './validation.ts'

export class DeviceProofError extends Error {}

function decode(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > maximum) throw new DeviceProofError()
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

/** Verify the exact wire payload before the ordinary parser normalizes names. */
export async function verifiedDeviceRequest(raw: unknown): Promise<{
  request: Record<string, unknown>; keyHash: string | null; nonce: string | null
}> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RequestValidationError()
  const { deviceProof, ...request } = raw as Record<string, unknown>
  if (deviceProof === undefined) return { request, keyHash: null, nonce: null }
  try {
    if (!deviceProof || typeof deviceProof !== 'object' || Array.isArray(deviceProof)) throw new DeviceProofError()
    const proof = deviceProof as Record<string, unknown>
    if (Object.keys(proof).length !== 4 || !isUuid(proof.nonce) || !Number.isSafeInteger(proof.issuedAt)
      || Math.abs(Date.now() - (proof.issuedAt as number)) > 120_000) throw new DeviceProofError()
    const publicKey = decode(proof.publicKey, 256)
    const signature = decode(proof.signature, 128)
    if (signature.byteLength !== 64) throw new DeviceProofError()
    const key = await crypto.subtle.importKey('spki', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const message = new TextEncoder().encode(JSON.stringify({ request, nonce: proof.nonce, issuedAt: proof.issuedAt }))
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message)) throw new DeviceProofError()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey))
    return { request, keyHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''), nonce: proof.nonce }
  } catch {
    throw new DeviceProofError()
  }
}
