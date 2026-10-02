import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
// @ts-expect-error Node tooling is JavaScript, outside the frontend TypeScript project.
import { checkProduction } from '../../scripts/check-production.mjs'
// @ts-expect-error Node tooling is JavaScript, outside the frontend TypeScript project.
import { localConfiguration, requireLoopback, seedDevelopment } from '../../scripts/local-development.mjs'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

test('production guard rejects a development login even in a nested lazy chunk', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'pos-build-guard-')); directories.push(dist)
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'assets/app.js'), 'console.log("Continuar con Google")')
  await expect(checkProduction(dist)).resolves.toBeUndefined()
  await writeFile(join(dist, 'assets/local-login.js'), 'console.log("Acceso de desarrollo")')
  await expect(checkProduction(dist)).rejects.toThrow('Development authentication found')
})

test('development setup refuses cloud before creating any fixture account', async () => {
  await expect(seedDevelopment({ API_URL: 'https://project.supabase.co' })).rejects.toThrow('non-loopback')
  expect(() => requireLoopback('http://localhost.attacker.test')).toThrow('non-loopback')
})

test('separate checkouts get isolated stack names and stable local ports', () => {
  const source = 'project_id = "pos-mexico-pwa"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[auth]\nsite_url = "http://127.0.0.1:5173"\n[edge_runtime]\ninspector_port = 8083\n'
  const first = localConfiguration(source, '/checkout/one', 5173)
  const same = localConfiguration(source, '/checkout/one', 5177)
  const second = localConfiguration(source, '/checkout/two', 5173)
  expect(first.projectId).not.toBe(second.projectId)
  expect(first.apiUrl).toBe(same.apiUrl)
  expect(first.apiUrl).not.toBe(second.apiUrl)
  expect(first.config).not.toContain('port = 54321')
  expect(first.config).not.toContain('inspector_port = 8083')
  expect(same.config).toContain('http://127.0.0.1:5177')
  expect(() => requireLoopback(first.apiUrl)).not.toThrow()
})
