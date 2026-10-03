import type { PaymentMethod } from './contracts.ts'
import type { ItemSelection, SaleInputLine, VatTreatment } from './pos-contracts.ts'

export type ShiftStatus = 'open' | 'closing' | 'closed'
export interface CashMovement { id: string; kind: 'in' | 'out'; amountCents: number; reason: string; actorName: string; createdAt: string }
export interface CashShift {
  id: string; revision: number; status: ShiftStatus; openedAt: string; closedAt: string | null
  openedBy: string; closedBy: string | null; openingCents: number
  countedCents: number | null; expectedCents: number | null; differenceCents: number | null
  movements: CashMovement[]
}
export interface DiningTable { id: string; name: string; active: boolean; revision: number; orderId: string | null }
export interface OrderInputLine extends SaleInputLine { lineId: string; note: string }
export interface OrderLine {
  version: number; selection?: ItemSelection | null
  lineId: string; productId: string; name: string; kitchenName: string; category: string; selectionLabel: string; note: string
  quantity: number; paidQuantity: number; sentQuantity: number; unitPriceCents: number
  grossCents: number; discountCents: number; totalCents: number; taxCents: number; taxBps: number; taxTreatment: VatTreatment | 'legacy'
}
export interface OrderDiscount { kind: 'fixed' | 'percent'; value: number; reason: string }
export interface OperationalOrder {
  id: string; revision: number; name: string; tableId: string | null
  status: 'open' | 'paid' | 'cancelled' | 'waived' | 'closed'; createdAt: string; updatedAt: string
  operatorName: string; phase: 'service' | 'checkout'; frozen: boolean; items: OrderLine[]; discount: OrderDiscount | null
  grossCents: number; discountCents: number; totalCents: number; taxCents: number; paidCents: number; waivedCents: number; cancelledCents: number; balanceCents: number
}
export interface KitchenBatch {
  id: string; orderId: string; orderName: string; tableName: string | null; createdAt: string
  revision: number; status: 'queued' | 'preparing' | 'ready' | 'delivered'; kind: 'items' | 'cancellation'
  reason: string; fullyCancelled: boolean; items: { lineId: string; name: string; selectionLabel: string; note: string; quantity: number; cancelledQuantity?: number }[]
}
export type AttemptStatus = 'prepared' | 'collection_started' | 'completed' | 'aborted' | 'uncertain'
export interface CheckoutSelection { lineId: string; quantity: number }
export interface CheckoutAttempt {
  id: string; revision: number; kind: 'payment' | 'reversal'; status: AttemptStatus; orderId: string | null; shiftId: string
  saleId: string | null; originalSaleId: string | null; paymentMethod: PaymentMethod; totalCents: number
  taxCents: number; discountCents: number; operatorName: string; resolverName: string | null
  createdAt: string; resolvedAt: string | null; reason: string
  items: { lineId: string; productId: string; name: string; quantity: number; unitPriceCents: number; discountCents: number; totalCents: number; taxCents: number }[]
}
export interface BalanceWaiver { id: string; orderId: string; revision: number; status: 'prepared' | 'completed'; amountCents: number; reason: string; operatorName: string; resolvedAt: string | null }
export interface BusinessDayReport {
  date: string; timezone: string; grossCents: number; discountCents: number; salesCents: number; taxCents: number
  reversalCents: number; reversalTaxCents: number; netCents: number; waivedCents: number; saleCount: number
  payments: { paymentMethod: PaymentMethod; salesCents: number; reversalCents: number; netCents: number }[]
  operators: { name: string; salesCents: number; reversalCents: number; netCents: number }[]
  products: { productId: string; name: string; quantity: number; salesCents: number; taxCents: number; reversalQuantity: number; reversalCents: number; reversalTaxCents: number; netCents: number; netTaxCents: number }[]
  cashDifferences: { shiftId: string; closedAt: string; expectedCents: number; countedCents: number; differenceCents: number }[]
}
export interface OperationsSnapshot { enabled: boolean; shift: CashShift | null; orders: OperationalOrder[]; tables: DiningTable[]; attempts: CheckoutAttempt[]; pendingKitchenCount?: number }

export type ReportPeriod = 'day' | 'week' | 'month'
export interface BusinessPeriodReport {
  period: ReportPeriod; startDate: string; endDate: string; timezone: string; partial: boolean
  comparisonStartDate: string; comparisonEndDate: string; comparisonComparable: boolean; asOf: string
  totals: BusinessDayReport; previous: BusinessDayReport
  series: { start: string; label: string; salesCents: number; future: boolean }[]
}

