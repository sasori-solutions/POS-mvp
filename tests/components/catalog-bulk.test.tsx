// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { randomUUID } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CatalogBulkPanel from '../../src/components/CatalogBulkPanel';
import { AccountClientError } from '../../src/lib/account';
import { posRequest } from '../../src/lib/pos';
import { loadCatalogBatchPlan } from '../../src/lib/catalog-batch-recovery';
import type { Product } from '../../src/lib/pos-contracts';
import type { CatalogBatchCommand } from '../../src/lib/catalog-csv';

vi.mock('../../src/lib/pos', async original => ({ ...(await original<typeof import('../../src/lib/pos')>()), posRequest: vi.fn() }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });
const access = { businessId: randomUUID(), operatorToken: 'a'.repeat(64) };
const actorId = randomUUID();
function product(): Product { return { id: randomUUID(), name: 'Café sintético', category: '', priceCents: 1001, version: 1, active: true }; }
function panel(products: Product[], onSaved = vi.fn()) { return <CatalogBulkPanel access={access} actorId={actorId} products={products} onClose={() => {}} onSaved={onSaved} />; }
function prepareBulk() {
  fireEvent.click(screen.getByRole('button', { name: 'Edición masiva' }));
  fireEvent.click(screen.getByLabelText(/Seleccionar todos/));
  fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'false' } });
  fireEvent.click(screen.getByRole('button', { name: /Revisar cambios/ }));
}

