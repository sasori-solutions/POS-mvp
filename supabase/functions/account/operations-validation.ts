import type { OperationsCommand, OrderInputLine } from '../../../src/lib/operations-contracts.ts'
import type { PaymentMethod } from '../../../src/lib/contracts.ts'
import { parseSelection } from './product-validation.ts'
import { isUuid, RequestValidationError } from './validation.ts'

const commands = new Set(['operations','activate_operations','shifts','open_shift','cash_movement','begin_shift_close','abort_shift_close','close_shift','orders','order','save_order','set_order_discount','cancel_order','send_order','begin_order_checkout','resume_order_service','kitchen','set_kitchen_status','tables','save_table','move_order','close_order','update_checkout','record_checkout','record_payment','prepare_checkout','attempt','start_checkout','mark_checkout_uncertain','resolve_checkout','prepare_reversal','prepare_waiver','confirm_waiver','report','report_period','report_own_period'])
function invalid(): never { throw new RequestValidationError() }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) invalid() }
function uuid(value: unknown): string { if (!isUuid(value)) invalid(); return value }
function integer(value: unknown, max = 2_147_483_647, min = 1): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(); return value }
function text(value: unknown, max: number, min = 0): string { if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) invalid(); const clean=value.trim().replace(/\s+/g,' '); if (Array.from(clean).length < min || Array.from(clean).length > max) invalid(); return clean }
function payment(value: unknown): PaymentMethod { if (!['cash','card_external','transfer','card_integrated'].includes(value as string)) invalid(); return value as PaymentMethod }

function reportDate(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value || value < '2000-01-01' || value > '2100-12-31') invalid()
  return value
}

