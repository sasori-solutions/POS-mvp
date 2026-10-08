import type { PromotionCommand, PromotionScope } from '../../../src/lib/promotion-contracts.ts'
import { isUuid, RequestValidationError } from './validation.ts'

function invalid(): never { throw new RequestValidationError() }
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}
function uuid(value: unknown): string { if (!isUuid(value)) invalid(); return value.toLowerCase() }
function int(value: unknown, min: number, max = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid()
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) invalid()
  const result = value.trim().replace(/\s+/g, ' ').normalize('NFC')
  if (!result || Array.from(result).length > max) invalid()
  return result
}

export function parsePromotionScope(value: unknown): PromotionScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const scope = value as Record<string, unknown>; exact(scope, ['productIds', 'categories'])
  if (!Array.isArray(scope.productIds) || scope.productIds.length > 100 || !Array.isArray(scope.categories) || scope.categories.length > 24) invalid()
  const productIds = scope.productIds.map(uuid).sort(), categories = scope.categories.map(value => text(value, 60)).sort()
  if (new Set(productIds).size !== productIds.length || new Set(categories).size !== categories.length || !productIds.length && !categories.length) invalid()
  return { productIds, categories }
}

export function parsePromotionCommand(input: Record<string, unknown>, accessKeys: string[]): PromotionCommand | null {
  const keys = (extra: string[]) => exact(input, [...accessKeys, 'command', ...extra])
  switch (input.command) {
    case 'promotions': keys([]); return { command: 'promotions' }
    case 'save_promotion':
      keys(['operationId', 'promotionId', 'expectedRevision', 'name', 'active', 'kind', 'value', 'scope'])
      if (typeof input.active !== 'boolean' || input.kind !== 'fixed' && input.kind !== 'percent') invalid()
      return { command: 'save_promotion', operationId: uuid(input.operationId), promotionId: uuid(input.promotionId), expectedRevision: input.expectedRevision === null ? null : int(input.expectedRevision, 1), name: text(input.name, 60), active: input.active, kind: input.kind, value: int(input.value, 0, input.kind === 'fixed' ? 9_999_999_999 : 10_000), scope: parsePromotionScope(input.scope) }
    case 'apply_order_promotion':
      keys(['operationId', 'orderId', 'expectedRevision', 'promotionId', 'promotionRevision'])
      return { command: 'apply_order_promotion', operationId: uuid(input.operationId), orderId: uuid(input.orderId), expectedRevision: int(input.expectedRevision, 1), promotionId: uuid(input.promotionId), promotionRevision: int(input.promotionRevision, 1) }
    default: return null
  }
}
