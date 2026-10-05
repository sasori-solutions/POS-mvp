// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import BusinessSetup, { type BusinessDraft } from '../../src/components/BusinessSetup';
import { newBusinessProfile } from '../../src/lib/business-profile';
import ProductEditor from '../../src/components/ProductEditor';
import type { Product } from '../../src/lib/pos-contracts';
import { emptyDetails } from '../../src/lib/product-details';

afterEach(cleanup);
function Setup({ submit = vi.fn() }: { submit?: (draft: BusinessDraft) => void }) {
  const [draft, setDraft] = useState<BusinessDraft>({ name: 'Café sintético', businessType: 'cafe', timezone: 'America/Mexico_City', profile: newBusinessProfile('cafe') });
  return <BusinessSetup draft={draft} onChange={setDraft} error="" onSubmit={event => { event.preventDefault(); submit(draft); }} />;
}

test('business creation separates identity from operation and allows an explicit account choice', () => {
  const submit = vi.fn();
  render(<Setup submit={submit} />);
  expect(screen.getByRole('heading', { name: 'Tu negocio' })).toBeTruthy();
  expect(screen.queryByLabelText('IVA predeterminado')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Restaurante' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(screen.getByRole('heading', { name: 'Tu forma de trabajar' })).toBeTruthy();
  expect((screen.getByRole('radio', { name: /^Cuentas abiertas/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /^Cobro directo/ }));
  fireEvent.change(screen.getByLabelText('IVA predeterminado'), { target: { value: 'exempt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ businessType: 'restaurant', profile: expect.objectContaining({ accountsEnabled: false, defaultVatTreatment: 'exempt' }) }));
});

test('going back preserves the operation draft and selecting another type applies its account preset', () => {
  render(<Setup />);
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  fireEvent.change(screen.getByLabelText('IVA predeterminado'), { target: { value: 'vat_0' } });
  fireEvent.click(screen.getByRole('radio', { name: /^Cuentas abiertas/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect((screen.getByLabelText('IVA predeterminado') as HTMLSelectElement).value).toBe('vat_0');
  expect((screen.getByRole('radio', { name: /^Cuentas abiertas/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Anterior' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Otro' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
  expect((screen.getByRole('radio', { name: /^Cobro directo/ }) as HTMLInputElement).checked).toBe(true);
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
