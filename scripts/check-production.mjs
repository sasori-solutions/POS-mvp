import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Check the emitted artifact, including chunks: a bundled local login must fail the build.
export async function checkProduction(directory = 'dist') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await checkProduction(path)
    else if (/\.(js|html|json|map)$/.test(entry.name)) {
      const source = await readFile(path, 'utf8')
      if (/data-pos-development-login|Local-POS-only-2026!|@pos\.local\.test|Acceso de desarrollo|Entrar en desarrollo/.test(source)) {
        throw new Error(`Development authentication found in production artifact: ${path}`)
      }
    }
  }
}

if (import.meta.main) {
  await checkProduction()
  console.log('Production artifact contains no development login or fixture credentials.')
}
