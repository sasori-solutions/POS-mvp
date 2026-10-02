const databaseName = 'pos-mexico-employee-device'
const storeName = 'keys'
const identityId = 'identity'
const storageMessage = 'No pudimos guardar o leer la vinculación de este dispositivo. Permite el almacenamiento del navegador e inténtalo de nuevo.'

interface DeviceIdentity {
  privateKey: CryptoKey
  publicKey: CryptoKey
}

export interface EmployeeDeviceProof {
  publicKey: string
  nonce: string
  issuedAt: number
  signature: string
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let blocked = false
    request.onupgradeneeded = () => request.result.createObjectStore(storeName)
    request.onerror = () => reject(new Error(storageMessage))
    request.onblocked = () => {
      blocked = true
      reject(new Error(storageMessage))
    }
    request.onsuccess = () => {
      const database = request.result
      if (blocked) {
        database.close()
        return
      }
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

function readIdentity(database: IDBDatabase): Promise<DeviceIdentity | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).get(identityId)
    transaction.oncomplete = () => resolve(request.result as DeviceIdentity | undefined)
    transaction.onabort = () => reject(new Error(storageMessage))
  })
}

function storeIdentityIfAbsent(database: IDBDatabase, candidate: DeviceIdentity): Promise<void> {
  return new Promise((resolve, reject) => {
    // IndexedDB serializes read/write transactions across tabs. Generate outside
    // the transaction, then keep the first committed identity for every caller.
    const transaction = database.transaction(storeName, 'readwrite', { durability: 'strict' })
    const store = transaction.objectStore(storeName)
    const request = store.get(identityId)
    request.onsuccess = () => {
      if (request.result !== undefined) return
      try {
        store.put(candidate, identityId)
      } catch {
        transaction.abort()
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(new Error(storageMessage))
  })
}

function validateIdentity(identity: DeviceIdentity | undefined): asserts identity is DeviceIdentity {
  const privateKey = identity?.privateKey
  const publicKey = identity?.publicKey
  if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof CryptoKey)
    || privateKey.type !== 'private' || privateKey.extractable || !privateKey.usages.includes('sign')
    || publicKey.type !== 'public' || !publicKey.extractable || !publicKey.usages.includes('verify')
    || privateKey.algorithm.name !== 'ECDSA' || publicKey.algorithm.name !== 'ECDSA'
    || (privateKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256'
    || (publicKey.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256') {
    throw new Error(storageMessage)
  }
}

async function loadIdentity(): Promise<DeviceIdentity> {
  let database: IDBDatabase | undefined
  try {
    database = await openDatabase()
    let identity = await readIdentity(database)
    if (identity === undefined) {
      const candidate = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      await storeIdentityIfAbsent(database, candidate)
      // Read back the committed CryptoKeys: a failed write/clone must never let
      // an ephemeral key masquerade as a durable device identity.
      identity = await readIdentity(database)
    }
    validateIdentity(identity)
    return identity
  } catch {
    throw new Error(storageMessage)
  } finally {
    database?.close()
  }
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Signs the exact request with this browser profile's persisted device key. */
export async function signEmployeeDeviceRequest(request: object): Promise<EmployeeDeviceProof> {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID
    || !globalThis.indexedDB || !globalThis.CryptoKey) {
    throw new Error('Este navegador no permite vincular el dispositivo de forma segura. Abre la aplicación en un navegador actualizado con HTTPS y almacenamiento disponible.')
  }
  // Recheck storage on every call; logout removes sessions, not this identity.
  const identity = await loadIdentity()
  const nonce = crypto.randomUUID()
  const issuedAt = Date.now()
  const message = new TextEncoder().encode(JSON.stringify({ request, nonce, issuedAt }))
  const [publicKey, signature] = await Promise.all([
    crypto.subtle.exportKey('spki', identity.publicKey),
    crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, message),
  ])
  return { publicKey: base64url(publicKey), nonce, issuedAt, signature: base64url(signature) }
}
