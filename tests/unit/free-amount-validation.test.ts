import { describe, expect, test } from 'vitest'
import { parsePosCommand } from '../../supabase/functions/account/pos-validation'
const id = '00000000-0000-4000-8000-000000000001'
const line = { kind: 'amount', name: '  Servicio   libre  ', quantity: 1, unitPriceCents: 1001 }
const order = { command: 'save_order', operationId: id, orderId: id, expectedRevision: null, name: 'Cuenta', tableId: null, orderKind: 'counter', items: [{ ...line, lineId: id, note: '' }] }
const sale = { command: 'complete_sale', operationId: id, paymentMethod: 'cash', totalCents: 1001, items: [line] }

describe('exact amount-line HTTP contract', () => {
  test('normalizes concepts while preserving explicit amount origin and exact integer money', () => {
    expect(parsePosCommand(order, [])).toEqual({ ...order, items: [{ ...line, name: 'Servicio libre', lineId: id, note: '' }] })
    expect(parsePosCommand(sale, [])).toEqual({ ...sale, items: [{ ...line, name: 'Servicio libre' }] })
    expect(parsePosCommand({ ...sale, items: [{ ...line, name: '' }] }, [])).toMatchObject({ items: [{ name: '', kind: 'amount' }] })
  })
  test('allows separate identical amounts and product amounts in the same legacy sale', () => {
    expect(parsePosCommand({ ...sale, totalCents: 2002, items: [line, line] }, [])).toMatchObject({ totalCents: 2002, items: [expect.objectContaining({ kind: 'amount' }), expect.objectContaining({ kind: 'amount' })] })
    const product = { productId: id, version: 1, quantity: 1, unitPriceCents: 1001 }
    expect(parsePosCommand({ ...sale, totalCents: 2002, items: [line, product] }, [])).toMatchObject({ totalCents: 2002 })
    expect(() => parsePosCommand({ ...sale, totalCents: 2002, items: [product, product] }, [])).toThrow()
  })
  test.each([{ productId: id }, { version: 1 }, { selection: null }, { taxBps: 1600 }, { taxTreatment: 'vat_16' }, { kind: 'product' }, { note: 'Cocina' }, { quantity: 0 }, { quantity: 1000 }, { quantity: 1.1 }, { unitPriceCents: 0 }, { unitPriceCents: -1 }, { unitPriceCents: 0.1 }, { unitPriceCents: 100000000 }, { name: null }, { name: 'x'.repeat(101) }, { name: 'Texto\ncontrol' }])('rejects forged amount metadata or invalid bounds: %j', patch => {
    expect(() => parsePosCommand({ ...order, items: [{ ...order.items[0], ...patch }] }, [])).toThrow()
    expect(() => parsePosCommand({ ...sale, items: [{ ...line, ...patch }] }, [])).toThrow()
  })
  test('enforces account-total overflow and exact declared legacy amount', () => {
    expect(() => parsePosCommand({ ...order, items: [{ ...order.items[0], quantity: 999, unitPriceCents: 99999999 }] }, [])).toThrow()
    expect(() => parsePosCommand({ ...sale, totalCents: 1000 }, [])).toThrow()
    expect(() => parsePosCommand({ ...sale, items: Array.from({ length: 41 }, () => line), totalCents: 41041 }, [])).toThrow()
  })
})
