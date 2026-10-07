import type { OperationalOrder, OrderLine } from './operations-contracts'
import type { PromotionScope } from './promotion-contracts'

export const promotionCategory = (value: string) => value.trim().replace(/\s+/g, ' ').normalize('NFC')

/** Match accepted line snapshots, so later catalog changes cannot move a discount. */
export function promotionMatchesLine(line: Pick<OrderLine, 'productId' | 'category' | 'kind'>, scope: PromotionScope): boolean {
  return Boolean(line.productId && scope.productIds.some(id => id.toLowerCase() === line.productId!.toLowerCase()))
    || scope.categories.some(category => promotionCategory(category) === promotionCategory(line.category))
}

export function discountEligibleGross(order: Pick<OperationalOrder, 'items' | 'grossCents'>, scope?: PromotionScope): number {
  if (!scope) return order.grossCents
  return Number(order.items.reduce((sum, line) => sum + (promotionMatchesLine(line, scope) ? BigInt(line.grossCents) : 0n), 0n))
}

export function promotionScopeKey(scope?: PromotionScope): string {
  return scope ? JSON.stringify({ productIds: scope.productIds.map(id => id.toLowerCase()).sort(), categories: scope.categories.map(promotionCategory).sort() }) : ''
}
