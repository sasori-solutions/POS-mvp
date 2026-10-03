import { describe, expect, it } from 'vitest'
import { productVat, vatSummary } from '../../src/lib/vat'
import { emptyDetails, includedTax, isSoldOut, lineKey, productDetails, selectedPrice, selectionLabel } from '../../src/lib/product-details'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { readPendingSale } from '../../src/lib/pending-sale'
import type { Product } from '../../src/lib/pos-contracts'
const id = '7bd0d31b-729c-4eab-90f3-328044b164ce', modifier = 'a9f45b3c-729c-4eab-90f3-328044b164ce'
const selection = { variationId: id, modifierIds: [modifier], variablePriceCents: null }
const product: Product = { id, name: 'Café', category: '', priceCents: 1001, active: true, version: 1, details: { ...emptyDetails(), variations: [{ id, name: 'Grande', priceCents: 5801, sku: '', barcode: '', soldOut: false }], modifierSets: [{ id: modifier, name: 'Leche', min: 1, max: 1, options: [{ id: modifier, name: 'Avena', priceCents: 101 }] }] } }
describe('catalog selections and durable recovery', () => {
  it('uses manual availability even when historical inventory is empty', () => {
    const historic = {...product,details:{...emptyDetails(),trackStock:true,stock:0,lowStockAlert:9}}
    expect(productDetails(historic)).toMatchObject({trackStock:false,stock:0,lowStockAlert:9})
    expect(isSoldOut(historic)).toBe(false)
    expect(isSoldOut({...historic,details:{...historic.details,soldOut:true}})).toBe(true)
    expect(isSoldOut({...product,details:{...product.details!,variations:product.details!.variations.map(v=>({...v,soldOut:true}))}})).toBe(true)
    expect(historic.details.trackStock).toBe(true)
  })
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


describe('Mexican IVA in final prices', () => {
  it('separates 16 percent, zero rate, exempt and border IVA without increasing the announced total', () => {
    const summary = vatSummary([
      {totalCents:11600,taxBps:1600,taxTreatment:'vat_16'},
      {totalCents:10800,taxBps:800,taxTreatment:'border_8'},
      {totalCents:2500,taxBps:0,taxTreatment:'vat_0'},
      {totalCents:3000,taxBps:0,taxTreatment:'exempt'},
    ])
    expect(summary).toMatchObject({totalCents:27900,baseCents:25500,taxCents:2400,unknown:false})
    expect(summary.groups.map(g=>[g.treatment,g.cents])).toEqual([['vat_16',1600],['border_8',800],['vat_0',0],['exempt',0]])
    expect(includedTax(3,1600)).toBe(0)
    expect(includedTax(6,1600)).toBe(1)
    expect(includedTax(99_999_999*999,1600)).toBe(13_779_310_207)
  })
  it('keeps old unclassified products distinct from zero-rate/exempt and uses saved tax amounts', () => {
    expect(productVat(emptyDetails())).toBe('unconfigured')
    expect(productVat({...emptyDetails(),taxBps:1600})).toBe('vat_16')
    const summary=vatSummary([{totalCents:11600,taxCents:1599,taxBps:null,taxTreatment:'legacy'},{totalCents:1000,taxBps:0,taxTreatment:'unconfigured'}])
    expect(summary).toMatchObject({totalCents:12600,taxCents:1599,baseCents:11001,unknown:true})
    expect(summary.groups[0].treatment).toBe('legacy')
  })
  it('checks exact optional tax metadata, preserves legacy commands and rejects inconsistent rates', () => {
    const command={action:'pos',businessId:id,operatorToken:'ab'.repeat(32),command:'save_product',operationId:id,productId:id,expectedVersion:null,name:'Café',category:'',priceCents:11600,details:emptyDetails()}
    expect(parseAccountRequest(command)).toHaveProperty('details.taxBps',0)
    for(const [taxTreatment,taxBps] of [['vat_16',1600],['vat_0',0],['exempt',0],['border_8',800],['unconfigured',0]])
      expect(parseAccountRequest({...command,details:{...emptyDetails(),taxTreatment,taxBps}})).toHaveProperty('details.taxTreatment',taxTreatment)
    for(const patch of [{taxTreatment:'vat_16',taxBps:0},{taxTreatment:'exempt',taxBps:1600},{taxTreatment:'border_8',taxBps:1600},{taxTreatment:'vat_0',taxBps:100},{taxTreatment:'bogus',taxBps:0},{taxTreatment:null,taxBps:0},{taxTreatment:'vat_16',taxBps:1600,extra:true}])
      expect(()=>parseAccountRequest({...command,details:{...emptyDetails(),...patch}})).toThrow()
  })
})
