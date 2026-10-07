import { expect, test } from 'vitest'
import { parsePromotionCommand, parsePromotionScope } from '../../supabase/functions/account/promotion-validation'

const id = '00000000-0000-4000-a000-000000000001', second = '00000000-0000-4000-a000-000000000002'
const scope = { productIds: [second,id.toUpperCase()], categories: [' Cafe\u0301 ', ' Pan  dulce '] }
const save = { command: 'save_promotion', operationId: id, promotionId: second, expectedRevision: null, name: ' Oferta  café ', active: true, kind: 'fixed', value: 101, scope }

test('scopes keep literal category text, canonical Unicode, sorted unique selectors and exact cent values', () => {
  expect(parsePromotionScope(scope)).toEqual({ productIds: [id,second], categories: ['Café','Pan dulce'] })
  expect(parsePromotionScope({ productIds: [], categories: ['<b>Literal</b>'] })).toEqual({ productIds: [], categories: ['<b>Literal</b>'] })
  expect(parsePromotionCommand(save,[])).toEqual({ ...save, name: 'Oferta café', scope: parsePromotionScope(scope) })
  expect(parsePromotionCommand({ ...save, kind: 'percent', value: 3333 },[])).toMatchObject({ kind: 'percent', value: 3333 })
})

test('empty selectors, duplicate normalized labels, unknown keys, controls and bounded counts fail', () => {
  for (const value of [
    {productIds:[],categories:[]}, {productIds:[id,id.toUpperCase()],categories:[]}, {productIds:[],categories:['Café','Cafe\u0301']},
    {productIds:[],categories:['Café'],extra:true}, {productIds:[],categories:['bad\nname']}, {productIds:[],categories:['x'.repeat(61)]},
    {productIds:Array(101).fill(id),categories:[]}, {productIds:[],categories:Array.from({length:25},(_,index)=>`Cat${index}`)},
  ]) expect(() => parsePromotionScope(value)).toThrow()
})

test('commands reject decimal money, fake metadata, missing revisions and excessive percentages', () => {
  for (const command of [{...save,value:1.01},{...save,value:-1},{...save,kind:'percent',value:10001},{...save,expectedRevision:0},{...save,promotion:{id,revision:1,name:'Fake'}},{...save,active:'yes'}]) expect(() => parsePromotionCommand(command,[])).toThrow()
  expect(parsePromotionCommand({command:'apply_order_promotion',operationId:id,orderId:id,expectedRevision:1,promotionId:second,promotionRevision:1},[])).toMatchObject({ command: 'apply_order_promotion', promotionRevision: 1 })
  expect(() => parsePromotionCommand({command:'apply_order_promotion',operationId:id,orderId:id,expectedRevision:1,promotionId:second,promotionRevision:null},[])).toThrow()
})

test('route matching preserves access keys and exact command envelopes', () => {
  expect(parsePromotionCommand({command:'promotions',businessId:'tenant'},['businessId'])).toEqual({command:'promotions'})
  expect(() => parsePromotionCommand({command:'promotions',businessId:'tenant',unknown:true},['businessId'])).toThrow()
  expect(parsePromotionCommand({command:'catalog'},[])).toBeNull()
})
