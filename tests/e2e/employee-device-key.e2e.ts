import { expect, test, type Page } from '@playwright/test'

const databaseName = 'pos-mexico-employee-device'
const request = { action: 'unlock', businessId: '10000000-0000-4000-8000-000000000001', pin: '482951' }

async function sign(page: Page) {
  return page.evaluate(async (payload) => {
    const { signEmployeeDeviceRequest } = await import('/src/lib/employee-device.ts')
    return signEmployeeDeviceRequest(payload)
  }, request)
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
  await page.goto('/')
})

test('device proof verifies the exact payload with raw ECDSA and rejects altered requests', async ({ page }) => {
  const proof = await sign(page)
  expect(proof.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(proof.signature).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(proof.nonce).toMatch(/^[0-9a-f-]{36}$/)
  expect(Number.isSafeInteger(proof.issuedAt)).toBe(true)
  const result = await page.evaluate(async ({ proof, request }) => {
    const decode = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0))
    const publicKey = await crypto.subtle.importKey('spki', decode(proof.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    const verify = (payload: object) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, decode(proof.signature), new TextEncoder().encode(JSON.stringify({ request: payload, nonce: proof.nonce, issuedAt: proof.issuedAt })))
    return { valid: await verify(request), tampered: await verify({ ...request, pin: '000000' }), bytes: decode(proof.signature).byteLength }
  }, { proof, request })
  expect(result).toEqual({ valid: true, tampered: false, bytes: 64 })
  const second = await sign(page)
  expect(second.publicKey).toBe(proof.publicKey)
  expect(second.nonce).not.toBe(proof.nonce)
})

test('the persisted private key cannot be exported and survives reload and cleared login storage', async ({ page }) => {
  const first = await sign(page)
  const stored = await page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const identity = await new Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>((resolve, reject) => {
      const transaction = database.transaction('keys', 'readonly')
      const request = transaction.objectStore('keys').get('identity')
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
    let exportError = ''
    try { await crypto.subtle.exportKey('jwk', identity.privateKey) } catch (error) { exportError = (error as DOMException).name }
    localStorage.clear()
    sessionStorage.clear()
    return { privateExtractable: identity.privateKey.extractable, publicExtractable: identity.publicKey.extractable, exportError }
  }, databaseName)
  expect(stored).toEqual({ privateExtractable: false, publicExtractable: true, exportError: 'InvalidAccessError' })
  await page.reload()
  expect((await sign(page)).publicKey).toBe(first.publicKey)
})

test('concurrent tabs commit one shared browser identity', async ({ page, context }) => {
  const tabs = [page, await context.newPage(), await context.newPage()]
  await Promise.all(tabs.slice(1).map((tab) => tab.goto('/')))
  const proofs = await Promise.all(tabs.map(sign))
  expect(new Set(proofs.map((proof) => proof.publicKey)).size).toBe(1)
  expect(new Set(proofs.map((proof) => proof.nonce)).size).toBe(3)
  await page.reload()
  expect((await sign(page)).publicKey).toBe(proofs[0].publicKey)
})

test('failed persistence rejects signing instead of using a temporary key', async ({ page }) => {
  const result = await page.evaluate(async (payload) => {
    const { signEmployeeDeviceRequest } = await import('/src/lib/employee-device.ts')
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = () => { throw new DOMException('Storage denied', 'QuotaExceededError') }
    try {
      await signEmployeeDeviceRequest(payload)
      return 'unexpected success'
    } catch (error) {
      return (error as Error).message
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
  }, request)
  expect(result).toMatch(/guardar|almacenamiento/i)
  const proof = await sign(page)
  await page.reload()
  expect((await sign(page)).publicKey).toBe(proof.publicKey)
})

test('an existing key is unusable while storage is unavailable', async ({ page }) => {
  await sign(page)
  const error = await page.evaluate(async (payload) => {
    const { signEmployeeDeviceRequest } = await import('/src/lib/employee-device.ts')
    IDBFactory.prototype.open = () => { throw new DOMException('Storage denied', 'SecurityError') }
    try { await signEmployeeDeviceRequest(payload); return 'unexpected success' } catch (error) { return (error as Error).message }
  }, request)
  expect(error).toMatch(/guardar|almacenamiento/i)
})

test('unsupported browsers get a clear error before attempting enrollment', async ({ page }) => {
  const error = await page.evaluate(async (payload) => {
    const { signEmployeeDeviceRequest } = await import('/src/lib/employee-device.ts')
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    try { await signEmployeeDeviceRequest(payload); return 'unexpected success' } catch (error) { return (error as Error).message }
  }, request)
  expect(error).toMatch(/navegador.*segura/i)
})
