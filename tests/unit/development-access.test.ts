import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

async function enabled(overrides: Record<string, string | boolean> = {}) {
  const env = { DEV: true, MODE: 'development', VITE_LOCAL_PASSWORD_AUTH: 'true', VITE_SUPABASE_URL: 'http://127.0.0.1:55321', ...overrides }
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const { developmentLoginEnabled } = await import('../../src/lib/development')
  return developmentLoginEnabled
}

test('development password login works with the explicit flag and a loopback backend', async () => {
  expect(await enabled()).toBe(true)
})

test.each([
  { DEV: false }, { MODE: 'production' }, { MODE: 'test' }, { VITE_LOCAL_PASSWORD_AUTH: 'false' },
  { VITE_SUPABASE_URL: 'https://project.supabase.co' },
  { VITE_SUPABASE_URL: 'http://localhost.attacker.test' },
  { VITE_SUPABASE_URL: 'http://192.168.1.10:54321' },
  { VITE_SUPABASE_URL: 'invalid' },
])('development password login fails closed for %j', async overrides => {
  expect(await enabled(overrides)).toBe(false)
})
