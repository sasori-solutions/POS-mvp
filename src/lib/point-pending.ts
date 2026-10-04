import type { PointCommand } from './point-contracts'
import { exactCents } from './point-domain'
export type PointStatementCommand = Extract<PointCommand, { command: 'close_statement' | 'mark_statement_invoiced' | 'record_commission_payment' }>
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export const pointStatementKey = (businessId: string, actorId: string) => `pos-point-statement:${businessId}:${actorId}`
/** Persist only the exact financial command, never its authentication envelope. */
export function readPointStatement(key: string, storage: Storage = localStorage): PointStatementCommand | null {
  const raw = storage.getItem(key)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value) || !uuid(value.operationId)) throw new Error()
    const keys = ['command', 'operationId']
    if (value.command === 'close_statement') {
      keys.push('period')
      if (typeof value.period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.period)) throw new Error()
    } else if (value.command === 'mark_statement_invoiced' || value.command === 'record_commission_payment') {
      keys.push('statementId', 'evidence')
      if (!uuid(value.statementId) || typeof value.evidence !== 'string' || !value.evidence.trim() || value.evidence.length > 200) throw new Error()
      if (value.command === 'record_commission_payment') {
        keys.push('amountCents', 'paidAt')
        if (exactCents(value.amountCents) <= 0 || typeof value.paidAt !== 'string' || !Number.isFinite(Date.parse(value.paidAt))) throw new Error()
      }
    } else throw new Error()
    if (Object.keys(value).length !== keys.length || !Object.keys(value).every(key => keys.includes(key))) throw new Error()
    return value as PointStatementCommand
  } catch { throw new Error('Hay una solicitud de comisión pendiente que necesita revisión. Conserva este dispositivo.') }
}
