// Reviewable standalone Edge source; never deploys or reads credentials.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function buildAccountSource() {
  const paths = ['src/lib/operations-contracts.ts', 'src/lib/pos-contracts.ts', 'src/lib/contracts.ts',
    'supabase/functions/account/product-validation.ts', 'supabase/functions/account/operations-validation.ts', 'supabase/functions/account/pos-validation.ts', 'supabase/functions/account/validation.ts',
    'supabase/functions/account/device-proof.ts', 'supabase/functions/account/authentication.ts',
    'supabase/functions/account/email.ts', 'supabase/functions/account/index.ts']
  const source = paths.map(path => ({ path, text: readFileSync(path, 'utf8') }))
  const npmImport = "import { createClient } from 'npm:@supabase/supabase-js@2.117.2'"
  const bodies = source.map(({ path, text }) => {
    let body = text.replace(/^import[^\n]*from ['"](?:\.[^'"]+|npm:@supabase\/supabase-js@2\.117\.2)['"]\r?\n/gm, '')
    if (/^import\b/m.test(body)) throw new Error(`Unresolved import: ${path}`)
    // Retain module-private validator names instead of colliding with account's helpers.
    if (path.endsWith('/product-validation.ts')) body = `namespace ProductValidation {\n${body}\n}\nconst parseProductDetails = ProductValidation.parseProductDetails;\nconst parseSelection = ProductValidation.parseSelection;\n`
    if (path.endsWith('/pos-validation.ts')) body = `namespace PosValidation {\n${body}\n}\nconst parsePosCommand = PosValidation.parsePosCommand;\n`
    if (path.endsWith('/operations-validation.ts')) body = `namespace OperationsValidation {\n${body}\n}\nconst parseOperationsCommand = OperationsValidation.parseOperationsCommand;\n`
    return `// Source: ${path}; SHA-256 ${hash(text)}\n${body.trimEnd()}\n`
  })
  return { source, edge: npmImport + '\n\n' + bodies.join('\n') }
}

function hash(value) { return createHash('sha256').update(value).digest('hex') }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  if (!path) throw new Error('Provide a destination for standalone account source')
  const { edge } = buildAccountSource()
  writeFileSync(path, edge)
  console.log(JSON.stringify({ path, bytes: Buffer.byteLength(edge), sha256: hash(edge) }))
}
