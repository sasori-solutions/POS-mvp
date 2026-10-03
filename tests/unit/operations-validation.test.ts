import { describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

const businessId='a937be42-142d-4eb0-9915-899b289fb552', lineId='629a2087-804f-4c9d-a421-6fedbb61a5d1', operationId='8dc31870-c3eb-4567-8a9e-1a0d5f373d82'
const access={action:'pos',businessId,operatorToken:'ab'.repeat(32)}
const line={lineId,productId:businessId,quantity:999,unitPriceCents:1001,version:1,note:''}
const order={command:'save_order',operationId,orderId:businessId,expectedRevision:null,name:'  Cuenta   sintética ',tableId:null,items:[line]}

describe('operational HTTP command boundary',()=>{
 it('parses the same typed commands through signed personal and restricted device transports',()=>{
  expect(parseAccountRequest({...access,...order})).toMatchObject({name:'Cuenta sintética',items:[line]})
  const prepare={command:'prepare_checkout',operationId,orderId:businessId,expectedRevision:1,items:[{lineId,quantity:999}],paymentMethod:'card_external'}
  expect(parseAccountRequest({...access,...prepare})).toMatchObject(prepare)
  expect(parseAccountRequest({action:'device_pos',deviceToken:'cd'.repeat(32),operatorToken:access.operatorToken,...prepare})).toMatchObject(prepare)
 })
 it('rejects unknown keys, noninteger units/cents, repeated lines and oversized operational carts',()=>{
  for(const patch of [{unknown:1},{items:[]},{items:[line,line]},{items:Array.from({length:41},(_,i)=>({...line,lineId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}))},
   {items:[{...line,quantity:0}]},{items:[{...line,quantity:1000}]},{items:[{...line,quantity:1.5}]},{items:[{...line,unitPriceCents:10.01}]},{items:[{...line,unitPriceCents:100_000_000}]},
   {items:[{...line,note:'a'.repeat(161)}]},{items:[{...line,note:'control\ncharacter'}]},{items:[{...line,secret:'synthetic'}]}]) expect(()=>parseAccountRequest({...access,...order,...patch})).toThrow()
  for(const openingCents of [-1,1.5,10_000_000_000,'100']) expect(()=>parseAccountRequest({...access,command:'open_shift',operationId,openingCents})).toThrow()
 })
 it('requires explicit manual confirmation and reason on recovery and bounds discount percentages',()=>{
  const resolve={command:'resolve_checkout',operationId,attemptId:businessId,expectedRevision:1,resolution:'complete',confirmed:true,reason:'Pago recibido'}
  expect(parseAccountRequest({...access,...resolve})).toMatchObject(resolve)
  for(const patch of [{confirmed:false},{confirmed:'true'},{reason:''},{resolution:'unknown'},{expectedRevision:null},{terminalApproved:true}]) expect(()=>parseAccountRequest({...access,...resolve,...patch})).toThrow()
  const discount={command:'set_order_discount',operationId,orderId:businessId,expectedRevision:1,discount:{kind:'percent',value:10000,reason:'Cortesía'}}
  expect(parseAccountRequest({...access,...discount})).toMatchObject(discount)
  for(const patch of [{value:10001},{value:1.5},{kind:'owner'},{reason:''},{extra:1}]) expect(()=>parseAccountRequest({...access,...discount,discount:{...discount.discount,...patch}})).toThrow()
 })
 it('accepts actual calendar dates and exact read-only command keys',()=>{
  expect(parseAccountRequest({...access,command:'report',date:'2028-02-29'})).toHaveProperty('date','2028-02-29')
  for(const date of ['2026-02-29','2026-02-31','2026-13-01','2026-01-00','2026-2-01','2026-10-02T00:00:00Z']) expect(()=>parseAccountRequest({...access,command:'report',date})).toThrow()
  expect(()=>parseAccountRequest({...access,command:'operations',operationId})).toThrow()
 })
})
