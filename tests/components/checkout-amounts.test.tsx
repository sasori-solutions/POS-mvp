// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OrderDetail from '../../src/features/operations/OrderDetail'
import CheckoutAmountSelection from '../../src/features/operations/CheckoutAmountSelection'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { BusinessContext } from '../../src/lib/contracts'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import { checkoutAmountTotals } from '../../src/lib/checkout-amounts'
import { checkoutTotals } from '../../src/lib/checkout-selection'
import { posRequest } from '../../src/lib/pos'
import SaleScreen from '../../src/components/SaleScreen'
import type { CatalogState } from '../../src/components/useCatalog'
import { money } from '../../src/lib/pos'
import { pointRequest } from '../../src/lib/point-client'
import { pointAccess, pointCheckout, pointSettings } from '../fixtures/point'
vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
vi.mock('../../src/components/PosShared', async original => ({ ...await original<object>(), SaleDetail: () => <p>Recibo sintético</p> }))
beforeEach(() => {
 localStorage.clear()
 vi.stubGlobal('matchMedia', vi.fn(query => ({matches:query.includes('reduce') || query.includes('width >='),addEventListener:vi.fn(),removeEventListener:vi.fn()})))
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })
const business={id:'business',name:'Negocio sintético',role:'owner',permissions:[],profile:{paymentMethods:['cash','transfer']}} as unknown as BusinessContext
const initial:OperationalOrder={id:'order',revision:1,name:'Cuenta',orderKind:'service',tableId:null,status:'open',phase:'service',frozen:false,createdAt:'2026-10-04T12:00:00Z',updatedAt:'2026-10-04T12:00:00Z',operatorName:'Sintético',items:[{lineId:'line',productId:'product',version:1,name:'Consumo',kitchenName:'Consumo',category:'',selectionLabel:'',note:'',quantity:1,paidQuantity:0,sentQuantity:0,unitPriceCents:76068,grossCents:76068,discountCents:0,totalCents:76068,taxCents:0,taxBps:0,taxTreatment:'unconfigured',paidTotalCents:0,paidDiscountCents:0,paidTaxCents:0}],discount:null,grossCents:76068,discountCents:0,totalCents:76068,taxCents:0,paidCents:0,waivedCents:0,cancelledCents:0,balanceCents:76068}

