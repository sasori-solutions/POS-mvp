const encoder = new TextEncoder()
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function bytes(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) }
export function randomSecret(): string { return base64(crypto.getRandomValues(new Uint8Array(32))) }
export async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), n => n.toString(16).padStart(2, '0')).join('') }
export async function challenge(verifier: string): Promise<string> { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))) }
/** Key IDs permit rotation. Binding is immutable business/provider/environment, never browser supplied. */
export class TokenVault {
  constructor(private readonly keys: Record<string, string>, private readonly active: string) {
    if (!keys[active] || !/^[A-Za-z0-9_-]{1,32}$/.test(active)) throw new Error('Missing token encryption key')
    for (const raw of Object.values(keys)) if (bytes(raw).length !== 32) throw new Error('Invalid token encryption key')
  }
  private async key(id: string, usage: KeyUsage[]): Promise<CryptoKey> {
    if (!Object.hasOwn(this.keys, id)) throw new Error('Unknown token encryption key')
    return await crypto.subtle.importKey('raw', bytes(this.keys[id]), 'AES-GCM', false, usage)
  }
  async seal(value: unknown, binding: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(binding) }, await this.key(this.active, ['encrypt']), encoder.encode(JSON.stringify(value)))
    return [this.active, base64(iv), base64(new Uint8Array(ciphertext))].join('.')
  }
  async open<T>(sealed: string, binding: string): Promise<T> {
    const [id, iv, encrypted, extra] = sealed.split('.')
    if (!id || !iv || !encrypted || extra || sealed.length > 32768) throw new Error('Invalid encrypted token')
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: encoder.encode(binding) }, await this.key(id, ['decrypt']), bytes(encrypted))
    return JSON.parse(new TextDecoder().decode(plain)) as T
  }
}
