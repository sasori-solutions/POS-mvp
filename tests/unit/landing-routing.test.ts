import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import worker from '../../public/_worker.js'

describe('marketing domain routing', () => {
  it.each(['GET', 'HEAD'])('serves static landing HTML at the marketing root for %s', async (method) => {
    const fetch = vi.fn(async (_request: Request) => new Response('landing', { headers: { 'content-type': 'text/html' } }))
    const response = await worker.fetch(new Request('https://pos.larioscow.dev/?campaign=cafe', { method }), { ASSETS: { fetch } })
    expect(await response.text()).toBe('landing')
    const request = fetch.mock.calls[0][0] as Request
    expect(request.url).toBe('https://pos.larioscow.dev/landing/?campaign=cafe')
    expect(request.method).toBe(method)
  })
  it.each([
    'https://pos-mexico-mvp.pages.dev/',
    'https://preview.pos-mexico-mvp.pages.dev/',
    'https://pos-mexico-mvp.pages.dev/auth/callback?code=example',
    'https://pos.larioscow.dev/landing/',
    'https://pos.larioscow.dev/assets/app.js',
    'https://pos.larioscow.dev.evil.example/',
  ])('preserves existing asset and application requests: %s', async (url) => {
    const request = new Request(url)
    const fetch = vi.fn(async () => new Response('original'))
    await worker.fetch(request, { ASSETS: { fetch } })
    expect(fetch).toHaveBeenCalledWith(request)
  })
  it('does not turn a mutation request into a successful landing response', async () => {
    const request = new Request('https://pos.larioscow.dev/', { method: 'POST', body: 'example' })
    const fetch = vi.fn(async () => new Response(null, { status: 405 }))
    const response = await worker.fetch(request, { ASSETS: { fetch } })
    expect(response.status).toBe(405)
    expect(fetch).toHaveBeenCalledWith(request)
  })
})

describe('application worker registration', () => {
  const script = readFileSync(new URL('../../public/register-app-worker.js', import.meta.url), 'utf8')

  it.each([
    ['pos.larioscow.dev', false],
    ['pos-mexico-mvp.pages.dev', true],
    ['preview.pos-mexico-mvp.pages.dev', true],
  ])('keeps the marketing root on the network at %s', (hostname, shouldRegister) => {
    const register = vi.fn()
    const listeners: Array<() => void> = []
    runInNewContext(script, {
      location: { hostname },
      navigator: { serviceWorker: { register } },
      window: { addEventListener: (_event: string, callback: () => void) => listeners.push(callback) },
    })
    listeners.forEach((callback) => callback())
    expect(register).toHaveBeenCalledTimes(shouldRegister ? 1 : 0)
    if (shouldRegister) expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('supports browsers without service workers', () => {
    const addEventListener = vi.fn()
    runInNewContext(script, { location: { hostname: 'pos-mexico-mvp.pages.dev' }, navigator: {}, window: { addEventListener } })
    expect(addEventListener).not.toHaveBeenCalled()
  })
})
