// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import OrderDetail from '../../src/features/operations/OrderDetail'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { BusinessContext } from '../../src/lib/contracts'
import { posRequest } from '../../src/lib/pos'
import { checkoutTotals } from '../../src/lib/checkout-selection'
vi.mock('../../src/lib/pos', async original => ({...await original<object>(),posRequest:vi.fn()}))
afterEach(() => {cleanup();vi.resetAllMocks()})
const business={id:'business',name:'Sintético',role:'owner',permissions:[],profile:{paymentMethods:['cash','transfer']}} as unknown as BusinessContext
const order:OperationalOrder={id:'order',revision:1,name:'Cuenta',orderKind:'service',tableId:null,status:'open',phase:'service',frozen:false,createdAt:'2026-10-03T12:00:00Z',updatedAt:'2026-10-03T12:00:00Z',operatorName:'Sintético',items:[{lineId:'line',productId:'product',version:1,name:'Café',kitchenName:'Café',category:'',selectionLabel:'',note:'',quantity:3,paidQuantity:0,sentQuantity:0,unitPriceCents:1001,grossCents:3003,discountCents:2,totalCents:3001,taxCents:414,taxBps:1600,taxTreatment:'vat_16'}],discount:{kind:'fixed',value:2,reason:'Centavos'},grossCents:3003,discountCents:2,totalCents:3001,taxCents:414,paidCents:0,waivedCents:0,cancelledCents:0,balanceCents:3001}

test('a saved account stays in service until its explicit collection action',()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()},onStartCheckout=vi.fn()
 render(<OrderDetail order={order} business={business} methods={['cash']} attempts={[]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} onStartCheckout={onStartCheckout} refresh={vi.fn()} collectionAllowed />)
 expect(screen.queryByRole('button',{name:'Registrar pago'})).toBeNull()
 expect(screen.queryByRole('radio',{name:'Dividir cuenta'})).toBeNull()
 expect(request.execute).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Cobrar $30.01'}))
 expect(onStartCheckout).toHaveBeenCalledOnce()
})

test('an unpaid service account sends its remaining preparation with one guarded action and no reservation',async()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()},onSaved=vi.fn(),onStartCheckout=vi.fn()
 let accept!:(value:OperationalOrder)=>void
 vi.mocked(request.execute).mockImplementationOnce(()=>new Promise(resolve=>{accept=resolve}) as never)
 const partiallySent={...order,items:[{...order.items[0],sentQuantity:1}]},sent={...partiallySent,revision:2,items:[{...order.items[0],sentQuantity:3}]}
 const props={order:partiallySent,business:{...business,profile:{...business.profile,accountsEnabled:false}},methods:['cash' as const],attempts:[],mutation:request,onSaved,onEdit:vi.fn(),onStartCheckout,refresh:vi.fn().mockResolvedValue(undefined),collectionAllowed:false}
 const view=render(<OrderDetail {...props} />)
 const send=screen.getByRole('button',{name:'Enviar a cocina'}) as HTMLButtonElement
 expect(send.disabled).toBe(false)
 expect(send.classList.contains('pos-primary')).toBe(true)
 expect(screen.getByRole('button',{name:'Cobrar $30.01'}).classList.contains('pos-secondary')).toBe(true)
 const summary=screen.getByRole('list')
 fireEvent.click(send);fireEvent.click(send)
 expect(request.execute).toHaveBeenCalledOnce()
 expect(request.execute).toHaveBeenCalledWith({command:'send_order',operationId:expect.any(String),orderId:order.id,expectedRevision:order.revision})
 expect(send.disabled).toBe(true)
 expect(screen.getByRole('list')).toBe(summary)
 expect(onSaved).not.toHaveBeenCalled()
 await act(async()=>accept(sent))
 expect(onSaved).toHaveBeenCalledWith(sent)
 view.rerender(<OrderDetail {...props} order={sent} collectionAllowed />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 expect(screen.getByRole('button',{name:'Cobrar $30.01'}).classList.contains('pos-primary')).toBe(true)
 expect(request.execute).toHaveBeenCalledOnce()
})

