import type { PaymentMethod } from './contracts'
import type { PointSettings } from './point-contracts'

/** Historical external-card records keep their contract; new card collections use Point. */
export function collectionPaymentMethod(method: PaymentMethod): PaymentMethod {
  return method === 'card_external' ? 'card_integrated' : method
}

export function collectionPaymentMethods(methods: readonly PaymentMethod[]): PaymentMethod[] {
  return [...new Set(methods.map(collectionPaymentMethod))]
}

export function isManualCollectionMethod(method: PaymentMethod): method is 'cash' | 'transfer' {
  return method === 'cash' || method === 'transfer'
}

/** Presentation readiness is conservative; the provider and SQL still authorize each charge. */
export function pointCardReady(methods: readonly PaymentMethod[], settings: PointSettings | null | undefined): boolean {
  return Boolean(methods.includes('card_integrated') && settings?.enabled && settings.chargesEnabled !== false
    && settings.permissions.charge && settings.connection?.status === 'connected' && settings.connection.verifiedAt
    && settings.terminals.some(terminal => terminal.active && terminal.verified && terminal.mode === 'PDV' && !terminal.physicalStepsPending))
}
