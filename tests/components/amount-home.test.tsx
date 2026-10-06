// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import HomeScreen from '../../src/components/HomeScreen';
import { posRequest } from '../../src/lib/pos';
import { useCatalog, type CatalogState } from '../../src/components/useCatalog';
import { useOperationalMutation, useOperations, type OperationalMutation } from '../../src/features/operations/useOperations';
import type { BusinessContext } from '../../src/lib/contracts';
import type { CheckoutAttempt, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts';

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }));
vi.mock('../../src/components/useCatalog', async original => ({ ...await original<object>(), useCatalog: vi.fn() }));
vi.mock('../../src/features/operations/useOperations', async original => ({ ...await original<object>(), useOperations: vi.fn(), useOperationalMutation: vi.fn() }));
vi.mock('../../src/components/usePoint', () => ({ usePoint: () => ({ settings: null, refresh: vi.fn().mockResolvedValue(undefined), setSettings: vi.fn() }) }));
const business: BusinessContext = { id: '00000000-0000-4000-8000-000000000001', name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'cashier', employee: { id: '00000000-0000-4000-8000-000000000002', name: 'Caja sintética', role: 'cashier' }, permissions: ['sales.create', 'catalog.read'], createdAt: '2026-10-03T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'], defaultVatTreatment: 'unconfigured' } };
let catalog: CatalogState, snapshot: OperationsSnapshot, mutation: OperationalMutation;
const refresh = vi.fn().mockResolvedValue(undefined);
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  catalog = { products: [], paymentMethods: [], loaded: false, loading: false, error: 'Catálogo sin confirmar', refresh, upsert: vi.fn(), remove: vi.fn() };
  snapshot = { enabled: true, shift: { id: 'shift', status: 'open' } as OperationsSnapshot['shift'], orders: [], attempts: [], tables: [] };
  mutation = { execute: vi.fn(), pending: null, error: '', notice: '', busy: false, lastResult: null, clearNotice: vi.fn() };
  vi.mocked(useCatalog).mockImplementation(() => catalog);
  vi.mocked(useOperations).mockImplementation(() => ({ snapshot, loading: false, error: '', refresh }));
  vi.mocked(useOperationalMutation).mockImplementation(() => mutation);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose; });

test('a cashier can collect an amount-only operational sale from saved methods before the catalog loads', async () => {
  let saved!: OperationalOrder;
  let prepared!: CheckoutAttempt;
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'save_order') {
      saved = { id: command.orderId, name: command.name, orderKind: command.orderKind, tableId: null, revision: 1, status: 'open', phase: 'service', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: 'Caja sintética', items: command.items.map(line => ({ ...line, kind: 'amount', productId: null, version: 1, selection: null, name: 'Importe libre', kitchenName: '', category: '', selectionLabel: '', grossCents: 1001, discountCents: 0, totalCents: 1001, taxCents: 0, taxBps: 0, taxTreatment: 'unconfigured', sentQuantity: 0, paidQuantity: 0 })), discount: null, grossCents: 1001, discountCents: 0, totalCents: 1001, taxCents: 0, balanceCents: 1001, paidCents: 0, cancelledCents: 0, waivedCents: 0 };
      return saved;
    }
    if (command.command === 'prepare_checkout') {
      prepared = { id: 'cold-catalog-checkout', kind: 'payment', revision: 1, status: 'prepared', orderId: saved.id, shiftId: 'shift', paymentMethod: command.paymentMethod, items: command.items, totalCents: 1001, taxCents: 0, discountCents: 0, createdAt: business.createdAt } as CheckoutAttempt;
      vi.mocked(posRequest).mockResolvedValue(prepared);
      return prepared;
    }
    if (command.command === 'record_checkout') {
      const completed = { ...prepared, status: 'completed', revision: 2 } as CheckoutAttempt;
      vi.mocked(posRequest).mockResolvedValue(completed);
      return { order: { ...saved, status: 'paid', phase: 'checkout', revision: 2, balanceCents: 0, paidCents: 1001, items: saved.items.map(line => ({ ...line, paidQuantity: 1 })) }, attempt: completed };
    }
    throw new Error('Unexpected mutation');
  });
  render(<HomeScreen business={business} operatorToken="synthetic-memory-only" destination="Venta" onLock={vi.fn()} onLogout={vi.fn()} busy={false} error="" />);
  fireEvent.click(screen.getByRole('button', { name: 'Importe para la venta' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Importe' }), { target: { value: '10.01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Añadir $10.01' }));
  const sale = within(screen.getByRole('complementary', { name: 'Venta actual' }));
  fireEvent.click(sale.getByRole('button', { name: 'Cobrar' }));
  const checkout = within(await screen.findByRole('dialog', { name: 'Cobrar' }));
  expect(checkout.getByRole('radio', { name: 'Efectivo' })).toBeTruthy();
  await waitFor(() => expect((checkout.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false));
  expect(vi.mocked(mutation.execute).mock.calls[0]).toEqual([expect.objectContaining({ command: 'save_order', orderKind: 'counter', items: [expect.objectContaining({ kind: 'amount', unitPriceCents: 1001, note: '' })] }), 'counter']);
  fireEvent.click(checkout.getByRole('button', { name: 'Registrar pago' }));
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'record_checkout', confirmed: true })));
  expect(await checkout.findByText('Pago registrado.')).toBeTruthy();
});