function AmountInputs() {
 const [inputs,setInputs]=useState([''])
 return <CheckoutAmountSelection balanceCents={76068} inputs={inputs} onChange={setInputs} disabled={false} />
}
test('mobile amount rows compute the last person and use no product selection',()=>{
 render(<AmountInputs />)
 expect(screen.queryByRole('checkbox')).toBeNull()
 fireEvent.change(screen.getByLabelText('Persona 1'),{target:{value:'500'}})
 expect(screen.getByText('$260.68')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Añadir persona'}))
 fireEvent.change(screen.getByLabelText('Persona 2'),{target:{value:'40'}})
 expect(screen.getAllByText('$220.68').length).toBeGreaterThan(0)
 fireEvent.change(screen.getByLabelText('Persona 1'),{target:{value:'0'}})
 expect(screen.getByRole('alert').textContent).toContain('positivos')
 expect(screen.getByText('—')).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Quitar persona 1'}))
 expect(screen.getByLabelText('Persona 1')).toHaveProperty('value','40')
 expect(screen.getByText('$720.68')).toBeTruthy()
})

test('each part uses the existing reservation/payment flow and moves on only after confirmation',async()=>{
 let current=initial,quote:CheckoutAttempt
 let releasePayment:()=>void=()=>{}
 let delayPayment=true
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 vi.mocked(request.execute).mockImplementation(async command=>{
  if(command.command==='prepare_checkout'||command.command==='update_checkout') {
   const totals=command.amountsCents?checkoutAmountTotals(current,command.amountsCents[0]):checkoutTotals(current,command.items)
   quote={id:command.command==='update_checkout'?command.attemptId:crypto.randomUUID(),revision:command.command==='update_checkout'?command.expectedRevision+1:1,kind:'payment',status:'prepared',orderId:current.id,shiftId:'shift',paymentMethod:command.paymentMethod,...totals,amountsCents:command.amountsCents,items:command.amountsCents?checkoutAmountTotals(current,command.amountsCents[0]).items.map(i=>({...i,productId:'product',name:'Consumo',unitPriceCents:76068})):command.items.map(i=>({...i,productId:'product',name:'Consumo',unitPriceCents:76068,...totals})),saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:initial.createdAt,resolvedAt:null,reason:''}
   return quote
  }
  if(command.command==='record_checkout') {
   if(delayPayment) await new Promise<void>(resolve=>{releasePayment=resolve})
   const parts=quote.amountsCents!,slice=quote.items[0]
   current={...current,revision:current.revision+2,phase:'checkout',frozen:true,status:current.balanceCents===quote.totalCents?'closed':'open',paidCents:current.paidCents+quote.totalCents,balanceCents:current.balanceCents-quote.totalCents,amountSplit:true,amountPaidParts:(current.amountPaidParts??0)+1,amountParts:parts.slice(1),items:current.items.map(line=>({...line,paidTotalCents:line.paidTotalCents!+quote.totalCents,paidQuantity:line.paidQuantity+slice.quantity}))}
   return {order:current,attempt:{...quote,status:'completed',saleId:'sale'}}
  }
  throw new Error(`Unexpected ${command.command}`)
 })
 vi.mocked(posRequest).mockImplementation(async()=>quote)
 function Harness(){const [order,setOrder]=useState(initial);return <OrderDetail checkoutView order={order} business={business} methods={['cash','transfer']} attempts={[]} mutation={request} onSaved={setOrder} onPaymentRecorded={setOrder} onEdit={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} collectionAllowed access={{businessId:'business',operatorToken:'synthetic-memory'}} />}
 render(<Harness />)
 await waitFor(()=>expect(screen.getByRole('button',{name:'Registrar pago'})).toHaveProperty('disabled',false))
 fireEvent.click(screen.getByRole('radio',{name:'Dividir por cantidad'}))
 expect(screen.getByRole('button',{name:'Registrar pago'})).toHaveProperty('disabled',true)
 fireEvent.change(screen.getByLabelText('Persona 1'),{target:{value:'500'}})
 fireEvent.click(screen.getByRole('button',{name:'Añadir persona'}))
 fireEvent.change(screen.getByLabelText('Persona 2'),{target:{value:'40'}})
 await waitFor(()=>expect(request.execute).toHaveBeenLastCalledWith(expect.objectContaining({command:'update_checkout',items:[],amountsCents:[50000,4000,22068]})))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Registrar pago'})).toHaveProperty('disabled',false))
 const pay=screen.getByRole('button',{name:'Registrar pago'})
 fireEvent.click(pay);fireEvent.click(pay)
 expect(vi.mocked(request.execute).mock.calls.filter(([c])=>c.command==='record_checkout')).toHaveLength(1)
 expect(current.balanceCents).toBe(76068)
 expect(screen.getByLabelText('Persona 1')).toHaveProperty('value','500')
 await act(async()=>{delayPayment=false;releasePayment()})
 await waitFor(()=>expect(screen.getByLabelText('Persona 2')).toHaveProperty('value','40.00'))
 expect(current.balanceCents).toBe(26068)
 expect(screen.queryByLabelText('Persona 1')).toBeNull()
 expect(screen.getAllByText('$220.68').length).toBeGreaterThan(0)
 await waitFor(()=>expect(screen.getByRole('button',{name:'Registrar pago'})).toHaveProperty('disabled',false))
 expect(quote.amountsCents).toEqual([4000,22068])
 fireEvent.click(screen.getByRole('button',{name:'Registrar pago'}))
 await waitFor(()=>expect(current.balanceCents).toBe(22068))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Registrar pago'})).toHaveProperty('disabled',false))
 expect(quote.amountsCents).toEqual([22068])
 fireEvent.click(screen.getByRole('button',{name:'Registrar pago'}))
 await waitFor(()=>expect(current.balanceCents).toBe(0))
 expect(current.status).toBe('closed')
 expect(vi.mocked(request.execute).mock.calls.filter(([c])=>c.command==='record_checkout')).toHaveLength(3)
})

function mutation():OperationalMutation {return {execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}}
function amountQuote(order=initial,amountsCents=[50000,4000,22068],method:'cash'|'card_integrated'='cash',revision=1):CheckoutAttempt {
 const totals=checkoutAmountTotals(order,amountsCents[0])
 return {...pointCheckout().checkout,id:'amount-reservation',revision,orderId:order.id,paymentMethod:method,...totals,amountsCents,items:totals.items.map(line=>({...line,productId:'product',name:'Consumo',unitPriceCents:76068}))}
}

test.each(['0','-1','760.68','761','10.001','texto'])('invalid amount %s never updates a reservation or registers money',async(value)=>{
 const request=mutation(),quote=amountQuote()
 render(<OrderDetail checkoutView order={initial} business={business} methods={['cash']} attempts={[quote]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn()} collectionAllowed />)
 const input=screen.getByLabelText('Persona 1')
 const summary=document.querySelector('.checkout-summary'),progress=document.querySelector('.checkout-action-progress')
 input.focus()
 fireEvent.change(input,{target:{value}})
 expect(screen.getByRole('button',{name:'Registrar pago'})).toHaveProperty('disabled',true)
 expect(screen.getByRole('alert').textContent).toContain('positivos')
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,170))})
 expect(request.execute).not.toHaveBeenCalled()
 expect(screen.getByLabelText('Persona 1')).toBe(input)
 expect(document.querySelector('.checkout-summary')).toBe(summary)
 expect(document.querySelector('.checkout-action-progress')).toBe(progress)
 expect(document.activeElement).toBe(input)
})