describe('catalogue batch review and interruption recovery', () => {
  it('previews row errors and chosen IVA before allowing an import; reviewing makes no request', async () => {
    render(<CatalogBulkPanel access={access} actorId={actorId} products={[]} defaultVatTreatment="exempt" onClose={() => {}} onSaved={() => {}} />);
    const file = new File(['nombre,precio_mxn\nCafé,10.01\nTé,1.001'], 'menu.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'nombre,precio_mxn\nCafé,10.01\nTé,1.001' });
    fireEvent.change(screen.getByLabelText('Archivo CSV del menú'), { target: { files: [file] } });
    await screen.findByText(/1 filas con errores/);
    expect(screen.getByRole('button', { name: 'Revisar importación' })).toBeDisabled(); expect(posRequest).not.toHaveBeenCalled();
    const valid = new File(['nombre,precio_mxn\nCafé,10.01'], 'menu.csv');
    Object.defineProperty(valid, 'text', { value: async () => 'nombre,precio_mxn\nCafé,10.01' });
    fireEvent.change(screen.getByLabelText('Archivo CSV del menú'), { target: { files: [valid] } });
    await screen.findByText(/0 filas con errores/);
    fireEvent.click(screen.getByRole('button', { name: 'Revisar importación' }));
    expect(posRequest).not.toHaveBeenCalled();
    const batch = loadCatalogBatchPlan(access.businessId, actorId)!.batches[0];
    expect(batch.command).toBe('import_products');
    if (batch.command === 'import_products') expect(batch.items[0]).toMatchObject({ expectedVersion: null, priceCents: 1001, details: { taxTreatment: 'exempt', taxBps: 0 } });
  });

  it('replays exactly the same UUID/payload after a lost response and reload, without claiming success or allowing discard', async () => {
    const products = [product()]; const saved = vi.fn();
    vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Se perdió la respuesta.'));
    const view = render(panel(products, saved)); prepareBulk();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await screen.findByRole('alert'); expect(saved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Descartar lotes pendientes' })).toBeDisabled();
    const original = structuredClone(vi.mocked(posRequest).mock.calls[0][1]);
    expect(loadCatalogBatchPlan(access.businessId, actorId)).toMatchObject({ completed: 0, uncertain: true });
    view.unmount();
    vi.mocked(posRequest).mockResolvedValueOnce({ products: [{ ...products[0], active: false, version: 2 }] } as never);
    render(panel(products, saved)); fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await screen.findByText('Todos los lotes se guardaron. El catálogo está actualizado.');
    expect(vi.mocked(posRequest).mock.calls[1][1]).toEqual(original);
    expect(saved).toHaveBeenCalledOnce(); expect(loadCatalogBatchPlan(access.businessId, actorId)).toBeNull();
  });

  it('sends no request if the pending ledger cannot be preserved; unreadable prior recovery cannot be overwritten', async () => {
    render(panel([product()])); prepareBulk();
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Almacenamiento lleno'); });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await screen.findByText('Almacenamiento lleno'); expect(posRequest).not.toHaveBeenCalled(); set.mockRestore(); cleanup();
    localStorage.setItem(`pos-catalog-batches-v1:${access.businessId}:${actorId}`, '{invalid');
    render(panel([product()])); await waitFor(() => expect(screen.getByText(/Hay una edición pendiente/)).toBeVisible());
    expect(screen.queryByRole('button', { name: 'Edición masiva' })).not.toBeInTheDocument();
    expect(localStorage.getItem(`pos-catalog-batches-v1:${access.businessId}:${actorId}`)).toBe('{invalid');
  });

  it('retains the original uncertain ledger and prevents late responses from updating a new actor or dispatching another batch', async () => {
    const products = Array.from({ length: 25 }, product); const saved = vi.fn();
    let finish: (value: never) => void = () => {};
    vi.mocked(posRequest).mockImplementationOnce(async () => await new Promise<never>(resolve => { finish = resolve; }));
    const view = render(panel(products, saved)); prepareBulk();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await waitFor(() => expect(posRequest).toHaveBeenCalledOnce());
    const first = vi.mocked(posRequest).mock.calls[0][1] as CatalogBatchCommand;
    view.rerender(<CatalogBulkPanel access={{ ...access, operatorToken: 'b'.repeat(64) }} actorId="other-actor" products={products} onClose={() => {}} onSaved={saved} />);
    const ids = first.command === 'bulk_edit_products' ? first.products.map(item => item.productId) : [];
    finish({ products: products.filter(item => ids.includes(item.id)).map(item => ({ ...item, active: false, version: 2 })) } as never);
    await act(async () => { await Promise.resolve(); });
    expect(loadCatalogBatchPlan(access.businessId, actorId)).toMatchObject({ completed: 0, uncertain: true });
    expect(posRequest).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled();
    expect(loadCatalogBatchPlan(access.businessId, 'other-actor')).toBeNull();
  });

  it.each(['accepted', 'refused'])('keeps the new same-actor batch UUID/payload when the old session returns a late %s response', async outcome => {
    const products = [product()], previousSaved = vi.fn();
    let resolveOld: (value: never) => void = () => {}, rejectOld: (error: Error) => void = () => {};
    vi.mocked(posRequest).mockImplementationOnce(async () => await new Promise<never>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
    const previous = render(panel(products, previousSaved)); prepareBulk();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await waitFor(() => expect(posRequest).toHaveBeenCalledOnce());
    const original = structuredClone(vi.mocked(posRequest).mock.calls[0][1]); previous.unmount();
    const currentAccess = { ...access, operatorToken: 'b'.repeat(64) }, acceptedProducts = products.map(item => ({ ...item, active: false, version: 2 })), nextSaved = vi.fn();
    vi.mocked(posRequest).mockResolvedValueOnce({ products: acceptedProducts } as never);
    const currentView = render(<CatalogBulkPanel access={currentAccess} actorId={actorId} products={products} onClose={() => {}} onSaved={nextSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await screen.findByText('Todos los lotes se guardaron. El catálogo está actualizado.');
    expect(vi.mocked(posRequest).mock.calls[1][1]).toEqual(original);
    currentView.rerender(<CatalogBulkPanel access={currentAccess} actorId={actorId} products={acceptedProducts} onClose={() => {}} onSaved={nextSaved} />);
    prepareBulk(); vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Nueva respuesta pendiente'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' })); await screen.findByText('Nueva respuesta pendiente');
    const current = loadCatalogBatchPlan(access.businessId, actorId)!;
    expect(current.batches[0].operationId).not.toBe(original.operationId);
    await act(async () => { if (outcome === 'accepted') resolveOld({ products: acceptedProducts } as never); else rejectOld(new AccountClientError('PRODUCT_CHANGED', 'Respuesta anterior')); });
    expect(loadCatalogBatchPlan(access.businessId, actorId)).toEqual(current); expect(previousSaved).not.toHaveBeenCalled();
    expect(nextSaved).toHaveBeenCalledOnce(); expect(screen.getByText('Nueva respuesta pendiente')).toBeVisible();
    vi.mocked(posRequest).mockResolvedValueOnce({ products: acceptedProducts.map(item => ({ ...item, version: 3 })) } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await screen.findByText('Todos los lotes se guardaron. El catálogo está actualizado.');
    expect(vi.mocked(posRequest).mock.calls[3][1]).toEqual(current.batches[0]); expect(loadCatalogBatchPlan(access.businessId, actorId)).toBeNull();
  });

  it('keeps an auth-refused replay uncertain because it cannot prove the original batch had no effects', async () => {
    const sessionError = vi.fn();
    vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('SESSION_INVALID', 'Sesión terminada'));
    render(<CatalogBulkPanel access={access} actorId={actorId} products={[product()]} onClose={() => {}} onSaved={() => {}} onSessionError={sessionError} />);
    prepareBulk(); fireEvent.click(screen.getByRole('button', { name: 'Confirmar y guardar cambios' }));
    await screen.findByText('Sesión terminada');
    expect(loadCatalogBatchPlan(access.businessId, actorId)).toMatchObject({ completed: 0, uncertain: true });
    expect(sessionError).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: 'Descartar lotes pendientes' })).toBeDisabled();
  });
});