test('sending preparation is absent for counter, frozen, finalized and read-only service views',()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 const props={order,business,methods:['cash' as const],attempts:[],mutation:request,onSaved:vi.fn(),onEdit:vi.fn(),onStartCheckout:vi.fn(),refresh:vi.fn(),collectionAllowed:false}
 const view=render(<OrderDetail {...props} serviceAccount={false} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 view.rerender(<OrderDetail {...props} serviceAccount order={{...order,orderKind:'counter'}} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 view.rerender(<OrderDetail {...props} order={{...order,orderKind:null,name:'Mostrador'}} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 view.rerender(<OrderDetail {...props} order={{...order,frozen:true}} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 view.rerender(<OrderDetail {...props} order={{...order,phase:'checkout'}} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 view.rerender(<OrderDetail {...props} business={{...business,role:'cashier',permissions:['catalog.read','sales.create']}} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 view.rerender(<OrderDetail {...props} order={{...order,status:'paid',balanceCents:0,paidCents:order.totalCents}} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 expect(request.execute).not.toHaveBeenCalled()
})

test('adding new units to an already sent service account restores preparation as the primary action',()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 const sent={...order,items:[{...order.items[0],sentQuantity:3}]},props={order:sent,business,methods:['cash' as const],attempts:[],mutation:request,onSaved:vi.fn(),onEdit:vi.fn(),onStartCheckout:vi.fn(),refresh:vi.fn(),collectionAllowed:true}
 const view=render(<OrderDetail {...props} />)
 expect(screen.queryByRole('button',{name:'Enviar a cocina'})).toBeNull()
 const extended={...sent,revision:2,grossCents:4004,totalCents:4002,balanceCents:4002,taxCents:552,items:[{...sent.items[0],quantity:4,grossCents:4004,totalCents:4002,taxCents:552}]}
 view.rerender(<OrderDetail {...props} order={extended} />)
 expect(screen.getByRole('button',{name:'Enviar a cocina'}).classList.contains('pos-primary')).toBe(true)
 expect(screen.getByRole('button',{name:'Cobrar $40.02'}).classList.contains('pos-secondary')).toBe(true)
 expect(request.execute).not.toHaveBeenCalled()
})

test('rapid quantity edits keep their DOM, focus and newest value while a prior reservation is pending',async()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 const makeQuote=(quantity:number,revision:number):CheckoutAttempt=>{
  const items=[{lineId:'line',quantity}],totals=checkoutTotals(order,items)
  return {id:'reservation',revision,kind:'payment',status:'prepared',orderId:order.id,shiftId:'shift',paymentMethod:'cash',...totals,items:[{...order.items[0],quantity,...totals}],saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:order.createdAt,resolvedAt:null,reason:''}
 }
 const initial=makeQuote(1,1)
 let acceptFirst!:(value:CheckoutAttempt)=>void
 vi.mocked(request.execute).mockImplementationOnce(()=>new Promise(resolve=>{acceptFirst=resolve}) as never).mockImplementation(async command=>{
  if(command.command!=='update_checkout')throw new Error('Unexpected command')
  return makeQuote(command.items[0].quantity,command.expectedRevision+1)
 })
 render(<OrderDetail checkoutView order={order} business={business} methods={['cash']} attempts={[initial]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} collectionAllowed />)
 const input=screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement
 const summary=document.querySelector('.checkout-summary'),progress=document.querySelector('.checkout-action-progress')
 input.focus()
 fireEvent.click(screen.getByRole('button',{name:'Añadir Café a este cobro'}))
 await waitFor(()=>expect(request.execute).toHaveBeenCalledOnce())
 fireEvent.click(screen.getByRole('button',{name:'Añadir Café a este cobro'}))
 expect(input.value).toBe('3')
 expect(screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'})).toBe(input)
 expect(document.querySelector('.checkout-summary')).toBe(summary)
 expect(document.querySelector('.checkout-action-progress')).toBe(progress)
 expect(document.activeElement).toBe(input)
 expect(screen.queryByRole('status',{name:'Cargando'})).toBeNull()
 expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(true)
 await act(async()=>acceptFirst(makeQuote(2,2)))
 expect(input.value).toBe('3')
 await waitFor(()=>expect(request.execute).toHaveBeenLastCalledWith(expect.objectContaining({command:'update_checkout',expectedRevision:2,items:[{lineId:'line',quantity:3}]})))
 await waitFor(()=>expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
 expect(input.value).toBe('3')
})

test('automatically reserves and updates selected money while keeping a single final payment action',async()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 let quote:CheckoutAttempt
 vi.mocked(request.execute).mockImplementation(async command => {
  if(command.command!=='prepare_checkout' && command.command!=='update_checkout') throw new Error('Unexpected command')
  const totals=checkoutTotals(order,command.items)
  quote={id:'reservation',revision:command.command==='prepare_checkout'?1:command.expectedRevision+1,kind:'payment',status:'prepared',orderId:order.id,shiftId:'shift',paymentMethod:command.paymentMethod,...totals,items:command.items.map(i=>({...i,productId:'product',name:'Café',unitPriceCents:1001,discountCents:totals.discountCents,totalCents:totals.totalCents,taxCents:totals.taxCents})),saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:order.createdAt,resolvedAt:null,reason:''}
  return quote
 })
 vi.mocked(posRequest).mockImplementation(async()=>quote)
 const onPaymentRecorded=vi.fn()
 render(<OrderDetail checkoutView order={order} business={business} methods={['cash','transfer']} attempts={[]} mutation={request} onSaved={vi.fn()} onPaymentRecorded={onPaymentRecorded} onEdit={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} collectionAllowed access={{businessId:'business',operatorToken:'synthetic-memory-only'}} />)
 await waitFor(()=>expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
 expect(screen.getAllByText('$30.01').length).toBeGreaterThanOrEqual(2)
 fireEvent.click(screen.getByRole('radio',{name:'Dividir cuenta'}))
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('0')
 expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(true)
 fireEvent.change(screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}),{target:{value:'1'}})
 await waitFor(()=>expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
 expect(screen.getAllByText('$10.01').length).toBeGreaterThanOrEqual(2)
 expect(screen.getByRole('list').textContent).toContain('$10.01')
 expect(screen.getByRole('list').textContent).not.toContain('$30.01')
 expect(screen.getByText('Queda pendiente').parentElement?.textContent).toContain('$20.00')
 expect(screen.getByText('$1.38')).toBeTruthy()
 expect(request.execute).toHaveBeenLastCalledWith(expect.objectContaining({command:'update_checkout',attemptId:'reservation',items:[{lineId:'line',quantity:1}]}))
 fireEvent.click(screen.getByRole('radio',{name:'Transferencia'}))
 await waitFor(()=>expect(request.execute).toHaveBeenLastCalledWith(expect.objectContaining({command:'update_checkout',paymentMethod:'transfer'})))
 await waitFor(()=>expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
 vi.mocked(request.execute).mockResolvedValueOnce({order:{...order,frozen:true,paidCents:1001,balanceCents:2000},attempt:{...quote!,status:'completed'}})
 fireEvent.click(screen.getByRole('button',{name:'Registrar pago'}))
 await waitFor(()=>expect(onPaymentRecorded).toHaveBeenCalledOnce())
 expect(request.execute).toHaveBeenLastCalledWith(expect.objectContaining({command:'record_checkout',attemptId:'reservation',confirmed:true}))
 expect(vi.mocked(request.execute).mock.calls.filter(([command])=>command.command==='prepare_checkout')).toHaveLength(1)
})

test('a closed shift allows selecting articles but never reserves or suggests receiving money',()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 const onOpenCash=vi.fn()
 render(<OrderDetail checkoutView order={order} business={business} methods={['cash']} attempts={[]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} collectionAllowed={false} onOpenCash={onOpenCash} />)
 fireEvent.click(screen.getByRole('radio',{name:'Dividir cuenta'}))
 fireEvent.click(screen.getByRole('button',{name:'Añadir Café a este cobro'}))
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('1')
 expect(screen.getByText('Queda pendiente').parentElement?.textContent).toContain('$20.00')
 expect(screen.queryByText('Reservando el cobro…')).toBeNull()
 expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(true)
 expect(request.execute).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'Ir a Caja'}))
 expect(onOpenCash).toHaveBeenCalledOnce()
})

test('opening or refreshing a recovered split never silently changes its amount or payment method',async()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 const items=[{lineId:'line',productId:'product',name:'Café',quantity:1,unitPriceCents:1001,totalCents:1001,discountCents:0,taxCents:138}]
 const quote:CheckoutAttempt={id:'recovered',revision:1,kind:'payment',status:'prepared',orderId:order.id,shiftId:'shift',paymentMethod:'transfer',totalCents:1001,discountCents:0,taxCents:138,items,saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:order.createdAt,resolvedAt:null,reason:''}
 const props={checkoutView:true,order,business,methods:['cash' as const,'transfer' as const],mutation:request,onSaved:vi.fn(),onEdit:vi.fn(),refresh:vi.fn().mockResolvedValue(undefined),collectionAllowed:true,access:{businessId:'business',operatorToken:'synthetic-memory-only'}}
 const view=render(<OrderDetail {...props} attempts={[quote]} />)
 expect((screen.getByRole('radio',{name:'Transferencia'}) as HTMLInputElement).checked).toBe(true)
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('1')
 expect(request.execute).not.toHaveBeenCalled()
 const next={...quote,id:'recovered-next',paymentMethod:'cash' as const,items:[{...items[0],quantity:2}],totalCents:2001,discountCents:1,taxCents:276}
 view.rerender(<OrderDetail {...props} attempts={[next]} />)
 await waitFor(()=>expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('2'))
 expect((screen.getByRole('radio',{name:'Efectivo'}) as HTMLInputElement).checked).toBe(true)
 expect(request.execute).not.toHaveBeenCalled()
 vi.mocked(posRequest).mockResolvedValue({...next,status:'completed',revision:3})
 view.rerender(<OrderDetail {...props} order={{...order,status:'paid',frozen:true,paidCents:3001,balanceCents:0,items:[{...order.items[0],paidQuantity:3}]}} attempts={[]} />)
 expect(await screen.findByText(/Pago registrado/)).toBeTruthy()
})

test('an accepted partial payment recovered by exact retry resets the next selection without leaving checkout',async()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 const totals=checkoutTotals(order,[{lineId:'line',quantity:1}])
 const quote:CheckoutAttempt={id:'retry-reservation',revision:1,kind:'payment',status:'prepared',orderId:order.id,shiftId:'shift',paymentMethod:'transfer',...totals,items:[{lineId:'line',productId:'product',name:'Café',quantity:1,unitPriceCents:1001,...totals}],saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:order.createdAt,resolvedAt:null,reason:''}
 const props={checkoutView:true,order,business,methods:['cash' as const,'transfer' as const],mutation:request,onSaved:vi.fn(),onPaymentRecorded:vi.fn(),onEdit:vi.fn(),refresh:vi.fn().mockResolvedValue(undefined),collectionAllowed:true,access:{businessId:'business',operatorToken:'synthetic-memory-only'}}
 const view=render(<OrderDetail {...props} attempts={[quote]} />)
 vi.mocked(request.execute).mockRejectedValueOnce(new Error('Respuesta perdida'))
 fireEvent.click(screen.getByRole('button',{name:'Registrar pago'}))
 await waitFor(()=>expect(request.execute).toHaveBeenCalledOnce())
 const pending=vi.mocked(request.execute).mock.calls[0][0]
 view.rerender(<OrderDetail {...props} mutation={{...request,pending,error:'Respuesta perdida'}} attempts={[quote]} />)
 expect(props.onPaymentRecorded).not.toHaveBeenCalled()
 const partial:OperationalOrder={...order,revision:3,phase:'checkout',frozen:true,paidCents:totals.totalCents,balanceCents:order.balanceCents-totals.totalCents,items:order.items.map(line=>({...line,paidQuantity:1}))}
 const completed:CheckoutAttempt={...quote,revision:3,status:'completed'}
 vi.mocked(posRequest).mockResolvedValue(completed)
 view.rerender(<OrderDetail {...props} order={partial} mutation={{...request,lastResult:{command:'record_checkout',result:{order:partial,attempt:completed}}}} attempts={[]} />)
 await waitFor(()=>expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('0'))
 expect((screen.getByRole('radio',{name:'Dividir cuenta'}) as HTMLInputElement).checked).toBe(true)
 expect((screen.getByRole('radio',{name:'Transferencia'}) as HTMLInputElement).checked).toBe(true)
 expect(screen.getByText('Pago registrado · $10.01')).toBeTruthy()
 expect((screen.getByRole('button',{name:'Añadir Café a este cobro'}) as HTMLButtonElement).disabled).toBe(false)
 expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(true)
 expect(screen.queryByRole('button',{name:'Continuar con la cuenta'})).toBeNull()
 expect(request.execute).toHaveBeenCalledOnce()
})

