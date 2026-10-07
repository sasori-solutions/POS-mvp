// Reviewable standalone Edge source; never deploys or reads credentials.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPointModules } from './build-point-source.mjs'

export function buildAccountSource() {
  const paths = ['src/lib/promotion-contracts.ts', 'src/lib/menu-contracts.ts', 'src/lib/service-contracts.ts', 'src/lib/operations-contracts.ts', 'src/lib/pos-contracts.ts', 'src/lib/point-contracts.ts', 'src/lib/contracts.ts',
    'supabase/functions/account/promotion-validation.ts', 'supabase/functions/account/menu-validation.ts', 'supabase/functions/account/service-validation.ts', 'supabase/functions/account/product-validation.ts', 'supabase/functions/account/operations-validation.ts', 'supabase/functions/account/pos-validation.ts', 'supabase/functions/account/point-validation.ts', 'supabase/functions/account/validation.ts',
    'supabase/functions/account/device-proof.ts', 'supabase/functions/account/authentication.ts',
    'supabase/functions/account/email.ts', 'supabase/functions/account/index.ts']
  const source = paths.map(path => ({ path, text: readFileSync(path, 'utf8') }))
  const npmImport = "import { createClient } from 'npm:@supabase/supabase-js@2.117.2'"
  const bodies = source.map(({ path, text }) => {
    let body = text.replace(/^import[^\n]*from ['"](?:\.[^'"]+|npm:@supabase\/supabase-js@2\.117\.2)['"]\r?\n/gm, '')
    if (/^import\b/m.test(body)) throw new Error(`Unresolved import: ${path}`)
    // Retain module-private validator names instead of colliding with account's helpers.
    if (path.endsWith('/service-validation.ts')) body = `namespace ServiceValidation {\n${body}\n}\nconst parseServiceCommand = ServiceValidation.parseServiceCommand;\n`
    if (path.endsWith('/menu-validation.ts')) body = `namespace MenuValidation {\n${body}\n}\nconst parseMenuCommand = MenuValidation.parseMenuCommand;\n`
    if (path.endsWith('/promotion-validation.ts')) body = `namespace PromotionValidation {\n${body}\n}\nconst parsePromotionCommand = PromotionValidation.parsePromotionCommand;\nconst parsePromotionScope = PromotionValidation.parsePromotionScope;\n`
    if (path.endsWith('/product-validation.ts')) body = `namespace ProductValidation {\n${body}\n}\nconst parseProductDetails = ProductValidation.parseProductDetails;\nconst parseSelection = ProductValidation.parseSelection;\nconst parseModifierSet = ProductValidation.parseModifierSet;\n`
    if (path.endsWith('/pos-validation.ts')) body = `namespace PosValidation {\n${body}\n}\nconst parsePosCommand = PosValidation.parsePosCommand;\n`
    if (path.endsWith('/operations-validation.ts')) body = `namespace OperationsValidation {\n${body}\n}\nconst parseOperationsCommand = OperationsValidation.parseOperationsCommand;\n`
    if (path.endsWith('/point-validation.ts')) body = `namespace PointValidation {\n${body}\n}\nconst parsePointCommand = PointValidation.parsePointCommand;\n`
    return `// Source: ${path}; SHA-256 ${hash(text)}\n${body.trimEnd()}\n`
  })
  return { source, edge: npmImport + '\n\n' + buildPointModules() + '\nconst processPointResult = PointService.processPointResult;\nconst backgroundPointWork = PointBackground.backgroundPointWork;\n' + bodies.join('\n') }
}

function hash(value) { return createHash('sha256').update(value).digest('hex') }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  if (!path) throw new Error('Provide a destination for standalone account source')
  const { edge } = buildAccountSource()
  writeFileSync(path, edge)
  console.log(JSON.stringify({ path, bytes: Buffer.byteLength(edge), sha256: hash(edge) }))
}
