import { accountRequest, deviceRequest } from './account'
import type { PointCommand, PointPaymentState, PointResponses } from './point-contracts'
import type { PosAccess } from './pos'

type PointOAuthReturn = { code: string; state: string } | { error: 'access_denied'; state: string } | { rejected: true }
let oauthReturn: PointOAuthReturn | null = null
// Capture once in memory before the PIN route initializes, and scrub browser history immediately.
if (typeof window !== 'undefined' && window.location.pathname === '/point/callback') {
  const query = new URLSearchParams(window.location.search)
  const code = query.get('code'), state = query.get('state')
  oauthReturn = query.get('error') === 'access_denied' && state ? { error: 'access_denied', state } : code && state && !query.has('error') ? { code, state } : { rejected: true }
  window.history.replaceState({}, '', '/')
}
export function takePointOAuthReturn() { const value = oauthReturn; oauthReturn = null; return value }

/** The browser calls our authorized account API. Provider credentials never cross this boundary. */
export async function pointRequest<C extends PointCommand['command']>(access: PosAccess, command: PointCommand & { command: C }): Promise<PointResponses[C]> {
  const result = access.deviceToken
    ? await deviceRequest({ action: 'device_point', deviceToken: access.deviceToken, operatorToken: access.operatorToken, ...command })
    : await accountRequest({ action: 'point', businessId: access.businessId, operatorToken: access.operatorToken, ...command })
  return result as PointResponses[C]
}

export const pointStateLabels: Record<PointPaymentState, string> = {
  prepared: 'Listo para iniciar', pending: 'Pago pendiente', sent_to_terminal: 'Enviado a la terminal', processing: 'Procesando pago',
  approved_verified: 'Pago aprobado y verificado', rejected: 'Pago rechazado', cancelled: 'Pago cancelado', expired: 'Pago expirado',
  unknown_review: 'Resultado pendiente de revisión', partially_refunded: 'Devolución parcial confirmada', refunded: 'Devolución total confirmada',
}
export const pointResolved = (state: PointPaymentState) => ['approved_verified', 'rejected', 'cancelled', 'expired', 'partially_refunded', 'refunded'].includes(state)
export const pointFailed = (state: PointPaymentState) => ['rejected', 'cancelled', 'expired'].includes(state)

/** Protect text exports against spreadsheet formula interpretation. */
export function pointCsvCell(value: string | number | null) {
  const text = value === null ? '' : String(value)
  return `"${(/^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`
}

export function downloadPointCsv(name: string, rows: (string | number | null)[][]) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map(row => row.map(pointCsvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  URL.revokeObjectURL(url)
}
