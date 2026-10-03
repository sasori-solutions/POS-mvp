import { describe, expect, it } from 'vitest'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

const businessId='a937be42-142d-4eb0-9915-899b289fb552', lineId='629a2087-804f-4c9d-a421-6fedbb61a5d1', operationId='8dc31870-c3eb-4567-8a9e-1a0d5f373d82'
const access={action:'pos',businessId,operatorToken:'ab'.repeat(32)}
const line={lineId,productId:businessId,quantity:999,unitPriceCents:1001,version:1,note:''}
const order={command:'save_order',operationId,orderId:businessId,expectedRevision:null,name:'  Cuenta   sintética ',tableId:null,items:[line]}

describe('operational HTTP command boundary',()=>{
 it('requires an exact confirmed one-step payment through both authenticated transports',()=>{
  const command={command:'record_payment',operationId,orderId:businessId,expectedRevision:1,items:[{lineId,quantity:1}],paymentMethod:'cash',confirmed:true}
  expect(parseAccountRequest({...access,...command})).toMatchObject(command)
  expect(parseAccountRequest({action:'device_pos',deviceToken:'cd'.repeat(32),operatorToken:access.operatorToken,...command})).toMatchObject(command)
  for(const patch of [{confirmed:false},{confirmed:undefined},{items:[]},{items:[{lineId,quantity:1},{lineId,quantity:1}]},{paymentMethod:'terminal'},{expectedRevision:null},{extra:true}]) expect(()=>parseAccountRequest({...access,...command,...patch})).toThrow()
 })
 it('requires exact reservation updates and a confirmed final payment through both transports',()=>{
  const update={command:'update_checkout',operationId,attemptId:businessId,expectedRevision:1,items:[{lineId,quantity:1}],paymentMethod:'cash'}
  const record={command:'record_checkout',operationId,attemptId:businessId,expectedRevision:2,confirmed:true}
  for(const command of [update,record]) {
   expect(parseAccountRequest({...access,...command})).toMatchObject(command)
   expect(parseAccountRequest({action:'device_pos',deviceToken:'cd'.repeat(32),operatorToken:access.operatorToken,...command})).toMatchObject(command)
   for(const patch of [{attemptId:'invalid'},{expectedRevision:0},{extra:true}]) expect(()=>parseAccountRequest({...access,...command,...patch})).toThrow()
  }
  for(const patch of [{items:[]},{items:[{lineId,quantity:1.5}]},{items:[{lineId,quantity:1},{lineId,quantity:1}]},{paymentMethod:'terminal'}]) expect(()=>parseAccountRequest({...access,...update,...patch})).toThrow()
  for(const confirmed of [false,undefined,'true']) expect(()=>parseAccountRequest({...access,...record,confirmed})).toThrow()
 })
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
 it('allows empty edits of existing accounts but rejects empty creation and collection',()=>{
  const empty={...order,expectedRevision:1,name:'Cuenta sintética',items:[]}
  expect(parseAccountRequest({...access,...empty})).toMatchObject(empty)
  expect(parseAccountRequest({action:'device_pos',deviceToken:'cd'.repeat(32),operatorToken:access.operatorToken,...empty})).toMatchObject(empty)
  for(const expectedRevision of [null,0,undefined,'1']) expect(()=>parseAccountRequest({...access,...empty,expectedRevision})).toThrow()
  expect(()=>parseAccountRequest({...access,command:'prepare_checkout',operationId,orderId:businessId,expectedRevision:1,items:[],paymentMethod:'cash'})).toThrow()
 })
 it('accepts actual calendar dates and exact read-only command keys',()=>{
  expect(parseAccountRequest({...access,command:'report',date:'2028-02-29'})).toHaveProperty('date','2028-02-29')
  for(const date of ['2026-02-29','2026-02-31','2026-13-01','2026-01-00','2026-2-01','2026-10-02T00:00:00Z']) expect(()=>parseAccountRequest({...access,command:'report',date})).toThrow()
  expect(()=>parseAccountRequest({...access,command:'operations',operationId})).toThrow()
 })
 it('bounds period reports and accepts them through personal and shared register transports',()=>{
  const report={command:'report_period',date:'2028-02-29',period:'month'}
  expect(parseAccountRequest({...access,...report})).toMatchObject(report)
  expect(parseAccountRequest({action:'device_pos',deviceToken:'cd'.repeat(32),operatorToken:access.operatorToken,...report})).toMatchObject(report)
  for(const patch of [{period:'year'},{period:null},{date:'1999-12-31'},{date:'2101-01-01'},{date:'2026-02-29'},{timezone:'UTC'},{operationId}]) expect(()=>parseAccountRequest({...access,...report,...patch})).toThrow()
 })
})
