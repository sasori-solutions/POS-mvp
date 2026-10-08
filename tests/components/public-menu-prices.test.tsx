// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import PublicMenu from '../../src/components/PublicMenu';
import { fetchPublicMenu } from '../../src/lib/menu-client';
import type { PublicMenuDocument } from '../../src/lib/menu-contracts';

vi.mock('../../src/lib/menu-client', () => ({ fetchPublicMenu: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const menu: PublicMenuDocument = { publicId: '00000000-0000-4000-a000-000000000001', businessName: 'Café sintético', name: 'Tamaños', locationLabel: '', timezone: 'America/Mexico_City', asOf: '2026-10-07T16:00:00Z', availability: 'open', schedules: [], products: [{ id: '00000000-0000-4000-a000-000000000002', name: 'Latte sintético', category: '', priceCents: 3000, available: true, variablePrice: false, description: '', dietary: '', allergens: '', image: null, modifierGroups: [], comboComponents: [], variations: [{ id: 'chico', name: 'Chico', priceCents: 4000, soldOut: false }, { id: 'grande', name: 'Grande', priceCents: 5500, soldOut: false }] }] };

test.each([
  { soldOut: [false, false], available: true, label: 'Desde $40.00' },
  { soldOut: [true, false], available: true, label: 'Desde $55.00' },
  { soldOut: [true, true], available: false, label: 'Desde $40.00' },
])('the public price uses actual size prices and availability: $label', async ({ soldOut, available, label }) => {
  vi.mocked(fetchPublicMenu).mockResolvedValue({ ...menu, products: [{ ...menu.products[0], available, variations: menu.products[0].variations.map((size, index) => ({ ...size, soldOut: soldOut[index] })) }] });
  render(<PublicMenu menuId={menu.publicId} />);
  expect(await screen.findByText(label)).toBeTruthy();
  expect(screen.queryByText('$30.00')).toBeNull();
  if (!available) expect(screen.getByText('Agotado')).toBeTruthy();
});

test('fixed and open prices keep their existing meaning when there are no sizes', async () => {
  vi.mocked(fetchPublicMenu).mockResolvedValue({ ...menu, products: [{ ...menu.products[0], variations: [] }, { ...menu.products[0], id: '00000000-0000-4000-a000-000000000003', name: 'Importe variable', variations: [], variablePrice: true }] });
  render(<PublicMenu menuId={menu.publicId} />);
  expect(await screen.findByText('$30.00')).toBeTruthy();
  expect(screen.getByText('Consultar precio')).toBeTruthy();
});