export type OperationsCommand =
  | { command: 'operations' }
  | { command: 'activate_operations'; operationId: string }
  | { command: 'shifts' }
  | { command: 'open_shift'; operationId: string; openingCents: number }
  | { command: 'cash_movement'; operationId: string; shiftId: string; expectedRevision: number; kind: 'in' | 'out'; amountCents: number; reason: string }
  | { command: 'begin_shift_close'; operationId: string; shiftId: string; expectedRevision: number }
  | { command: 'abort_shift_close'; operationId: string; shiftId: string; expectedRevision: number }
  | { command: 'close_shift'; operationId: string; shiftId: string; expectedRevision: number; countedCents: number }
  | { command: 'orders' }
  | { command: 'order'; orderId: string }
  | { command: 'save_order'; operationId: string; orderId: string; expectedRevision: number | null; name: string; tableId: string | null; items: OrderInputLine[] }
  | { command: 'set_order_discount'; operationId: string; orderId: string; expectedRevision: number; discount: OrderDiscount | null }
  | { command: 'cancel_order'; operationId: string; orderId: string; expectedRevision: number; reason: string }
  | { command: 'send_order'; operationId: string; orderId: string; expectedRevision: number }
  | { command: 'begin_order_checkout'; operationId: string; orderId: string; expectedRevision: number }
  | { command: 'resume_order_service'; operationId: string; orderId: string; expectedRevision: number }
  | { command: 'kitchen' }
  | { command: 'set_kitchen_status'; operationId: string; batchId: string; expectedRevision: number; status: 'preparing' | 'ready' | 'delivered' }
  | { command: 'tables' }
  | { command: 'save_table'; operationId: string; tableId: string; expectedRevision: number | null; name: string; active: boolean }
  | { command: 'move_order'; operationId: string; orderId: string; expectedRevision: number; tableId: string | null }
  | { command: 'close_order'; operationId: string; orderId: string; expectedRevision: number }
  | { command: 'prepare_checkout'; operationId: string; orderId: string; expectedRevision: number; items: CheckoutSelection[]; paymentMethod: PaymentMethod }
  | { command: 'update_checkout'; operationId: string; attemptId: string; expectedRevision: number; items: CheckoutSelection[]; paymentMethod: PaymentMethod }
  | { command: 'record_checkout'; operationId: string; attemptId: string; expectedRevision: number; confirmed: true }
  | { command: 'record_payment'; operationId: string; orderId: string; expectedRevision: number; items: CheckoutSelection[]; paymentMethod: PaymentMethod; confirmed: true }
  | { command: 'attempt'; attemptId: string }
  | { command: 'start_checkout'; operationId: string; attemptId: string; expectedRevision: number }
  | { command: 'mark_checkout_uncertain'; operationId: string; attemptId: string; expectedRevision: number }
  | { command: 'resolve_checkout'; operationId: string; attemptId: string; expectedRevision: number; resolution: 'complete' | 'abort'; confirmed: true; reason: string }
  | { command: 'prepare_reversal'; operationId: string; saleId: string; reason: string }
  | { command: 'prepare_waiver'; operationId: string; orderId: string; expectedRevision: number; reason: string }
  | { command: 'confirm_waiver'; operationId: string; waiverId: string; expectedRevision: number; confirmed: true }
  | { command: 'report'; date: string }
  | { command: 'report_period'; date: string; period: ReportPeriod }

export interface OperationsResponses {
  update_checkout: CheckoutAttempt
  record_checkout: { order: OperationalOrder; attempt: CheckoutAttempt }
  record_payment: { order: OperationalOrder; attempt: CheckoutAttempt }
  operations: OperationsSnapshot; activate_operations: { enabled: true }
  shifts: { shifts: CashShift[] }; open_shift: CashShift; cash_movement: CashShift
  begin_shift_close: CashShift; abort_shift_close: CashShift; close_shift: CashShift
  orders: { orders: OperationalOrder[] }; order: OperationalOrder; save_order: OperationalOrder
  set_order_discount: OperationalOrder; cancel_order: OperationalOrder; send_order: OperationalOrder; begin_order_checkout: OperationalOrder; resume_order_service: OperationalOrder
  kitchen: { batches: KitchenBatch[] }; set_kitchen_status: KitchenBatch
  tables: { tables: DiningTable[] }; save_table: DiningTable; move_order: OperationalOrder; close_order: OperationalOrder
  prepare_checkout: CheckoutAttempt; attempt: CheckoutAttempt; start_checkout: CheckoutAttempt; mark_checkout_uncertain: CheckoutAttempt
  resolve_checkout: CheckoutAttempt; prepare_reversal: CheckoutAttempt
  prepare_waiver: BalanceWaiver; confirm_waiver: BalanceWaiver; report: BusinessDayReport
  report_period: BusinessPeriodReport
}
export type OperationsErrorCode = 'OPERATIONS_DISABLED' | 'LEGACY_CHECKOUT_DISABLED' | 'SHIFT_REQUIRED' | 'SHIFT_CHANGED' | 'SHIFT_NOT_OPEN' | 'SHIFT_ALREADY_OPEN'
  | 'PENDING_COLLECTION' | 'ORDER_CHANGED' | 'ORDER_NOT_FOUND' | 'ORDER_LOCKED' | 'ORDER_HAS_PAYMENTS'
  | 'ATTEMPT_NOT_FOUND' | 'ATTEMPT_CHANGED' | 'ATTEMPT_STATE_INVALID' | 'TABLE_CHANGED' | 'TABLE_OCCUPIED'
  | 'BATCH_CHANGED' | 'WAIVER_CHANGED' | 'SALE_ALREADY_REVERSED'