test('an amount draft does not reserve collection while an account remains in service',async()=>{
 const request=mutation()
 render(<OrderDetail order={initial} business={business} methods={['cash']} attempts={[]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} onStartCheckout={vi.fn()} refresh={vi.fn()} collectionAllowed draft={{orderId:initial.id,split:false,amountSplit:true,amountInputs:['500','40'],quantities:{},method:'cash'}} />)
 expect(screen.queryByRole('radio',{name:'Dividir por cantidad'})).toBeNull()
 expect(screen.queryByLabelText('Persona 1')).toBeNull()
 expect(screen.getByRole('button',{name:'Enviar a cocina'})).toBeTruthy()
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,170))})
 expect(request.execute).not.toHaveBeenCalled()
})

test('closing and reopening a partially paid counter shows its exact remaining amount and recorded VAT',async()=>{
 const taxed={...initial,orderKind:'counter' as const,taxCents:10492,discount:{kind:'fixed' as const,value:500,reason:'Sintético'},grossCents:76568,discountCents:500,items:[{...initial.items[0],unitPriceCents:76568,grossCents:76568,discountCents:500,taxCents:10492,taxBps:1600,taxTreatment:'vat_16' as const}]}
 const first=checkoutAmountTotals(taxed,50000)
 const partial={...taxed,revision:3,frozen:true,paidCents:50000,balanceCents:26068,amountSplit:true,amountParts:[4000,22068],amountPaidParts:1,items:[{...taxed.items[0],paidTotalCents:50000,paidDiscountCents:first.discountCents,paidTaxCents:first.taxCents}]}
 const remaining=checkoutAmountTotals(partial,26068),request=mutation()
 const catalog:CatalogState={products:[],paymentMethods:['cash'],loaded:true,loading:false,error:'',refresh:vi.fn(),upsert:vi.fn(),remove:vi.fn()}
 let quote:CheckoutAttempt
 vi.mocked(request.execute).mockImplementation(async command=>{
  if(command.command!=='prepare_checkout')throw new Error('Only the remaining reservation is allowed')
  quote=amountQuote(partial,command.amountsCents,'cash');return quote
 })
 vi.mocked(posRequest).mockImplementation(async()=>quote)
 function Harness(){const [open,setOpen]=useState(false);return open?<><button onClick={()=>setOpen(false)}>Cerrar cobro sintético</button><OrderDetail checkoutView order={partial} business={business} methods={['cash']} attempts={[]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn()} collectionAllowed access={pointAccess} /></>:<SaleScreen access={pointAccess} employeeId="synthetic" catalog={catalog} onProducts={vi.fn()} onHistory={vi.fn()} savedCounter={partial} onAccount={async()=>setOpen(true)} />}
 render(<Harness />)
 for(let reopen=0;reopen<2;reopen++){
  const summary=within(screen.getByRole('complementary',{name:'Venta actual'}))
  expect(summary.getAllByText('$260.68').length).toBeGreaterThan(0)
  expect(summary.queryByText('$760.68')).toBeNull()
  expect(summary.getByText(money(remaining.taxCents))).toBeTruthy()
  expect(summary.getByText(money(26068-remaining.taxCents))).toBeTruthy()
  fireEvent.click(summary.getByRole('button',{name:'Cobrar'}))
  expect(screen.getByLabelText('Persona 2')).toHaveProperty('value','40.00')
  expect(screen.queryByRole('spinbutton',{name:'Cantidad a cobrar de Consumo'})).toBeNull()
  expect(screen.getByRole('radio',{name:'Dividir cuenta'})).toHaveProperty('disabled',true)
  await waitFor(()=>expect(screen.getByRole('button',{name:'Registrar pago'})).toHaveProperty('disabled',false))
  expect(quote!.amountsCents).toEqual([4000,22068])
  fireEvent.click(screen.getByRole('button',{name:'Cerrar cobro sintético'}))
 }
 expect(request.execute).toHaveBeenCalledTimes(2)
})

