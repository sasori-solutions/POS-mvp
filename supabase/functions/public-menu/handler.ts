export type PublicMenuDependencies = { origins: Set<string>; read: (menuId: string) => Promise<{ data?: unknown; error?: unknown }> }
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const maxBytes = 8192
class InvalidRequest extends Error { constructor(readonly large = false) { super() } }
async function input(request: Request): Promise<string> {
  let value: unknown
  const url = new URL(request.url)
  if (request.method === 'GET') {
    const fields = [...url.searchParams.keys()]
    if (new TextEncoder().encode(url.search).length > maxBytes) throw new InvalidRequest(true)
    if (fields.length !== 1 || fields[0] !== 'menuId' || request.body) throw new InvalidRequest()
    value = { menuId: url.searchParams.get('menuId') }
  } else {
    if (url.search || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) throw new InvalidRequest()
    if (Number(request.headers.get('content-length') ?? 0) > maxBytes) throw new InvalidRequest(true)
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > maxBytes) throw new InvalidRequest(true); chunks.push(chunk.value) }
    } finally { await reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new InvalidRequest() }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'menuId')) throw new InvalidRequest()
  const menuId = (value as { menuId: unknown }).menuId
  if (typeof menuId !== 'string' || !idPattern.test(menuId)) throw new InvalidRequest()
  return menuId
}
export async function handlePublicMenu(request: Request, dependencies: PublicMenuDependencies): Promise<Response> {
  const origin = request.headers.get('origin')
  const permitted = origin !== null && dependencies.origins.has(origin)
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' })
  if (permitted) {
    headers.set('Access-Control-Allow-Origin', origin); headers.set('Access-Control-Allow-Headers', 'apikey,content-type,x-client-info')
    headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); headers.set('Access-Control-Max-Age', '600')
  }
  const failure = (code: string, status: number) => new Response(JSON.stringify({ error: { code, message: code === 'MENU_UNAVAILABLE' ? 'Este menú no está disponible.' : 'No pudimos consultar este menú.' } }), { status, headers })
  if (origin !== null && !permitted) return failure('ORIGIN_FORBIDDEN', 403)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (!['GET', 'POST'].includes(request.method)) { headers.set('Allow', 'GET,POST,OPTIONS'); return failure('METHOD_NOT_ALLOWED', 405) }
  try {
    const menuId = await input(request)
    const result = await dependencies.read(menuId)
    if (result.error) return failure('MENU_UNAVAILABLE', 404)
    if (!result.data) return failure('SERVER_ERROR', 503)
    return new Response(JSON.stringify({ data: result.data }), { status: 200, headers })
  } catch (caught) {
    return caught instanceof InvalidRequest ? failure(caught.large ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR', caught.large ? 413 : 400) : failure('SERVER_ERROR', 503)
  }
}
