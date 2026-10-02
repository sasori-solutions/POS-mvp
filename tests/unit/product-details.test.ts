import { describe, expect, it } from 'vitest'
import { emptyDetails, includedTax, lineKey, selectedPrice, selectionLabel } from '../../src/lib/product-details'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { readPendingSale } from '../../src/lib/pending-sale'
import type { Product } from '../../src/lib/pos-contracts'
const id = '7bd0d31b-729c-4eab-90f3-328044b164ce', modifier = 'a9f45b3c-729c-4eab-90f3-328044b164ce'
const selection = { variationId: id, modifierIds: [modifier], variablePriceCents: null }
const product: Product = { id, name: 'Café', category: '', priceCents: 1001, active: true, version: 1, details: { ...emptyDetails(), variations: [{ id, name: 'Grande', priceCents: 5801, sku: '', barcode: '', soldOut: false }], modifierSets: [{ id: modifier, name: 'Leche', min: 1, max: 1, options: [{ id: modifier, name: 'Avena', priceCents: 101 }] }] } }
describe('catalog selections and durable recovery', () => {
  it('prices selections in integer cents and rounds included tax once per line', () => {
    expect(selectedPrice(product, selection)).toBe(5902)
    expect(includedTax(17706, 1600)).toBe(2442)
    expect(selectionLabel(product, selection)).toBe('Grande, Avena')
    expect(lineKey({ product, selection })).not.toBe(lineKey({ product }))
  })
  it('keeps the exact variant, modifiers and variable price on recovery and rejects malformed selections', () => {
    const sale = { command: 'complete_sale', operationId: id, paymentMethod: 'cash', totalCents: 5902, items: [{ productId: id, version: 1, quantity: 1, unitPriceCents: 5902, selection }] }
    const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value) }) as unknown as Storage
    expect(readPendingSale('key',storage(sale))).toEqual(sale)
    expect(() => readPendingSale('key',storage({ ...sale,items: [{ ...sale.items[0],selection: { ...selection,modifierIds:[modifier,modifier] } }] }))).toThrow(/pendiente/)
  })
  it('accepts distinct selections for one product and rejects extra nested fields or invalid inventory', () => {
    const access = { action:'pos',businessId:id,operatorToken:'ab'.repeat(32) }
    const sale = { ...access, command:'complete_sale',operationId:id,paymentMethod:'cash',totalCents:2002,items:[{productId:id,version:1,quantity:1,unitPriceCents:1001,selection},{productId:id,version:1,quantity:1,unitPriceCents:1001}] }
    expect(parseAccountRequest(sale)).toHaveProperty('items')
    const command = { ...access,command:'save_product',operationId:id,productId:id,expectedVersion:null,name:'Café',category:'',priceCents:1001,details:emptyDetails() }
    expect(parseAccountRequest(command)).toHaveProperty('details')
    for(const details of [{...emptyDetails(),stock:1.5},{...emptyDetails(),secret:'x'},{...emptyDetails(),tileColor:'url(example)'}]) expect(() => parseAccountRequest({...command,details})).toThrow()
  })
  it('accepts bounded image chunks and rejects missing or out-of-range parts', () => {
    const command = { action:'pos',businessId:id,operatorToken:'ab'.repeat(32),command:'upload_product_image',operationId:id,imageId:id,part:0,parts:1,data:'A'.repeat(4096) }
    expect(parseAccountRequest(command)).toHaveProperty('parts',1)
    for (const patch of [{parts:0},{parts:61},{part:1},{part:-1},{data:''},{data:'A'.repeat(4097)},{data:'<svg>'}]) expect(() => parseAccountRequest({...command,...patch})).toThrow()
  })
})
