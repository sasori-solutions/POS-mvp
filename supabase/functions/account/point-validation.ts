import type { PointCommand } from '../../../src/lib/point-contracts.ts'
import { isUuid, RequestValidationError } from './validation.ts'

function invalid(): never { throw new RequestValidationError() }
function uuid(value: unknown): string { if (!isUuid(value)) invalid(); return value }
function providerId(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid(); return value }
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > 9_999_999_999) invalid()
  return value
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) invalid()
  const clean = value.trim()
  if (!clean || clean.length > max) invalid()
  return clean
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31') invalid()
  const parsed = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== value) invalid()
  return value
}
export function parsePointCommand(input: Record<string, unknown>, accessKeys: string[]): PointCommand {
  const keys = (extra: string[]) => {
    const allowed = [...accessKeys, 'command', ...extra]
    if (Object.keys(input).length !== allowed.length || allowed.some(key => !Object.hasOwn(input, key))) invalid()
  }
  const operation = () => uuid(input.operationId)
  const checkout = () => uuid(input.checkoutId)
  switch (input.command) {
    case 'settings': case 'recover': case 'verify_connection': case 'resources': case 'disconnect': case 'statements':
      keys([]); return { command: input.command }
    case 'connect_sandbox': keys(['operationId']); return { command: input.command, operationId: operation() }
    case 'simulate':
      keys(['checkoutId', 'status'])
      if (!['processed', 'failed', 'canceled', 'expired', 'action_required'].includes(String(input.status))) invalid()
      return { command: input.command, checkoutId: checkout(), status: input.status as 'processed' | 'failed' | 'canceled' | 'expired' | 'action_required' }
    case 'oauth_start':
      keys(['operationId', ...(Object.hasOwn(input,'environment') ? ['environment'] : [])])
      if (Object.hasOwn(input,'environment') && input.environment !== 'live' && input.environment !== 'sandbox') invalid()
      return { command: input.command, operationId: operation(), ...(input.environment ? { environment: input.environment as 'live' | 'sandbox' } : {}) }
    case 'oauth_callback':
      keys([Object.hasOwn(input,'error') ? 'error' : 'code','state']); if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state)) invalid()
      if (Object.hasOwn(input,'error')) { if (input.error !== 'access_denied') invalid(); return { command: input.command, error: 'access_denied', state: input.state } }
      return { command: input.command, code: text(input.code,2048), state: input.state }
    case 'create_branch': {
      keys(['operationId','name','location'])
      if (!input.location || typeof input.location !== 'object' || Array.isArray(input.location)) invalid()
      const location = input.location as Record<string, unknown>
      const fields = ['street_name','street_number','city_name','state_name','latitude','longitude']
      if (fields.some(key => !Object.hasOwn(location,key)) || Object.keys(location).some(key => !fields.includes(key) && key !== 'reference')) invalid()
      if (typeof location.latitude !== 'number' || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90 || typeof location.longitude !== 'number' || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) invalid()
      if (Object.hasOwn(location,'reference') && (typeof location.reference !== 'string' || location.reference.length>300 || /[\u0000-\u001f\u007f]/.test(location.reference))) invalid()
      return { command: input.command, operationId: operation(), name: text(input.name,100), location: { street_name:text(location.street_name,100), street_number:text(location.street_number,20), city_name:text(location.city_name,100), state_name:text(location.state_name,100), latitude:location.latitude, longitude:location.longitude, ...(Object.hasOwn(location,'reference') ? { reference: location.reference as string } : {}) } }
    }
    case 'create_register': keys(['operationId','branchId','name']); return { command: input.command, operationId: operation(), branchId: providerId(input.branchId), name: text(input.name,100) }
    case 'link_terminal':
      keys(['operationId','serial','branchId','registerId'])
      return { command: input.command, operationId: operation(), serial: text(input.serial,100), branchId: text(input.branchId,100), registerId: text(input.registerId,100) }
    case 'test_terminal': keys(['terminalId']); return { command: input.command, terminalId: providerId(input.terminalId) }
    case 'activate': keys(['enabled']); if (typeof input.enabled !== 'boolean') invalid(); return { command: input.command, enabled: input.enabled }
    case 'prepare': keys(['operationId','checkoutAttemptId','terminalId']); return { command: input.command, operationId: operation(), checkoutAttemptId: uuid(input.checkoutAttemptId), terminalId: providerId(input.terminalId) }
    case 'start': keys(['operationId','checkoutId']); return { command: input.command, operationId: operation(), checkoutId: checkout() }
    case 'status': case 'cancel': keys(['checkoutId']); return { command: input.command, checkoutId: checkout() }
    case 'refund_context': keys(['saleId']); return { command: input.command, saleId: uuid(input.saleId) }
    case 'incident': keys(['operationId','checkoutId','reason']); return { command: input.command, operationId: operation(), checkoutId: checkout(), reason: text(input.reason) }
    case 'refund': {
      keys(['operationId','checkoutId','amountCents','merchandiseCents','tipCents','reason'])
      const amountCents = integer(input.amountCents,1), merchandiseCents = integer(input.merchandiseCents), tipCents = integer(input.tipCents)
      if (merchandiseCents + tipCents !== amountCents) invalid()
      return { command: input.command, operationId: operation(), checkoutId: checkout(), amountCents, merchandiseCents, tipCents, reason: text(input.reason) }
    }
    case 'merchant_report': case 'admin_report': {
      keys(['from','to', ...(input.command === 'admin_report' && Object.hasOwn(input,'cursor') ? ['cursor'] : [])]); const from = date(input.from), to = date(input.to)
      if (to < from || Date.parse(to) - Date.parse(from) > 365 * 86400000) invalid()
      if (input.command === 'admin_report' && Object.hasOwn(input,'cursor')) return { command: input.command, from, to, cursor: input.cursor === null ? null : uuid(input.cursor) }
      return { command: input.command, from, to }
    }
    case 'close_statement':
      keys(['operationId','period']); if (typeof input.period !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(input.period)) invalid()
      return { command: input.command, operationId: operation(), period: input.period }
    case 'mark_statement_invoiced':
      keys(['operationId','statementId','evidence']); return { command: input.command, operationId: operation(), statementId: uuid(input.statementId), evidence: text(input.evidence,300) }
    case 'record_commission_payment': {
      keys(['operationId','statementId','amountCents','paidAt','evidence'])
      if (typeof input.paidAt !== 'string' || input.paidAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(input.paidAt) || !Number.isFinite(Date.parse(input.paidAt))) invalid()
      return { command: input.command, operationId: operation(), statementId: uuid(input.statementId), amountCents: integer(input.amountCents,1), paidAt: input.paidAt, evidence: text(input.evidence,300) }
    }
    default: return invalid()
  }
}
