// Deterministic standalone sources for dashboard deployment. Never reads credentials.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const hash = value => createHash('sha256').update(value).digest('hex')
const namespaces = { crypto: 'PointCrypto', provider: 'PointProvider', service: 'PointService', http: 'PointHttp', webhook: 'PointWebhook' }
const aliases = {
  service: "const { challenge, digest, randomSecret, TokenVault } = PointCrypto; type TokenVault = PointCrypto.TokenVault; const { cents, identifier, MercadoPagoPoint, officialVirtualOrder, ProviderError, record, verifyOrder } = PointProvider; type Environment = PointProvider.Environment; type ExpectedOrder = PointProvider.ExpectedOrder; type PointAdapter = PointProvider.PointAdapter; type TokenSet = PointProvider.TokenSet;",
  webhook: 'const { digest } = PointCrypto;',
}
export function buildPointModules(modules = ['crypto', 'provider', 'service']) {
  return modules.map(name => {
    const path = `supabase/functions/point/${name}.ts`, original = readFileSync(path, 'utf8')
    const body = original.replace(/^import[^\n]*from ['"]\.[^'"]+['"]\r?\n/gm, '')
    if (/^import\b/m.test(body)) throw new Error(`Unresolved import in ${path}`)
    return `// Source: ${path}; SHA-256 ${hash(original)}\nnamespace ${namespaces[name]} {\n${aliases[name] ?? ''}\n${body}\n}\n`
  }).join('\n')
}
export function buildPointSource(endpoint) {
  const path = endpoint === 'point' ? 'supabase/functions/point/index.ts' : `supabase/functions/${endpoint}/index.ts`
  const original = readFileSync(path, 'utf8')
  let body = original.replace(/^import[^\n]*from ['"][^'"]+['"]\r?\n/gm, '')
  body = body.replace(/if \(import\.meta\.main\) /g, '')
  const modules = endpoint === 'point' ? ['http'] : endpoint === 'point-webhook' ? ['crypto', 'provider', 'service', 'http', 'webhook'] : ['crypto', 'provider', 'service', 'http']
  const imports = endpoint === 'point' ? '' : "import { createClient } from 'npm:@supabase/supabase-js@2.117.2'\n"
  const alias = endpoint === 'point' ? 'const { boundedBody, HttpError, json } = PointHttp;' : endpoint === 'point-webhook'
    ? 'const { boundedBody, HttpError, json, serviceKey } = PointHttp; const { serviceRpc } = PointService; const { SignatureError, verifySignature } = PointWebhook;'
    : 'const { json, serviceKey, workerAuthorized } = PointHttp; const { runWorker } = PointService;'
  return `${imports}${buildPointModules(modules)}\n${alias}\n// Source: ${path}; SHA-256 ${hash(original)}\n${body}`
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [endpoint, destination] = process.argv.slice(2)
  if (!['point', 'point-webhook', 'point-worker'].includes(endpoint) || !destination) throw new Error('Usage: node scripts/build-point-source.mjs point-worker destination.ts')
  const edge = buildPointSource(endpoint)
  writeFileSync(destination, edge)
  console.log(JSON.stringify({ endpoint, destination, bytes: Buffer.byteLength(edge), sha256: hash(edge) }))
}
