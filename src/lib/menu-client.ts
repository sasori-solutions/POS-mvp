import type { PublicMenuDocument, PublicMenuProduct } from './menu-contracts';

export class PublicMenuError extends Error { constructor(readonly unavailable: boolean, message: string) { super(message); this.name = 'PublicMenuError'; } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const price = (value: unknown, negative = false): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= (negative ? -99999999 : 0) && value <= 99999999;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const identified = (value: unknown): value is Record<string, unknown> => record(value) && typeof value.id === 'string' && uuid.test(value.id) && typeof value.name === 'string';
function safeProduct(product: PublicMenuProduct): boolean {
  return Boolean(product) && typeof product.id === 'string' && uuid.test(product.id) && typeof product.name === 'string' && typeof product.category === 'string'
    && Number.isSafeInteger(product.priceCents) && product.priceCents >= 0 && typeof product.available === 'boolean' && typeof product.variablePrice === 'boolean'
    && ['description', 'dietary', 'allergens'].every(key => typeof product[key as 'description'] === 'string')
    && (product.image === null || typeof product.image === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(product.image) && product.image.length <= 245800)
    && Array.isArray(product.variations) && product.variations.length <= 20 && product.variations.every(variation => identified(variation) && price(variation.priceCents) && typeof variation.soldOut === 'boolean')
    && Array.isArray(product.modifierGroups) && product.modifierGroups.length <= 6 && product.modifierGroups.every(group => identified(group) && Number.isInteger(group.min) && group.min >= 0 && Number.isInteger(group.max) && group.max >= Math.max(group.min, 1) && group.max <= 24
      && (group.parentOptionId === undefined || typeof group.parentOptionId === 'string' && uuid.test(group.parentOptionId)) && Array.isArray(group.options) && group.options.length <= 12
      && group.options.every(option => identified(option) && price(option.priceCents, true) && typeof option.soldOut === 'boolean' && Number.isInteger(option.maxQuantity) && option.maxQuantity >= 1 && option.maxQuantity <= 24))
    && Array.isArray(product.comboComponents) && product.comboComponents.length <= 8 && product.comboComponents.every(component => record(component) && typeof component.name === 'string' && typeof component.selectionLabel === 'string' && Number.isInteger(component.quantity) && component.quantity >= 1 && component.quantity <= 24);
}
/** No operator token, Auth session or cookies are sent to the public endpoint. */
export async function fetchPublicMenu(menuId: string, signal?: AbortSignal): Promise<PublicMenuDocument> {
  if (!uuid.test(menuId)) throw new PublicMenuError(true, 'Este enlace de menú no es válido.');
  const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '', key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  if (!url || !key) throw new PublicMenuError(false, 'El menú aún no está configurado.');
  let response: Response;
  try { response = await fetch(`${url}/functions/v1/public-menu?menuId=${encodeURIComponent(menuId)}`, { method: 'GET', headers: { apikey: key }, credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }); }
  catch { throw new PublicMenuError(false, 'No pudimos conectar. Comprueba tu conexión y vuelve a consultar.'); }
  if (!response.ok) throw new PublicMenuError(response.status === 404, response.status === 404 ? 'Este menú ya no está disponible.' : 'No pudimos consultar el menú. Intenta de nuevo.');
  let envelope: { data?: PublicMenuDocument };
  try { envelope = await response.json(); } catch { throw new PublicMenuError(false, 'La respuesta del menú no es válida.'); }
  const menu = envelope?.data;
  if (!menu || menu.publicId?.toLowerCase() !== menuId.toLowerCase() || !['businessName', 'name', 'locationLabel', 'timezone', 'asOf'].every(key => typeof menu[key as 'name'] === 'string')
    || !['open', 'outside_hours'].includes(menu.availability) || !Array.isArray(menu.schedules) || !Array.isArray(menu.products) || menu.products.length > 100 || !menu.products.every(safeProduct)) throw new PublicMenuError(false, 'La respuesta del menú no es válida.');
  return menu;
}
