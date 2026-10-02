import { describe, expect, it } from 'vitest'
import { cartTotal, filterProducts, money, parsePrice, priceInput, saleDate } from '../../src/lib/pos'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { clearPendingSale, pendingSaleKey, readPendingSale, writePendingSale } from '../../src/lib/pending-sale'
import type { PendingSale } from '../../src/lib/pending-sale'
import type { Product } from '../../src/lib/pos-contracts'

const id = '7bd0d31b-729c-4eab-90f3-328044b164ce'
const product: Product = { id, name: 'Café frío', category: 'Café', priceCents: 1001, active: true, version: 1 }
const access = { action: 'pos', businessId: id, operatorToken: 'ab'.repeat(32) }
const sale: PendingSale = { command: 'complete_sale', operationId: id, items: [{ productId: id, quantity: 3, unitPriceCents: 1001, version: 1 }], totalCents: 3003, paymentMethod: 'card_external' }

describe('MXN and cart invariants', () => {
  it('parses decimal money exactly, including commas and zero', () => {
    for (const [text, cents] of [['0', 0], ['0.01', 1], ['10.10', 1010], ['58,25', 5825], ['999999.99', 99999999], [' 12.5 ', 1250]] as const) expect(parsePrice(text)).toBe(cents)
    for (const text of ['', '-1', '1.001', 'NaN', 'Infinity', '1e3', '1,000.00', '1000000', '12abc']) expect(parsePrice(text)).toBeNull()
    expect(priceInput(1001)).toBe('10.01')
    expect(money(3003)).toBe('$30.03')
  })
  it('computes integer totals and refuses invalid quantity, price and overflow', () => {
    expect(cartTotal([{ product, quantity: 3 }, { product: { ...product, priceCents: 10 }, quantity: 3 }])).toBe(3033)
    expect(cartTotal([])).toBe(0)
    for (const quantity of [0, -1, 1.5, 1000, NaN, Infinity]) expect(() => cartTotal([{ product, quantity }])).toThrow()
    for (const priceCents of [-1, 1.5, Infinity, 100000000]) expect(() => cartTotal([{ product: { ...product, priceCents }, quantity: 1 }])).toThrow()
    expect(() => cartTotal([{ product: { ...product, priceCents: 99999999 }, quantity: 999 }])).toThrow()
    expect(() => cartTotal(Array.from({ length: 41 }, () => ({ product, quantity: 1 })))).toThrow()
  })
  it('searches accents instantly and combines category filters', () => {
    const rows = [product, { ...product, id: 'other', name: 'Panqué', category: 'Pan' }]
    expect(filterProducts(rows, ' CAFE ', '')).toEqual([product])
    expect(filterProducts(rows, 'panque', 'Pan')).toHaveLength(1)
    expect(filterProducts(rows, 'cafe', 'Pan')).toEqual([])
  })
  it('uses the business timezone across midnight', () => {
    expect(saleDate('2026-10-02T01:30:00Z', 'America/Mexico_City')).toContain('1 oct 2026')
  })
})

describe('shared HTTP command boundary', () => {
  it('validates product deletion for personal and shared-register access', () => {
    const command = { command: 'delete_product', operationId: id, productId: id, expectedVersion: 1 }
    expect(parseAccountRequest({ ...access, ...command })).toMatchObject(command)
    expect(parseAccountRequest({ action: 'device_pos', deviceToken: 'cd'.repeat(32), operatorToken: access.operatorToken, ...command })).toMatchObject(command)
    for (const change of [{ productId: 'invalid' }, { expectedVersion: null }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { active: false }, { businessId: undefined }])
      expect(() => parseAccountRequest({ ...access, ...command, ...change })).toThrow()
  })
  it('normalizes products and validates personal and device payloads', () => {
    const input = { ...access, command: 'save_product', operationId: id, productId: id, expectedVersion: null, name: '  Café   frío ', category: ' Café ', priceCents: 1001 }
    expect(parseAccountRequest(input)).toMatchObject({ name: 'Café frío', category: 'Café' })
    expect(parseAccountRequest({ action: 'device_pos', deviceToken: 'cd'.repeat(32), operatorToken: access.operatorToken, ...sale })).toMatchObject(sale)
    expect(() => parseAccountRequest({ ...input, userId: id })).toThrow()
    expect(() => parseAccountRequest({ ...input, priceCents: 10.01 })).toThrow()
    expect(() => parseAccountRequest({ ...input, name: 'Café\nfrío' })).toThrow()
  })
  it('rejects empty/duplicate/invalid sale items, incorrect totals and card data', () => {
    const request = { ...access, ...sale }
    expect(parseAccountRequest(request)).toMatchObject(sale)
    for (const change of [{ items: [] }, { items: [...sale.items, ...sale.items] }, { totalCents: 3002 }, { paymentMethod: 'bank' }, { pan: 'fixture' }, { cvv: 'fixture' }, { items: [{ ...sale.items[0], quantity: 0 }] }, { items: [{ ...sale.items[0], quantity: 1.5 }] }, { items: [{ ...sale.items[0], version: null }] }]) expect(() => parseAccountRequest({ ...request, ...change })).toThrow()
    expect(() => parseAccountRequest({ ...access, command: 'sales', cursor: { createdAt: 'not-a-date', id } })).toThrow()
  })
})

describe('durable retry without credentials', () => {
  it('recovers a command and strips unexpected fields without losing its operation ID', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } } as Storage
    const key = pendingSaleKey(id, 'employee')
    writePendingSale(key, sale, storage)
    expect(readPendingSale(key, storage)).toEqual(sale)
    expect(store.get(key)).not.toContain('operatorToken')
    storage.setItem(key, JSON.stringify({ ...sale, operatorToken: 'secret' }))
    expect(readPendingSale(key, storage)).toEqual(sale)
    storage.setItem(key, JSON.stringify({ ...sale, totalCents: 1 }))
    expect(() => readPendingSale(key, storage)).toThrow(/pendiente/)
  })
  it('does not pretend a command was saved when storage is full', () => {
    expect(() => writePendingSale('key', sale, { setItem: () => { throw new Error('QuotaExceededError') } } as unknown as Storage)).toThrow()
  })
  it('does not erase another tabs newer recovery command', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) }, removeItem: (key: string) => { store.delete(key) } } as Storage
    writePendingSale('key', sale, storage)
    clearPendingSale('key', 'c6c3408a-9036-43c9-bd06-73e08be681c1', storage)
    expect(readPendingSale('key', storage)).toEqual(sale)
    clearPendingSale('key', sale.operationId, storage)
    expect(readPendingSale('key', storage)).toBeNull()
  })
})
