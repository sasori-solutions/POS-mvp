import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anonymous GETs only: no session, API request, or credentials.
const usage = 'Usage: npm run check:live -- https://<public-hostname>'
let origin
try {
  if (process.argv.length !== 3) throw new Error()
  const url = new URL(process.argv[2])
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
  origin = url.origin
} catch {
  console.error(usage)
  process.exit(2)
}

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const contentTypes = {
  '.html': ['text/html'],
  '.js': ['application/javascript', 'text/javascript'],
  '.css': ['text/css'],
  '.webmanifest': ['application/manifest+json', 'application/json'],
  '.png': ['image/png'],
  '.svg': ['image/svg+xml'],
  '.woff': ['font/woff', 'application/font-woff'],
  '.woff2': ['font/woff2', 'application/font-woff2'],
}

async function listFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listFiles(join(directory, entry.name), relative))
    else if (entry.isFile()) files.push(relative)
  }
  return files.sort()
}

async function check({ path, file }) {
  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'User-Agent': 'POS-Mexico-Anonymous-Release-Check' },
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status !== 200 || response.headers.has('location')) {
      await response.body?.cancel()
      throw new Error(`HTTP ${response.status}; expected 200 with no redirect`)
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (!contentTypes[extname(file)]?.includes(contentType)) {
      await response.body?.cancel()
      throw new Error(`unexpected content type ${contentType ?? '(missing)'}`)
    }
    const actual = Buffer.from(await response.arrayBuffer())
    const expected = await readFile(join(dist, file))
    if (sha256(actual) !== sha256(expected)) throw new Error('content differs from the local production build')
    if (file.startsWith('assets/') && file.endsWith('.js')) {
      const bundle = actual.toString('utf8')
      if (!bundle.includes('https://sdisalomdxgejyhpxtri.supabase.co')) throw new Error('expected cloud backend URL is missing')
      if (bundle.includes('http://127.0.0.1:54321') || bundle.includes('http://localhost:54321')) throw new Error('local backend URL found in production bundle')
    }
    console.log(`PASS ${path} · 200 · ${contentType} · matches dist`)
    return true
  } catch (error) {
    console.error(`FAIL ${path} · ${error.message}`)
    return false
  }
}

try {
  const files = await listFiles(dist)
  if (!files.includes('index.html') || !files.includes('manifest.webmanifest') || !files.includes('sw.js') || !files.some((file) => file.startsWith('assets/') && file.endsWith('.js'))) {
    throw new Error('Production assets missing; run npm run build first.')
  }
  const routes = ['/', '/login', '/business/new', '/unlock', '/auth/callback?error=access_denied']
  const checks = routes.map((path) => ({ path, file: 'index.html' }))
  for (const file of files) {
    if (file === 'index.html' || file === '_redirects' || file === '_headers') continue
    if (!contentTypes[extname(file)]) throw new Error(`Unrecognized build asset: ${file}`)
    checks.push({ path: `/${file.split('/').map(encodeURIComponent).join('/')}`, file })
  }
  console.log(`Checking ${origin} against local dist with anonymous GETs.`)
  const results = []
  // Bounded parallel requests; check every path even when one fails.
  for (let offset = 0; offset < checks.length; offset += 4) {
    results.push(...await Promise.all(checks.slice(offset, offset + 4).map(check)))
  }
  const passed = results.filter(Boolean).length
  console.log(`${passed}/${checks.length} checks passed.`)
  process.exitCode = passed === checks.length ? 0 : 1
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Production build missing; run npm run build first.' : error.message)
  process.exitCode = 2
}
