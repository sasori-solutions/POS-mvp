import type { CheckoutAttempt } from './operations-contracts.ts'
import type { Sale } from './pos-contracts.ts'

export type PointEnvironment = 'live' | 'sandbox'
export interface PointStoreLocation { street_number: string; street_name: string; city_name: string; state_name: string; latitude: number; longitude: number; reference?: string }
export type PointPaymentState = 'prepared' | 'pending' | 'sent_to_terminal' | 'processing' | 'approved_verified' | 'rejected' | 'cancelled' | 'expired' | 'unknown_review' | 'partially_refunded' | 'refunded'
export interface PointConnection { id: string; status: 'connected' | 'revoked' | 'reconnect_required'; environment: PointEnvironment; receiverId: string; verifiedAt: string | null }
export interface PointTerminal { id: string; serial: string; branchId: string; registerId: string; branchName: string; registerName: string; mode: string; verified: boolean; active: boolean; physicalStepsPending: boolean }
export interface PointCheckout {
  id: string; attemptId: string | null; state: PointPaymentState; saleState: 'pending' | 'materialized'; totalCents: number; refundedCents: number
  items: CheckoutAttempt['items']; checkout: CheckoutAttempt; sale: Sale | null; terminal: PointTerminal
  cancelCapability: 'backend' | 'terminal' | 'unavailable'; updatedAt: string; statusDetail: string | null; remoteOrderId: string | null
}
export interface PointSettings {
  enabled: boolean; connection: PointConnection | null; terminals: PointTerminal[]; pending: PointCheckout[]
  permissions: { manage: boolean; charge: boolean; refund: boolean; reports: boolean; admin: boolean }
  commission: { rateBps: number; vatBps: number; version: string }; asOf: string
}
export interface CommissionStatement { id: string; period: string; status: 'closed' | 'invoiced'; exactNumerator: string; netCents: number; vatCents: number; totalCents: number; collectedCents: number; remainingCents: number; closedAt: string }
export interface PointReport {
  from: string; to: string; timezone: string; asOf: string; lastReconciledAt: string | null
  grossCents: number; refundCents: number; netCents: number; paymentCount: number; averageTicketCents: number | null
  commissionNetCents: number; commissionVatCents: number; commissionTotalCents: number; commissionExactNumerator: string
  pendingCount: number; oldestPendingAt: string | null; otherPayments: { method: string; totalCents: number; count: number }[]
  terminals: { terminalId: string; grossCents: number; refundCents: number; count: number }[]
  daily: { date: string; grossCents: number; refundCents: number; count: number }[]
  previous: { grossCents: number; refundCents: number; netCents: number; paymentCount: number }
  costsCents: number | null; contributionCents: number | null; settlementCents: null
  attempts: { population: string; count: number; confirmed: number; rejected: number; rejectionRate: number | null; incidentAttempts: number; results: { state: PointPaymentState; count: number }[]; confirmationSecondsP50: number | null; confirmationSecondsP95: number | null }
  commissionAccounting: { accruedExactNumerator: string; adjustmentExactNumerator: string; eligibleBaseCents: number; effectiveRate: number | null; averageNetPerActiveBusinessCents: number | null; closedNetCents: number; invoicedNetCents: number; invoicedVatCents: number; collectedForPeriodsCents: number; remainingCents: number; collectedCents: number }
  health: { receivedEvents: number; duplicates: number; invalidSignatures: number | null; unmatchedEvents: number | null; eventLagSecondsP50: number | null; eventLagSecondsP95: number | null; queuedJobs: number; failedJobs: number; pendingOlderThan15Minutes: number; reconciliationAgeSeconds: number | null }
  provider: { id: string; grossCents: number; refundCents: number; commissionNetCents: number }
}
export interface PointAdminReport extends PointReport {
  businesses: { businessId: string; name: string; grossCents: number; refundCents: number; paymentCount: number; commissionExactNumerator: string; commissionNetCents: number }[]
  nextCursor: string | null; connectedBusinesses: number; readyBusinesses: number; activeBusinesses: number
  businessDetailTotals: { grossCents: number; refundCents: number; paymentCount: number }
  cohorts: { cohort: string; businesses: number; grossCents: number; refundCents: number; commissionExactNumerator: string }[]
  activation: { connectedWithFirstPayment: number; firstPaymentSecondsP50: number | null; firstPaymentSecondsP95: number | null }
}
export type PointCommand =
  | { command: 'settings' | 'recover' | 'verify_connection' | 'resources' | 'disconnect' }
  | { command: 'oauth_start'; operationId: string; environment?: PointEnvironment }
  | { command: 'oauth_callback'; code: string; state: string; error?: never }
  | { command: 'oauth_callback'; error: 'access_denied'; state: string; code?: never }
  | { command: 'create_branch'; operationId: string; name: string; location: PointStoreLocation }
  | { command: 'create_register'; operationId: string; branchId: string; name: string }
  | { command: 'link_terminal'; operationId: string; serial: string; branchId: string; registerId: string }
  | { command: 'test_terminal'; terminalId: string }
  | { command: 'activate'; enabled: boolean }
  | { command: 'prepare'; operationId: string; checkoutAttemptId: string; terminalId: string }
  | { command: 'start'; operationId: string; checkoutId: string }
  | { command: 'status' | 'cancel'; checkoutId: string }
  | { command: 'refund_context'; saleId: string }
  | { command: 'incident'; operationId: string; checkoutId: string; reason: string }
  | { command: 'refund'; operationId: string; checkoutId: string; amountCents: number; merchandiseCents: number; tipCents: number; reason: string }
  | { command: 'merchant_report'; from: string; to: string }
  | { command: 'admin_report'; from: string; to: string; cursor?: string | null }
  | { command: 'statements' }
  | { command: 'close_statement'; operationId: string; period: string }
  | { command: 'mark_statement_invoiced'; operationId: string; statementId: string; evidence: string }
  | { command: 'record_commission_payment'; operationId: string; statementId: string; amountCents: number; paidAt: string; evidence: string }