test('a delayed first reservation preserves quantity and method edits made while it was pending',async()=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 let complete!: (quote:CheckoutAttempt)=>void
 let quote:CheckoutAttempt
 function accepted(items:{lineId:string;quantity:number}[],paymentMethod:CheckoutAttempt['paymentMethod'],revision:number):CheckoutAttempt {
  const totals=checkoutTotals(order,items)
  return {id:'slow-reservation',revision,kind:'payment',status:'prepared',orderId:order.id,shiftId:'shift',paymentMethod,...totals,items:items.map(item=>({...item,productId:'product',name:'Café',unitPriceCents:1001,...totals})),saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:order.createdAt,resolvedAt:null,reason:''}
 }
 vi.mocked(request.execute).mockImplementation(command=>{
  if(command.command==='prepare_checkout') return new Promise<CheckoutAttempt>(resolve=>{complete=resolve}) as never
  if(command.command!=='update_checkout') throw new Error('Unexpected command')
  quote=accepted(command.items,command.paymentMethod,command.expectedRevision+1)
  return Promise.resolve(quote) as never
 })
 vi.mocked(posRequest).mockImplementation(async()=>quote)
 const props={checkoutView:true,order,business,methods:['cash' as const,'transfer' as const],mutation:request,onSaved:vi.fn(),onEdit:vi.fn(),refresh:vi.fn().mockResolvedValue(undefined),collectionAllowed:true,access:{businessId:'business',operatorToken:'synthetic-memory-only'}}
 const view=render(<OrderDetail {...props} attempts={[]} />)
 await waitFor(()=>expect(request.execute).toHaveBeenCalledOnce())
 const pending=vi.mocked(request.execute).mock.calls[0][0]
 view.rerender(<OrderDetail {...props} mutation={{...request,busy:true,pending}} attempts={[]} />)
 fireEvent.click(screen.getByRole('radio',{name:'Dividir cuenta'}))
 fireEvent.click(screen.getByRole('button',{name:'Añadir Café a este cobro'}))
 fireEvent.click(screen.getByRole('button',{name:'Añadir Café a este cobro'}))
 fireEvent.click(screen.getByRole('radio',{name:'Transferencia'}))
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('2')
 quote=accepted([{lineId:'line',quantity:3}],'cash',1)
 await act(async()=>complete(quote))
 view.rerender(<OrderDetail {...props} mutation={{...request,lastResult:{command:'prepare_checkout',result:quote}}} attempts={[quote]} />)
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('2')
 expect((screen.getByRole('radio',{name:'Transferencia'}) as HTMLInputElement).checked).toBe(true)
 expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(true)
 await waitFor(()=>expect(request.execute).toHaveBeenLastCalledWith(expect.objectContaining({command:'update_checkout',attemptId:'slow-reservation',expectedRevision:1,paymentMethod:'transfer',items:[{lineId:'line',quantity:2}]})))
 await waitFor(()=>expect((screen.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
 expect(vi.mocked(request.execute).mock.calls.filter(([command])=>command.command==='prepare_checkout')).toHaveLength(1)
})

test('reopening checkout preserves the next split draft when the last payment result is historical',()=>{
 const totals=checkoutTotals(order,[{lineId:'line',quantity:1}])
 const partial:OperationalOrder={...order,revision:3,phase:'checkout',frozen:true,paidCents:totals.totalCents,balanceCents:order.balanceCents-totals.totalCents,items:order.items.map(line=>({...line,paidQuantity:1}))}
 const completed:CheckoutAttempt={id:'historical-payment',revision:3,kind:'payment',status:'completed',orderId:order.id,shiftId:'shift',paymentMethod:'transfer',...totals,items:[{lineId:'line',productId:'product',name:'Café',quantity:1,unitPriceCents:1001,...totals}],saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:order.createdAt,resolvedAt:null,reason:''}
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:{command:'record_checkout',result:{order:partial,attempt:completed}},clearNotice:vi.fn()}
 render(<OrderDetail checkoutView order={partial} business={business} methods={['cash','transfer']} attempts={[]} mutation={request} draft={{orderId:partial.id,split:true,quantities:{line:1},method:'cash'}} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} collectionAllowed={false} />)
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('1')
 expect((screen.getByRole('radio',{name:'Dividir cuenta'}) as HTMLInputElement).checked).toBe(true)
 expect((screen.getByRole('radio',{name:'Efectivo'}) as HTMLInputElement).checked).toBe(true)
 expect(screen.queryByText('Pago registrado · $10.01')).toBeNull()
 expect(screen.queryByRole('button',{name:'Continuar con la cuenta'})).toBeNull()
 expect(request.execute).not.toHaveBeenCalled()
})

