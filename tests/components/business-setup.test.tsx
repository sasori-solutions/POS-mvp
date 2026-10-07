// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import BusinessSetup, { type BusinessDraft } from '../../src/components/BusinessSetup';
import { detectedBusinessTimezone, newBusinessProfile } from '../../src/lib/business-profile';
import ProductEditor from '../../src/components/ProductEditor';
import type { Product } from '../../src/lib/pos-contracts';
import { emptyDetails } from '../../src/lib/product-details';

beforeEach(() => {
  const options = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: 'America/Hermosillo' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Setup({ submit = vi.fn() }: { submit?: (draft: BusinessDraft) => void }) {
  const [draft, setDraft] = useState<BusinessDraft>({ name: 'Café sintético', businessType: 'cafe', timezone: detectedBusinessTimezone(), profile: newBusinessProfile('cafe') });
  return <BusinessSetup draft={draft} onChange={setDraft} error="" onSubmit={event => { event.preventDefault(); submit(draft); }} />;
}

test('business creation separates identity from operation and allows an explicit account choice', () => {
  const submit = vi.fn();
  render(<Setup submit={submit} />);
  expect(screen.getByRole('heading', { name: 'Tu negocio' })).toBeTruthy();
  expect(screen.queryByLabelText('¿Qué IVA usas en tus precios?')).toBeNull();
  expect(screen.getByText(/Usaremos la hora de este dispositivo/).textContent).toContain('Hermosillo');
  fireEvent.click(screen.getByRole('radio', { name: 'Restaurante' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(screen.getByRole('heading', { name: 'Tu forma de trabajar' })).toBeTruthy();
  expect((screen.getByRole('radio', { name: /^Cuentas abiertas/ }) as HTMLInputElement).checked).toBe(true);
  const tax = screen.getByLabelText('¿Qué IVA usas en tus precios?') as HTMLSelectElement;
  expect(tax.value).toBe(''); expect(tax.required).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /^Cobro directo/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(submit).not.toHaveBeenCalled(); expect(tax.checkValidity()).toBe(false);
  fireEvent.change(tax, { target: { value: 'exempt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ businessType: 'restaurant', timezone: 'America/Hermosillo', profile: expect.objectContaining({ accountsEnabled: false, defaultVatTreatment: 'exempt' }) }));
});

test('going back preserves the operation draft and selecting another type applies its account preset', () => {
  render(<Setup />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  fireEvent.change(screen.getByLabelText('¿Qué IVA usas en tus precios?'), { target: { value: 'vat_0' } });
  fireEvent.click(screen.getByRole('radio', { name: /^Cuentas abiertas/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect((screen.getByLabelText('¿Qué IVA usas en tus precios?') as HTMLSelectElement).value).toBe('vat_0');
  expect((screen.getByRole('radio', { name: /^Cuentas abiertas/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Otro' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect((screen.getByRole('radio', { name: /^Cobro directo/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('¿Qué IVA usas en tus precios?') as HTMLSelectElement).value).toBe('vat_0');
});

test('creation preserves external cards and Point as independent payment methods', () => {
  const submit = vi.fn();
  render(<Setup submit={submit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect((screen.getByRole('checkbox', { name: 'Mercado Pago Point' }) as HTMLInputElement).checked).toBe(true);
  for (const label of ['Tarjeta externa', 'Transferencia']) {
    fireEvent.click(screen.getByRole('checkbox', { name: label }));
  }
  expect(screen.getByRole('button', { name: 'Añadir cuenta bancaria' })).toBeTruthy();
  const tax = screen.getByLabelText('¿Qué IVA usas en tus precios?') as HTMLSelectElement;
  expect(tax.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(tax, { target: { value: 'unconfigured' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    name: 'Café sintético', businessType: 'cafe', timezone: 'America/Hermosillo',
    profile: { branchName: 'Sucursal principal', registerName: 'Caja 1', address: '', city: '', state: '', contactPhone: '',
      paymentMethods: ['cash', 'card_integrated', 'card_external', 'transfer'], accountsEnabled: false, defaultVatTreatment: 'unconfigured', logoImageId: null },
  });
  expect(submit.mock.calls[0][0].profile.transferAccount).toBeUndefined();
});

test('new product uses the selected business IVA without changing existing product treatment', () => {
  const props = { access: { businessId: 'business', operatorToken: 'a'.repeat(64) }, products: [], onClose: vi.fn(), onSaved: vi.fn(), onRefresh: vi.fn() };
  const view = render(<ProductEditor {...props} product={null} defaultVatTreatment="exempt" />);
  expect((screen.getByLabelText('IVA del producto') as HTMLSelectElement).value).toBe('exempt');
  view.unmount();
  const product: Product = { id: 'product', name: 'Producto anterior', category: '', priceCents: 11600, active: true, version: 1, createdAt: '', updatedAt: '', details: { ...emptyDetails(), taxTreatment: 'vat_16', taxBps: 1600 } };
  render(<ProductEditor {...props} product={product} defaultVatTreatment="exempt" />);
  expect((screen.getByLabelText('IVA del producto') as HTMLSelectElement).value).toBe('vat_16');
});

test('an unconfigured default requires choosing IVA for the new product', () => {
  render(<ProductEditor access={{ businessId: 'business', operatorToken: 'a'.repeat(64) }} products={[]} product={null} defaultVatTreatment="unconfigured" onClose={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()} />);
  const select = screen.getByLabelText('IVA del producto') as HTMLSelectElement;
  expect(select.value).toBe('');
  expect(select.required).toBe(true);
});
