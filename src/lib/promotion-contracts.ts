import type { OperationalOrder } from './operations-contracts.ts'

/** Either selector matches the accepted line snapshot; an empty scope is invalid. */
export interface PromotionScope { productIds: string[]; categories: string[] }
export interface PromotionSnapshot { id: string; revision: number; name: string }
export interface Promotion extends PromotionSnapshot {
  active: boolean; kind: 'fixed' | 'percent'; value: number; scope: PromotionScope
}
export type PromotionCommand =
  | { command: 'promotions' }
  | { command: 'save_promotion'; operationId: string; promotionId: string; expectedRevision: number | null; name: string; active: boolean; kind: Promotion['kind']; value: number; scope: PromotionScope }
  | { command: 'apply_order_promotion'; operationId: string; orderId: string; expectedRevision: number; promotionId: string; promotionRevision: number }
export interface PromotionResponses {
  promotions: { promotions: Promotion[] }
  save_promotion: Promotion
  apply_order_promotion: OperationalOrder
}
export type PromotionErrorCode = 'PROMOTION_CHANGED' | 'PROMOTION_NOT_FOUND' | 'PROMOTION_NOT_APPLICABLE'
