import { expect, test } from 'vitest';
import { cartTotal } from '../../src/lib/pos';
import { lineKey } from '../../src/lib/product-details';
import { cartLineInput, cartLineOrderInput, cartLineVat, saleInputCartLine } from '../../src/lib/cart-line';
import { readPendingSale } from '../../src/lib/pending-sale';
import type { AmountCartLine } from '../../src/lib/pos-contracts';

const amount: AmountCartLine = { kind: 'amount', id: '00000000-0000-4000-8000-000000000001', name: '  Servicio  ', unitPriceCents: 76068, quantity: 1 };
const product = { id: '00000000-0000-4000-8000-000000000002', name: 'Café', category: '', priceCents: 1, version: 1, active: true };
test('amount lines have separate identities, exact totals and no product references in either payload', () => {
  expect(cartTotal([amount, { product, quantity: 1 }])).toBe(76069);
  expect(lineKey(amount)).not.toBe(lineKey({ ...amount, id: 'another-amount' }));
  expect(cartLineInput(amount)).toEqual({ kind: 'amount', name: 'Servicio', unitPriceCents: 76068, quantity: 1 });
  expect(cartLineOrderInput(amount)).toEqual({ kind: 'amount', lineId: amount.id, name: 'Servicio', unitPriceCents: 76068, quantity: 1, note: '' });
  expect(cartLineVat(amount, 'unconfigured')).toEqual({ totalCents: 76068, taxBps: 0, taxTreatment: 'unconfigured' });
  expect(cartLineVat(amount).taxBps).toBe(1600);
  expect(cartLineVat(amount, 'vat_16').taxBps).toBe(1600);
});
test.each([{ unitPriceCents: 0 }, { unitPriceCents: 1.1 }, { unitPriceCents: 100000000 }, { quantity: 1000 }, { name: 'x'.repeat(101) }])('cart rejects invalid amount values %j', patch => {
  expect(() => cartTotal([{ ...amount, ...patch }])).toThrow();
});
test('amount retries preserve identical charges as separate lines and reject forbidden metadata', () => {
  const input = cartLineInput(amount);
  const command = { command: 'complete_sale', operationId: '00000000-0000-4000-8000-000000000003', paymentMethod: 'cash', totalCents: 152136, items: [input, input] };
  const storage = { getItem: () => JSON.stringify(command) } as Storage;
  expect(readPendingSale('pending', storage)).toEqual(command);
  command.items = [{ ...input, productId: product.id }, input] as typeof command.items;
  expect(() => readPendingSale('pending', storage)).toThrow('Conserva este dispositivo');
});
test('a recovered legacy amount gets a valid order UUID when its editable draft enters operational checkout', () => {
  const recovered = saleInputCartLine(cartLineInput(amount), 0, []);
  expect(lineKey(recovered)).toBe('amount:pending-0');
  const operational = cartLineOrderInput(recovered);
  expect(operational.lineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(operational).toMatchObject({ kind: 'amount', name: 'Servicio', unitPriceCents: 76068, quantity: 1, note: '' });
});
