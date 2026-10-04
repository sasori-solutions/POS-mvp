import { createHash, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export function localConfiguration(source, checkout, port) {
  const hash = createHash('sha256').update(checkout).digest('hex')
  const projectId = `pos-dev-${hash.slice(0, 10)}`
  const base = 40000 + (parseInt(hash.slice(0, 6), 16) % 1000) * 20
  const config = source.replace(/^project_id = .+$/m, `project_id = "${projectId}"`)
    .replace(/^(port|shadow_port) = (543\d\d)$/gm, (_, key, value) => `${key} = ${base + Number(value) - 54320}`)
    .replace(/^inspector_port = \d+$/m, `inspector_port = ${base + 13}`)
    .replace(/^site_url = .+$/m, `site_url = "http://127.0.0.1:${port}"`)
  return { projectId, config, apiUrl: `http://127.0.0.1:${base + 1}`, pointSimulatorPort: base + 17 }
}

export function requireLoopback(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error('Development setup refuses a non-loopback Supabase backend.')
  }
}

export async function seedDevelopment(config) {
  requireLoopback(config.API_URL)
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, options)
  const password = 'Local-POS-only-2026!'
  const existing = []
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error('Could not read local fixture accounts.')
    existing.push(...data.users)
    if (data.users.length < 1000) break
  }
  for (const email of ['owner@pos.local.test', 'new@pos.local.test', 'employee@pos.local.test']) {
    const user = existing.find(user => user.email === email)
    if (user) {
      if (user.app_metadata.pos_local_development !== true) throw new Error('Fixture email belongs to an account not managed by development setup.')
      continue
    }
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { pos_local_development: true } })
    if (error) throw new Error('Could not create a local fixture account.')
  }

  const owner = createClient(config.API_URL, config.ANON_KEY, options)
  const { data, error } = await owner.auth.signInWithPassword({ email: 'owner@pos.local.test', password })
  if (error || !data.session) throw new Error('Could not sign in as the local fixture owner.')
  async function account(payload) {
    const response = await fetch(`${config.API_URL}/functions/v1/account`, {
      method: 'POST', headers: { apikey: config.ANON_KEY, authorization: `Bearer ${data.session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    })
    const result = await response.json()
    if (!response.ok || !result.data) throw new Error(`Local fixture API failed: ${result.error?.code ?? response.status}`)
    return result.data
  }
  try {
    const status = await account({ action: 'status' })
    if (status.businesses.length) return { created: false }
    const created = await account({ action: 'create_business', operationId: randomUUID(), name: 'Cafetería de desarrollo', businessType: 'cafe', timezone: 'America/Mexico_City', pin: '123456', profile: {
      branchName: 'Sucursal de prueba', registerName: 'Caja local', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash', 'card_external', 'transfer'],
    } })
    // Seed only a brand-new business. Never overwrite edited/deactivated/deleted products.
    for (const product of [{ name: 'Americano', category: 'Café', priceCents: 3500 }, { name: 'Latte', category: 'Café', priceCents: 5500 }, { name: 'Pan de prueba', category: 'Pan', priceCents: 2800 }]) {
      await account({ action: 'pos', businessId: created.business.id, operatorToken: created.operatorToken, command: 'save_product', operationId: randomUUID(), productId: randomUUID(), expectedVersion: null, ...product })
    }
    await account({ action: 'lock', businessId: created.business.id, operatorToken: created.operatorToken })
    return { created: true }
  } finally {
    await owner.auth.signOut({ scope: 'local' })
  }
}
