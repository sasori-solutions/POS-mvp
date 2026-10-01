import { createClient, isAuthSessionMissingError, type Session } from '@supabase/supabase-js'

export const authStorageKey = 'pos-mexico-auth'
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
export const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
let acceptIdentityWrites = true
let acceptVerifierWrites = true
let identityGeneration = 0
let cancellationConfirmed = true
let closingStorage: Map<string, string> | undefined

function isVerifierKey(key: string) {
  return key === `${authStorageKey}-code-verifier` || key === `${authStorageKey}-flows-code-verifier` ||
    (key.startsWith(`${authStorageKey}-flow-`) && key.endsWith('-code-verifier'))
}

function sanitizeIdentity(value: string): string | null {
  try {
    const identity: unknown = JSON.parse(value)
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null
    const safe = identity as Record<string, unknown>
    delete safe.provider_token
    delete safe.provider_refresh_token
    return JSON.stringify(safe)
  } catch {
    return null
  }
}

const identityStorage = {
  getItem(key: string) {
    // A closed document must not load another document's fresh identity.
    if (!acceptIdentityWrites && key === authStorageKey) return null
    const value = localStorage.getItem(key)
    if (!value || key !== authStorageKey) return value
    const safe = sanitizeIdentity(value)
    if (safe === null) localStorage.removeItem(key)
    else if (safe !== value) localStorage.setItem(key, safe)
    return safe
  },
  setItem(key: string, value: string) {
    if (!acceptIdentityWrites && !(acceptVerifierWrites && isVerifierKey(key))) return
    const safe = key === authStorageKey ? sanitizeIdentity(value) : value
    if (safe !== null) localStorage.setItem(key, safe)
  },
  removeItem(key: string) {
    if (!acceptIdentityWrites && localStorage.getItem(key) !== closingStorage?.get(key)) return
    localStorage.removeItem(key)
  },
}

export function hasCurrentStoredIdentity(accessToken?: string): boolean {
  try {
    const value = localStorage.getItem(authStorageKey)
    if (!value) return false
    const identity = JSON.parse(value) as Partial<Session>
    return typeof identity.access_token === 'string' &&
      typeof identity.expires_at === 'number' && identity.expires_at * 1_000 > Date.now() &&
      (!accessToken || identity.access_token === accessToken)
  } catch {
    return false
  }
}

function validConfiguration() {
  if (!supabaseUrl || !supabasePublishableKey) return false
  try {
    const url = new URL(supabaseUrl)
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  } catch {
    return false
  }
}

export const supabase = validConfiguration()
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        storageKey: authStorageKey,
        flowType: 'pkce',
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true,
        storage: identityStorage,
      },
      global: {
        fetch: (input, options) => fetch(input, {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        }),
      },
    })
  : null

// One initialization promise also prevents a remount from exchanging an OAuth code twice.
let initialization: Promise<Session | null> | undefined

export function initializeIdentity(): Promise<Session | null> {
  if (!supabase) return Promise.resolve(null)
  const client = supabase
  initialization ??= (async () => {
    const generation = identityGeneration
    const url = new URL(window.location.href)
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code')
      const denied = url.searchParams.has('error')
      window.history.replaceState({}, '', '/login')
      if (denied) throw new Error('No se completó el acceso con Google. Intenta de nuevo.')
      if (code) {
        const { data, error } = await client.auth.exchangeCodeForSession(code)
        if (generation !== identityGeneration) {
          if (!await discardLateIdentity(data.session?.access_token)) cancellationConfirmed = false
          return null
        }
        if (error) throw new Error('El enlace de acceso venció. Vuelve a continuar con Google.')
        return data.session
      }
    }
    const { data, error } = await client.auth.getSession()
    if (generation !== identityGeneration) {
      if (!await discardLateIdentity(data.session?.access_token)) cancellationConfirmed = false
      return null
    }
    if (error) throw new Error('No pudimos recuperar tu sesión. Vuelve a entrar con Google.')
    return data.session
  })()
  return initialization
}

export function clearStoredIdentity() {
  // Include the SDK's per-flow verifiers without touching other applications.
  for (const key of Object.keys(localStorage)) {
    if (key === authStorageKey || isVerifierKey(key)) {
      identityStorage.removeItem(key)
    }
  }
}

export function allowIdentitySignIn() {
  // The new PKCE redirect reloads the document. Until then, cancelled old identity
  // responses remain blocked while the fresh flow may save its verifier.
  acceptVerifierWrites = true
}

/** Revoke a captured Supabase JWT even after its browser storage has been cleared. */
async function discardIdentity(accessToken?: string): Promise<boolean> {
  const client = supabase
  if (!client) return true
  // This SDK method uses the user's JWT for /logout; no administrator key is used.
  const remote = accessToken ? client.auth.admin.signOut(accessToken, 'local') : Promise.resolve({ error: null })
  clearStoredIdentity()
  const local = client.auth.signOut({ scope: 'local' })
  const results = await Promise.allSettled([remote, local])
  clearStoredIdentity()
  // Repeated logout is confirmed when Auth says this session no longer exists.
  // The SDK maps session_not_found to AuthSessionMissingError and drops its code.
  return results.every((result) => result.status === 'fulfilled' && (
    !result.value.error || result.value.error.code === 'session_not_found' ||
    isAuthSessionMissingError(result.value.error)
  ))
}

export async function closeIdentity(accessToken?: string): Promise<boolean> {
  if (acceptIdentityWrites) {
    closingStorage = new Map(Object.keys(localStorage).flatMap((key) => {
      if (key !== authStorageKey && !isVerifierKey(key)) return []
      const value = localStorage.getItem(key)
      return value === null ? [] : [[key, value] as const]
    }))
  }
  acceptIdentityWrites = false
  acceptVerifierWrites = false
  identityGeneration += 1
  const pending = initialization
  const closed = discardIdentity(accessToken)
  // A cancelled callback must settle and revoke any late JWT before signing in again.
  await pending?.catch(() => null)
  const confirmed = await closed
  clearStoredIdentity()
  return confirmed && cancellationConfirmed
}

export async function discardLateIdentity(accessToken?: string): Promise<boolean> {
  if (!supabase || !accessToken) return true
  // The cancelled request owns this JWT, but newer shared storage belongs to
  // another document. Revoke only the returned session without local signout.
  try {
    const { error } = await supabase.auth.admin.signOut(accessToken, 'local')
    const confirmed = !error || error.code === 'session_not_found' || isAuthSessionMissingError(error)
    if (!confirmed) cancellationConfirmed = false
    return confirmed
  } catch {
    cancellationConfirmed = false
    return false
  }
}
