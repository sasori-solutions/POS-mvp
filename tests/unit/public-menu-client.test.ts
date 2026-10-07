import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicMenu } from '../../src/lib/menu-client';
import type { PublicMenuDocument } from '../../src/lib/menu-contracts';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function configure() { vi.stubEnv('VITE_SUPABASE_URL', 'https://api.example.test'); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'synthetic-public-key'); }
function menu(): PublicMenuDocument { return { publicId: randomUUID(), businessName: 'Café sintético', name: 'Menú', locationLabel: '', timezone: 'America/Hermosillo', asOf: '2026-10-07T09:00:00Z', availability: 'open', schedules: [], products: [{ id: randomUUID(), name: 'Café', category: '', priceCents: 1001, available: true, variablePrice: false, description: '', dietary: '', allergens: '', image: null, variations: [], modifierGroups: [], comboComponents: [] }] }; }
describe('anonymous read-only menu client', () => {
  it('uses only the public apikey, omits cookies and refuses to send invalid menu IDs', async () => {
    configure(); const document = menu(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: document }), { status: 200 })); vi.stubGlobal('fetch', fetch);
    expect(await fetchPublicMenu(document.publicId)).toEqual(document);
    expect(fetch).toHaveBeenCalledWith(`https://api.example.test/functions/v1/public-menu?menuId=${document.publicId}`, expect.objectContaining({ method: 'GET', credentials: 'omit', cache: 'no-store', headers: { apikey: 'synthetic-public-key' } }));
    expect(JSON.stringify(fetch.mock.calls[0])).not.toMatch(/Authorization|operatorToken|deviceToken|pin|businessId/);
    await expect(fetchPublicMenu('invalid')).rejects.toThrow(/enlace/); expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects malformed nested metadata, unsafe image schemes and another menu identity before rendering', async () => {
    configure(); const document = menu(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const invalid of [{ ...document, publicId: randomUUID() }, { ...document, products: [{ ...document.products[0], image: 'javascript:alert(1)' }] }, { ...document, products: [{ ...document.products[0], comboComponents: [null] }] }, { ...document, products: [{ ...document.products[0], modifierGroups: [{ id: randomUUID(), name: 'Extras', min: 0, max: 1, options: [null] }] }] }]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: invalid }), { status: 200 }));
      await expect(fetchPublicMenu(document.publicId)).rejects.toThrow(/respuesta/);
    }
  });
});