export interface PointResponses {
  settings: PointSettings; recover: { checkouts: PointCheckout[] }; oauth_start: { authorizationUrl: string; expiresAt: string }; oauth_callback: PointSettings
  create_branch: { id: string; name: string }; create_register: { id: string; branchId: string; name: string }
  verify_connection: PointSettings; resources: { branches: { id: string; name: string }[]; registers: { id: string; branchId: string; name: string }[]; terminals: PointTerminal[] }
  link_terminal: PointSettings; test_terminal: PointSettings; activate: PointSettings; disconnect: PointSettings
  prepare: PointCheckout; start: PointCheckout; status: PointCheckout; cancel: PointCheckout; incident: PointCheckout; refund: PointCheckout; refund_context: PointCheckout
  merchant_report: PointReport; admin_report: PointAdminReport; statements: { statements: CommissionStatement[] }
  close_statement: CommissionStatement; mark_statement_invoiced: CommissionStatement; record_commission_payment: CommissionStatement
}
export type PointErrorCode = 'POINT_DISABLED' | 'POINT_CONNECTION_REQUIRED' | 'POINT_TERMINAL_NOT_READY' | 'POINT_TERMINAL_BUSY' | 'POINT_CHECKOUT_NOT_FOUND' | 'POINT_RESULT_UNCERTAIN' | 'POINT_STATE_INVALID' | 'POINT_FACT_MISMATCH' | 'POINT_REFUND_LIMIT' | 'POINT_REFUND_ALLOCATION_REQUIRED' | 'POINT_ADMIN_DENIED' | 'POINT_PERIOD_CLOSED' | 'POINT_LEASE_LOST' | 'POINT_OAUTH_INVALID' | 'POINT_CONFIGURATION_REQUIRED' | 'POINT_SERVICE_UNAVAILABLE' | 'POINT_REFRESH_BUSY' | 'POINT_IDEMPOTENCY_WINDOW_EXPIRED'
