import type { PaymentMethod } from './contracts'
import type { PointSettings } from './point-contracts'

export const paymentLabels: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  card_external: 'Tarjeta externa',
  card_integrated: 'Mercado Pago Point',
  transfer: 'Transferencia',
}

/** Each method keeps the collection and recovery identity stored by the server. */
export function collectionPaymentMethod(method: PaymentMethod): PaymentMethod {
  return method
}

export function collectionPaymentMethods(methods: readonly PaymentMethod[]): PaymentMethod[] {
  return [...new Set(methods.map(collectionPaymentMethod))]
}

export function isManualCollectionMethod(method: PaymentMethod): method is 'cash' | 'transfer' | 'card_external' {
  return method === 'cash' || method === 'transfer' || method === 'card_external'
}

/** Presentation readiness is conservative; the provider and SQL still authorize each charge. */
export function pointCardReady(methods: readonly PaymentMethod[], settings: PointSettings | null | undefined): boolean {
  return Boolean(methods.includes('card_integrated') && settings?.enabled && settings.chargesEnabled !== false
    && settings.permissions.charge && settings.connection?.status === 'connected' && settings.connection.verifiedAt
    && settings.terminals.some(terminal => terminal.active && terminal.verified && terminal.mode === 'PDV' && !terminal.physicalStepsPending))
}
