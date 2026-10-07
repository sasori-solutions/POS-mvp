import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { handlePublicMenu } from './handler.ts'

const origins = new Set((Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(value => value.trim()).filter(Boolean))
for (const origin of origins) {
  const url = new URL(origin)
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid menu origin configuration')
}
if (!origins.size) throw new Error('Missing menu origin configuration')
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
Deno.serve(request => handlePublicMenu(request, { origins, read: async menuId => {
  const result = await admin.rpc('public_menu_read', { p_menu_id: menuId })
  if (result.error) throw new Error('Menu read failed')
  return result.data ?? {}
} }))