test.each(['completed','aborted'] as const)('continuing after a remote %s payment preserves split mode and ignores its stale snapshot',async status=>{
 const request:OperationalMutation={execute:vi.fn(),busy:false,pending:null,error:'',notice:'',lastResult:null,clearNotice:vi.fn()}
 const totals=checkoutTotals(order,[{lineId:'line',quantity:1}])
 const quote:CheckoutAttempt={id:'externally-completed',revision:1,kind:'payment',status:'prepared',orderId:order.id,shiftId:'shift',paymentMethod:'transfer',...totals,items:[{lineId:'line',productId:'product',name:'Café',quantity:1,unitPriceCents:1001,...totals}],saleId:null,originalSaleId:null,operatorName:'Sintético',resolverName:null,createdAt:order.createdAt,resolvedAt:null,reason:''}
 const props={checkoutView:true,order,business,methods:['cash' as const,'transfer' as const],mutation:request,onSaved:vi.fn(),onEdit:vi.fn(),refresh:vi.fn().mockResolvedValue(undefined),collectionAllowed:false,access:{businessId:'business',operatorToken:'synthetic-memory-only'}}
 const view=render(<OrderDetail {...props} attempts={[quote]} />)
 const partial:OperationalOrder=status==='completed'
  ? {...order,revision:3,phase:'checkout',frozen:true,paidCents:totals.totalCents,balanceCents:order.balanceCents-totals.totalCents,items:order.items.map(line=>({...line,paidQuantity:1}))}
  : {...order,revision:3,phase:'service'}
 vi.mocked(posRequest).mockResolvedValue({...quote,revision:3,status})
 view.rerender(<OrderDetail {...props} order={partial} attempts={[]} />)
 fireEvent.click(await screen.findByRole('button',{name:'Continuar con la cuenta'}))
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Continuar con la cuenta'})).toBeNull())
 expect((screen.getByRole('radio',{name:'Dividir cuenta'}) as HTMLInputElement).checked).toBe(true)
 expect((screen.getByRole('radio',{name:'Transferencia'}) as HTMLInputElement).checked).toBe(true)
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('0')
 view.rerender(<OrderDetail {...props} order={partial} attempts={[quote]} />)
 expect((screen.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('0')
 expect((screen.getByRole('button',{name:'Añadir Café a este cobro'}) as HTMLButtonElement).disabled).toBe(false)
 expect(screen.queryByRole('button',{name:'Continuar con la cuenta'})).toBeNull()
 expect(request.execute).not.toHaveBeenCalled()
})