export function parseOperationsCommand(input: Record<string, unknown>, accessKeys: string[]): OperationsCommand | null {
  if (!commands.has(input.command as string)) return null
  const command=input.command as OperationsCommand['command']
  const keys=(extra: string[]) => exact(input,[...accessKeys,'command',...extra])
  const op=() => uuid(input.operationId)
  const revision=() => integer(input.expectedRevision)
  const order=() => uuid(input.orderId)
  const shift=() => uuid(input.shiftId)
  const attempt=() => uuid(input.attemptId)
  switch(command) {
    case 'operations': case 'shifts': case 'orders': case 'kitchen': case 'tables': keys([]); return {command}
    case 'activate_operations': keys(['operationId']); return {command,operationId:op()}
    case 'open_shift': keys(['operationId','openingCents']); return {command,operationId:op(),openingCents:integer(input.openingCents,9_999_999_999,0)}
    case 'begin_shift_close': case 'abort_shift_close': keys(['operationId','shiftId','expectedRevision']); return {command,operationId:op(),shiftId:shift(),expectedRevision:revision()}
    case 'close_shift': keys(['operationId','shiftId','expectedRevision','countedCents']); return {command,operationId:op(),shiftId:shift(),expectedRevision:revision(),countedCents:integer(input.countedCents,9_999_999_999,0)}
    case 'cash_movement': keys(['operationId','shiftId','expectedRevision','kind','amountCents','reason']); if (input.kind!=='in' && input.kind!=='out') invalid(); return {command,operationId:op(),shiftId:shift(),expectedRevision:revision(),kind:input.kind,amountCents:integer(input.amountCents,9_999_999_999),reason:text(input.reason,200,1)}
    case 'order': keys(['orderId']); return {command,orderId:order()}
    case 'save_order': {
      const hasKind = Object.hasOwn(input, 'orderKind')
      keys(['operationId','orderId','expectedRevision','name','tableId','items',...(hasKind?['orderKind']:[])])
      if (hasKind && input.orderKind !== 'counter' && input.orderKind !== 'service') invalid()
      if (input.orderKind === 'counter' && input.tableId !== null) invalid()
      if (!Array.isArray(input.items) || (input.items.length===0 && input.expectedRevision===null) || input.items.length>40) invalid()
      const items: OrderInputLine[]=input.items.map(value => {
        const line=object(value); exact(line,['lineId','productId','quantity','unitPriceCents','version','note',...(Object.hasOwn(line,'selection')?['selection']:[])])
        return {lineId:uuid(line.lineId),productId:uuid(line.productId),quantity:integer(line.quantity,999),unitPriceCents:integer(line.unitPriceCents,99_999_999,0),version:integer(line.version),note:text(line.note,160),...(Object.hasOwn(line,'selection')?{selection:parseSelection(line.selection)}:{})}
      }).sort((a,b)=>a.lineId.localeCompare(b.lineId))
      if (new Set(items.map(i=>i.lineId)).size!==items.length) invalid()
      if (items.reduce((sum,i)=>sum+i.quantity*i.unitPriceCents,0)>9_999_999_999) invalid()
      return {command,operationId:op(),orderId:order(),expectedRevision:input.expectedRevision===null?null:revision(),name:text(input.name,100,1),tableId:input.tableId===null?null:uuid(input.tableId),items,...(hasKind?{orderKind:input.orderKind as 'counter'|'service'}:{})}
    }
    case 'set_order_discount': {
      keys(['operationId','orderId','expectedRevision','discount'])
      if (input.discount===null) return {command,operationId:op(),orderId:order(),expectedRevision:revision(),discount:null}
      const discount=object(input.discount); exact(discount,['kind','value','reason'])
      if (discount.kind!=='fixed' && discount.kind!=='percent') invalid()
      return {command,operationId:op(),orderId:order(),expectedRevision:revision(),discount:{kind:discount.kind,value:integer(discount.value,discount.kind==='fixed'?9_999_999_999:10000,0),reason:text(discount.reason,200,1)}}
    }
    case 'send_order': case 'close_order': case 'begin_order_checkout': case 'resume_order_service': keys(['operationId','orderId','expectedRevision']); return {command,operationId:op(),orderId:order(),expectedRevision:revision()}
    case 'cancel_order': case 'prepare_waiver': keys(['operationId','orderId','expectedRevision','reason']); return {command,operationId:op(),orderId:order(),expectedRevision:revision(),reason:text(input.reason,200,1)}
    case 'set_kitchen_status': keys(['operationId','batchId','expectedRevision','status']); if (!['preparing','ready','delivered'].includes(input.status as string)) invalid(); return {command,operationId:op(),batchId:uuid(input.batchId),expectedRevision:revision(),status:input.status as 'preparing'|'ready'|'delivered'}
    case 'save_table': keys(['operationId','tableId','expectedRevision','name','active']); if (typeof input.active!=='boolean') invalid(); return {command,operationId:op(),tableId:uuid(input.tableId),expectedRevision:input.expectedRevision===null?null:revision(),name:text(input.name,60,1),active:input.active}
    case 'move_order': keys(['operationId','orderId','expectedRevision','tableId']); return {command,operationId:op(),orderId:order(),expectedRevision:revision(),tableId:input.tableId===null?null:uuid(input.tableId)}
    case 'prepare_checkout': case 'record_payment': case 'update_checkout': {
      keys(['operationId',command==='update_checkout'?'attemptId':'orderId','expectedRevision','items','paymentMethod',...(command==='record_payment'?['confirmed']:[]),...(Object.hasOwn(input,'amountsCents')?['amountsCents']:[])])
      if (command==='record_payment' && input.confirmed!==true) invalid()
      if (command==='record_payment' && input.paymentMethod==='card_integrated') invalid()
      if (Object.hasOwn(input,'amountsCents')) {
        if (command==='record_payment' || !Array.isArray(input.items) || input.items.length!==0 || !Array.isArray(input.amountsCents) || input.amountsCents.length<1 || input.amountsCents.length>20) invalid()
        const amountsCents=input.amountsCents.map(amount=>integer(amount,9_999_999_999))
        if (amountsCents.reduce((sum,amount)=>sum+amount,0)>9_999_999_999) invalid()
        return command==='update_checkout'
          ? {command,operationId:op(),attemptId:attempt(),expectedRevision:revision(),items:[],amountsCents,paymentMethod:payment(input.paymentMethod)}
          : {command,operationId:op(),orderId:order(),expectedRevision:revision(),items:[],amountsCents,paymentMethod:payment(input.paymentMethod)}
      }
      if (!Array.isArray(input.items) || input.items.length<1 || input.items.length>40) invalid()
      const items=input.items.map(value=>{const line=object(value);exact(line,['lineId','quantity']);return {lineId:uuid(line.lineId),quantity:integer(line.quantity,999)}}).sort((a,b)=>a.lineId.localeCompare(b.lineId))
      if (new Set(items.map(i=>i.lineId)).size!==items.length) invalid()
      if (command==='update_checkout') return {command,operationId:op(),attemptId:attempt(),expectedRevision:revision(),items,paymentMethod:payment(input.paymentMethod)}
      const fields={operationId:op(),orderId:order(),expectedRevision:revision(),items,paymentMethod:payment(input.paymentMethod)}
      return command==='record_payment'?{command,...fields,confirmed:true}:{command,...fields}
    }
    case 'record_checkout': keys(['operationId','attemptId','expectedRevision','confirmed']); if (input.confirmed!==true) invalid(); return {command,operationId:op(),attemptId:attempt(),expectedRevision:revision(),confirmed:true}
    case 'attempt': keys(['attemptId']); return {command,attemptId:attempt()}
    case 'start_checkout': case 'mark_checkout_uncertain': keys(['operationId','attemptId','expectedRevision']); return {command,operationId:op(),attemptId:attempt(),expectedRevision:revision()}
    case 'resolve_checkout': keys(['operationId','attemptId','expectedRevision','resolution','confirmed','reason']); if ((input.resolution!=='complete'&&input.resolution!=='abort')||input.confirmed!==true) invalid(); return {command,operationId:op(),attemptId:attempt(),expectedRevision:revision(),resolution:input.resolution,confirmed:true,reason:text(input.reason,200,1)}
    case 'prepare_reversal': keys(['operationId','saleId','reason']); return {command,operationId:op(),saleId:uuid(input.saleId),reason:text(input.reason,200,1)}
    case 'confirm_waiver': keys(['operationId','waiverId','expectedRevision','confirmed']); if (input.confirmed!==true) invalid(); return {command,operationId:op(),waiverId:uuid(input.waiverId),expectedRevision:revision(),confirmed:true}
    case 'report': keys(['date']); if (typeof input.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.date)||!Number.isFinite(Date.parse(`${input.date}T00:00:00Z`))||new Date(`${input.date}T00:00:00Z`).toISOString().slice(0,10)!==input.date) invalid(); return {command,date:input.date}
    case 'report_period': case 'report_own_period': keys(['date','period']); if (input.period !== 'day' && input.period !== 'week' && input.period !== 'month') invalid(); return {command,date:reportDate(input.date),period:input.period}
  }
}
