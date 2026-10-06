// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import SaleScreen from '../../src/components/SaleScreen';
import { posRequest, type PosAccess } from '../../src/lib/pos';
import { pendingSaleKey, type PendingSale } from '../../src/lib/pending-sale';
import type { CatalogState } from '../../src/components/useCatalog';
import type { CartLine, Product, Sale } from '../../src/lib/pos-contracts';

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }));
const access: PosAccess = { businessId: '00000000-0000-4000-8000-000000000001', operatorToken: 'synthetic-memory-only' };
const employeeId = '00000000-0000-4000-8000-000000000002';
const product: Product = { id: '00000000-0000-4000-8000-000000000003', name: 'Café', category: '', active: true, version: 1, priceCents: 1001 };
let catalog: CatalogState;
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  localStorage.clear();
  vi.mocked(posRequest).mockReset();
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_name: string, callback: () => unknown) => callback()) } });
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  catalog = { products: [product], paymentMethods: ['cash'], loaded: true, loading: false, error: '', refresh: vi.fn().mockResolvedValue(undefined), upsert: vi.fn(), remove: vi.fn() };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose; });
function properties() { return { access, employeeId, catalog, onProducts: vi.fn(), onHistory: vi.fn(), defaultVatTreatment: 'unconfigured' as const }; }
function currentSale() { return within(screen.getByRole('complementary', { name: 'Venta actual' })); }
async function addAmount(value: string, label: string, concept?: string) {
  fireEvent.click(within(screen.getByRole('group', { name: 'Añadir a la venta' })).getByRole('button', { name: 'Importe para la venta' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Importe' }), { target: { value } });
  if (concept) {
    fireEvent.click(screen.getByRole('button', { name: 'Añadir concepto' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Concepto (opcional)' }), { target: { value: concept } });
  }
  fireEvent.click(screen.getByRole('button', { name: `Añadir ${label}` }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe(''));
}

test('sale entry modes have distinct accessible names and show the selected catalog or calculator', () => {
  render(<SaleScreen {...properties()} />);
  const modes = within(screen.getByRole('group', { name: 'Añadir a la venta' }));
  const products = modes.getByRole('button', { name: 'Productos para la venta', exact: true });
  const amount = modes.getByRole('button', { name: 'Importe para la venta', exact: true });
  expect(screen.queryByRole('button', { name: 'Productos', exact: true })).toBeNull();
  expect(products.getAttribute('aria-pressed')).toBe('true');
  expect(amount.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(amount);
  expect(products.getAttribute('aria-pressed')).toBe('false');
  expect(amount.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('textbox', { name: 'Importe', exact: true })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Agregar Café, $10.01' })).toBeNull();
  fireEvent.click(products);
  expect(products.getAttribute('aria-pressed')).toBe('true');
  expect(amount.getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('textbox', { name: 'Importe', exact: true })).toBeNull();
  expect(screen.getByRole('button', { name: 'Agregar Café, $10.01' })).toBeTruthy();
});

test('free amounts mix with products, keep separate quantity controls and survive catalog refresh exactly', async () => {
  const onAccount = vi.fn().mockResolvedValue(undefined);
  const props = properties();
  const view = render(<SaleScreen {...props} onAccount={onAccount} />);
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $10.01' }));
  await addAmount('0.01', '$0.01', 'Servicio');
  fireEvent.click(currentSale().getByRole('button', { name: 'Aumentar Servicio' }));
  expect(currentSale().getByText('2 × Servicio')).toBeTruthy();
  view.rerender(<SaleScreen {...props} onAccount={onAccount} catalog={{ ...catalog, products: [{ ...product, priceCents: 2002, version: 2 }] }} />);
  await waitFor(() => expect(currentSale().getAllByText('$20.04')).toHaveLength(2));
  expect(currentSale().getByText('2 × Servicio')).toBeTruthy();
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }));
  await waitFor(() => expect(onAccount).toHaveBeenCalledOnce());
  const lines = onAccount.mock.calls[0][0] as CartLine[];
  expect(lines).toContainEqual(expect.objectContaining({ kind: 'amount', name: 'Servicio', quantity: 2, unitPriceCents: 1 }));
  expect(lines.find(line => line.kind === 'amount')).not.toHaveProperty('product');
  expect(lines).toContainEqual(expect.objectContaining({ product: expect.objectContaining({ version: 2, priceCents: 2002 }) }));
});

test('each added amount is independent and removing one cannot remove an identical charge', async () => {
  render(<SaleScreen {...properties()} />);
  await addAmount('25', '$25.00');
  await addAmount('25', '$25.00');
  expect(currentSale().getAllByText('1 × Importe libre')).toHaveLength(2);
  fireEvent.click(currentSale().getAllByRole('button', { name: 'Quitar Importe libre' })[0]);
  expect(currentSale().getAllByText('1 × Importe libre')).toHaveLength(1);
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy();
  fireEvent.click(currentSale().getByRole('button', { name: 'Quitar Importe libre' }));
  expect(currentSale().getByText('Cuenta vacía')).toBeTruthy();
});

test('an amount-only sale uses saved payment methods despite an empty or unavailable catalog', async () => {
  catalog = { ...catalog, products: [], loaded: false, error: 'Catálogo sin conexión', paymentMethods: [] };
  const onAccount = vi.fn().mockResolvedValue(undefined);
  render(<SaleScreen {...properties()} configuredMethods={['cash']} onAccount={onAccount} />);
  await addAmount('76.68', '$76.68');
  expect((currentSale().getByRole('button', { name: 'Cobrar' }) as HTMLButtonElement).disabled).toBe(false);
  expect(currentSale().getByText('IVA sin definir')).toBeTruthy();
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }));
  await waitFor(() => expect(onAccount).toHaveBeenCalledWith([expect.objectContaining({ kind: 'amount', unitPriceCents: 7668, quantity: 1 })]));
});

test('mixed sales still require a confirmed catalog and unauthorized sessions have no amount entry', async () => {
  const props = properties();
  const view = render(<SaleScreen {...props} configuredMethods={['cash']} />);
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $10.01' }));
  await addAmount('2', '$2.00');
  view.rerender(<SaleScreen {...props} catalog={{ ...catalog, error: 'Catálogo sin confirmar' }} configuredMethods={['cash']} />);
  expect((currentSale().getByRole('button', { name: 'Cobrar' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<SaleScreen {...props} canAmount={false} />);
  expect(screen.queryByRole('button', { name: 'Importe para la venta' })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Importe' })).toBeNull();
  expect(currentSale().getByText('1 × Importe libre')).toBeTruthy();
});

test('lost amount collection retains its exact payload and UUID across reload and retries without a catalog product', async () => {
  vi.mocked(posRequest).mockRejectedValueOnce(new Error('Respuesta perdida'));
  const props = properties();
  const first = render(<SaleScreen {...props} />);
  await addAmount('760.68', '$760.68', 'Servicio especial');
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Registrar pago' }));
  await waitFor(() => expect(posRequest).toHaveBeenCalledOnce());
  const command = vi.mocked(posRequest).mock.calls[0][1] as PendingSale;
  expect(command).toMatchObject({ command: 'complete_sale', totalCents: 76068, items: [{ kind: 'amount', name: 'Servicio especial', unitPriceCents: 76068, quantity: 1 }] });
  const key = pendingSaleKey(access.businessId, employeeId);
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(command);
  first.unmount();
  const sale: Sale = { id: '00000000-0000-4000-8000-000000000005', createdAt: '2026-10-03T12:00:00Z', timezone: 'America/Mexico_City', totalCents: 76068, paymentMethod: 'cash', itemCount: 1, operatorName: 'Persona sintética', items: [{ kind: 'amount', productId: null, name: 'Servicio especial', category: '', quantity: 1, unitPriceCents: 76068, totalCents: 76068, taxTreatment: 'unconfigured', taxBps: 0, taxCents: 0 }] };
  vi.mocked(posRequest).mockResolvedValueOnce(sale);
  render(<SaleScreen {...props} catalog={{ ...catalog, products: [], loaded: false }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reintentar registro' }));
  await waitFor(() => expect(posRequest).toHaveBeenCalledTimes(2));
  expect(vi.mocked(posRequest).mock.calls[1]).toEqual([access, command]);
  expect(await screen.findByRole('heading', { name: 'Venta registrada' })).toBeTruthy();
  expect(localStorage.getItem(key)).toBeNull();
  expect(screen.getByText('Servicio especial')).toBeTruthy();
});

test('a saved operational request locks amount input and amount lines in the current draft', async () => {
  const props = properties();
  const view = render(<SaleScreen {...props} />);
  await addAmount('15', '$15.00');
  view.rerender(<SaleScreen {...props} accountPending />);
  expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).disabled).toBe(true);
  expect((currentSale().getByRole('button', { name: 'Aumentar Importe libre' }) as HTMLButtonElement).disabled).toBe(true);
  expect((currentSale().getByRole('button', { name: 'Quitar Importe libre' }) as HTMLButtonElement).disabled).toBe(true);
  expect(currentSale().getByText('1 × Importe libre')).toBeTruthy();
});