test.each(['approved_verified','rejected'] as const)('Tarjeta uses the same amount reservation and handles %s without a manual card payment',async(state)=>{
 const request=mutation(),original=amountQuote(initial,[50000,4000,22068],'card_integrated')
 let current=initial,reservation=original,verified=false
 vi.mocked(request.execute).mockImplementation(async command=>{
  if(command.command!=='prepare_checkout')throw new Error('Point must not register a manual payment')
  reservation=amountQuote(current,command.amountsCents,'card_integrated',reservation.revision+1);return reservation
 })
 vi.mocked(posRequest).mockImplementation(async(_access,command)=>command.command==='order'?current:reservation)
 vi.mocked(pointRequest).mockImplementation(async(_access,command)=>{
  const base=pointCheckout({checkout:reservation,items:reservation.items,totalCents:reservation.totalCents})
  if(command.command==='prepare')return base
  if(command.command==='start')return {...base,state:'processing'}
  if(command.command==='status'){
   if(!verified)return {...base,state:'processing'}
   if(state==='approved_verified')current={...initial,revision:3,frozen:true,paidCents:50000,balanceCents:26068,amountSplit:true,amountParts:[4000,22068],amountPaidParts:1,items:[{...initial.items[0],paidTotalCents:50000}]}
   return {...base,state,saleState:state==='approved_verified'?'materialized':'pending',checkout:{...reservation,status:state==='approved_verified'?'completed':'aborted',revision:reservation.revision+1}}
  }
  throw new Error('Unexpected provider command')
 })
 function Harness(){const [order,setOrder]=useState(initial);return <OrderDetail checkoutView order={order} business={business} methods={['card_integrated']} attempts={[original]} mutation={request} onSaved={setOrder} onPaymentRecorded={setOrder} onEdit={vi.fn()} refresh={vi.fn()} collectionAllowed access={pointAccess} pointSettings={pointSettings()} />}
 render(<Harness />)
 expect(screen.queryByRole('button',{name:'Registrar pago'})).toBeNull()
 const send=await screen.findByRole('button',{name:/^Enviar a terminal/})
 fireEvent.click(send)
 await waitFor(()=>expect(vi.mocked(pointRequest).mock.calls.map(([,command])=>command.command)).toEqual(['prepare','start','status']))
 expect(vi.mocked(pointRequest).mock.calls[0][1]).toMatchObject({checkoutAttemptId:original.id})
 expect(current.balanceCents).toBe(76068)
 expect(screen.getByLabelText('Persona 1')).toHaveProperty('value','500.00')
 expect(screen.getByLabelText('Persona 1')).toHaveProperty('disabled',true)
 verified=true
 fireEvent(window,new Event('focus'))
 fireEvent.click(await screen.findByRole('button',{name:state==='approved_verified'?'Continuar':'Volver a la cuenta'}))
 if(state==='approved_verified'){
  await screen.findByText('Pago registrado · $500.00')
  expect(current.balanceCents).toBe(26068)
  expect(screen.getByLabelText('Persona 2')).toHaveProperty('value','40.00')
 }else{
  await waitFor(()=>expect(screen.getByLabelText('Persona 1')).toHaveProperty('disabled',false))
  expect(current.balanceCents).toBe(76068)
  expect(screen.getByLabelText('Persona 1')).toHaveProperty('value','500.00')
  expect(screen.queryByText('Pago registrado · $500.00')).toBeNull()
 }
 expect(vi.mocked(request.execute).mock.calls.some(([command])=>command.command==='record_checkout')).toBe(false)
})

test('a closed shift and a failed confirmation both keep the amount plan and its unpaid balance',async()=>{
 const request=mutation(),quote=amountQuote(),onPaymentRecorded=vi.fn()
 const props={checkoutView:true,order:initial,business,methods:['cash' as const],attempts:[quote],mutation:request,onSaved:vi.fn(),onPaymentRecorded,onEdit:vi.fn(),refresh:vi.fn()}
 const view=render(<OrderDetail {...props} collectionAllowed={false} />)
 const pay=screen.getByRole('button',{name:'Registrar pago'})
 expect(pay).toHaveProperty('disabled',true)
 fireEvent.click(pay)
 expect(request.execute).not.toHaveBeenCalled()
 view.rerender(<OrderDetail {...props} collectionAllowed />)
 vi.mocked(request.execute).mockRejectedValueOnce(new Error('Respuesta incierta'))
 fireEvent.click(pay)
 await waitFor(()=>expect(pay).toHaveProperty('disabled',false))
 expect(onPaymentRecorded).not.toHaveBeenCalled()
 expect(screen.getByLabelText('Persona 1')).toHaveProperty('value','500.00')
 expect(initial.balanceCents).toBe(76068)
 expect(screen.queryByText('Pago registrado · $500.00')).toBeNull()
})
