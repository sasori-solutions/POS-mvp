import type { PointCheckout, PointSettings } from '../../src/lib/point-contracts'
export const pointId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
export const pointAccess = { businessId: pointId(1), operatorToken: 'synthetic-point-session' }
export function pointCheckout(changes: Partial<PointCheckout> = {}): PointCheckout {
  const items = [{ lineId: pointId(3), productId: pointId(4), name: 'Café sintético', quantity: 2, unitPriceCents: 5000, discountCents: 0, totalCents: 10000, taxCents: 1379 }]
  return { id: pointId(10), attemptId: null, state: 'prepared', saleState: 'pending', totalCents: 10000, refundedCents: 0, refundRequests: [], items,
    checkout: { id: pointId(5), revision: 1, orderId: pointId(6), shiftId: pointId(7), kind: 'payment', status: 'prepared', paymentMethod: 'card_integrated', totalCents: 10000, discountCents: 0, taxCents: 1379, items, saleId: null, originalSaleId: null, operatorName: 'Persona sintética', resolverName: null, createdAt: '2026-10-03T12:00:00Z', resolvedAt: null, reason: '' },
    sale: null, terminal: { id: 'PAX_SYNTHETIC', serial: 'SYNTHETIC', branchId: '1', registerId: '2', branchName: 'Sucursal', registerName: 'Caja', mode: 'PDV', verified: true, active: true, physicalStepsPending: false },
    cancelCapability: 'unavailable', updatedAt: '2026-10-03T12:00:00Z', statusDetail: null, remoteOrderId: null, ...changes }
}
export function pointSettings(): PointSettings {
  return { actorId: pointId(22), enabled: true, connection: { id: pointId(20), status: 'connected', environment: 'sandbox', receiverId: 'synthetic', verifiedAt: '2026-10-03T12:00:00Z' }, terminals: [pointCheckout().terminal], pending: [], permissions: { manage: true, charge: true, refund: true, reports: true, admin: false }, commission: { rateBps: 30, vatBps: 1600, version: 'synthetic' }, asOf: '2026-10-03T12:00:00Z' }
}
export function pointPaid(): PointCheckout {
  const prepared = pointCheckout()
  return { ...prepared, attemptId: pointId(11), state: 'approved_verified', saleState: 'materialized',
    checkout: { ...prepared.checkout, status: 'completed', saleId: pointId(12) },
    sale: { id: pointId(12), createdAt: '2026-10-03T12:00:00Z', paymentMethod: 'card_integrated', totalCents: 10000, itemCount: 2, operatorName: 'Persona sintética', timezone: 'America/Mexico_City', items: prepared.items } }
}
export function pointReport() {
  return { from: '2026-10-01', to: '2026-10-03', timezone: 'America/Mexico_City', asOf: '2026-10-03T12:00:00Z', lastReconciledAt: null,
    grossCents: 10000, refundCents: 0, netCents: 10000, paymentCount: 1, averageTicketCents: 10000,
    commissionNetCents: 30, commissionVatCents: 5, commissionTotalCents: 35, commissionExactNumerator: '300000', pendingCount: 0, oldestPendingAt: null,
    otherPayments: [], terminals: [], daily: [], previous: { grossCents: 0, refundCents: 0, netCents: 0, paymentCount: 0 }, costsCents: null, contributionCents: null, settlementCents: null,
    attempts: { population: 'live', count: 1, confirmed: 1, rejected: 0, rejectionRate: 0, incidentAttempts: 0, results: [], confirmationSecondsP50: null, confirmationSecondsP95: null },
    commissionAccounting: { accruedExactNumerator: '300000', adjustmentExactNumerator: '0', eligibleBaseCents: 10000, effectiveRate: 0.003, averageNetPerActiveBusinessCents: 30, closedNetCents: 0, invoicedNetCents: 0, invoicedVatCents: 0, collectedForPeriodsCents: 0, remainingCents: 0, collectedCents: 0 },
    health: { receivedEvents: 1, duplicates: 0, invalidSignatures: 0, unmatchedEvents: 0, eventLagSecondsP50: null, eventLagSecondsP95: null, queuedJobs: 0, failedJobs: 0, pendingOlderThan15Minutes: 0, reconciliationAgeSeconds: 0 },
    provider: { id: 'point', grossCents: 10000, refundCents: 0, commissionNetCents: 30 }, businesses: [{ businessId: pointId(50), name: 'Negocio inicial', grossCents: 10000, refundCents: 0, paymentCount: 1, commissionExactNumerator: '300000', commissionNetCents: 30 }],
    nextCursor: 'page2', connectedBusinesses: 1, readyBusinesses: 1, activeBusinesses: 1, businessDetailTotals: { grossCents: 10000, refundCents: 0, paymentCount: 1 }, cohorts: [], activation: { connectedWithFirstPayment: 1, firstPaymentSecondsP50: null, firstPaymentSecondsP95: null } }
}
