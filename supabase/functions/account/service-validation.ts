import type { ServiceCommand, ReservationStatus } from '../../../src/lib/service-contracts.ts'
import { isUuid, RequestValidationError } from './validation.ts'

const commands = new Set(['service_day', 'service_order', 'associate_service_tables', 'release_service_visit', 'continue_service_order', 'save_service_course', 'send_service_course', 'cancel_service_course', 'save_service_reservation', 'set_service_reservation_status'])
function invalid(): never { throw new RequestValidationError() }
function exact(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid() }
function uuid(value: unknown): string { if (!isUuid(value)) invalid(); return value }
function int(value: unknown, max = 2_147_483_647): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) invalid(); return value }
function text(value: unknown, max: number, min = 0): string { if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) invalid(); const result = value.trim().replace(/\s+/g, ' '); if (Array.from(result).length < min || Array.from(result).length > max) invalid(); return result }
function ids(value: unknown): string[] { if (!Array.isArray(value) || value.length > 20) invalid(); const result = value.map(uuid).sort(); if (new Set(result).size !== result.length) invalid(); return result }
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid()
  const date = value.slice(0, 10), calendar = new Date(date + 'T00:00:00Z')
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date || /[+-]14:(?!00)/.test(value)) invalid()
  const result = new Date(value).toISOString()
  if (result < '2000-01-01' || result >= '2101-01-01') invalid()
  return result
}

export function parseServiceCommand(input: Record<string, unknown>, accessKeys: string[]): ServiceCommand | null {
  if (!commands.has(input.command as string)) return null
  const keys = (extra: string[]) => exact(input, [...accessKeys, 'command', ...extra])
  const operationId = () => uuid(input.operationId), orderId = () => uuid(input.orderId), expectedRevision = () => int(input.expectedRevision)
  switch (input.command) {
    case 'service_day': {
      keys(['date'])
      if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date + 'T00:00:00Z')) || new Date(input.date + 'T00:00:00Z').toISOString().slice(0, 10) !== input.date || input.date < '2000-01-01' || input.date > '2100-12-31') invalid()
      return { command: 'service_day', date: input.date }
    }
    case 'service_order': keys(['orderId']); return { command: 'service_order', orderId: orderId() }
    case 'associate_service_tables': keys(['operationId', 'orderId', 'expectedRevision', 'expectedVisitRevision', 'tableIds']); return { command: 'associate_service_tables', operationId: operationId(), orderId: orderId(), expectedRevision: expectedRevision(), expectedVisitRevision: input.expectedVisitRevision === null ? null : int(input.expectedVisitRevision), tableIds: ids(input.tableIds) }
    case 'release_service_visit': keys(['operationId', 'visitId', 'expectedRevision']); return { command: 'release_service_visit', operationId: operationId(), visitId: uuid(input.visitId), expectedRevision: expectedRevision() }
    case 'continue_service_order': keys(['operationId', 'sourceOrderId', 'expectedRevision', 'orderId', 'name']); return { command: 'continue_service_order', operationId: operationId(), sourceOrderId: uuid(input.sourceOrderId), expectedRevision: expectedRevision(), orderId: orderId(), name: text(input.name, 100, 1) }
    case 'save_service_course': {
      keys(['operationId', 'orderId', 'expectedRevision', 'courseId', 'name', 'items'])
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 40) invalid()
      const items = input.items.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
        const row = value as Record<string, unknown>; exact(row, ['lineId', 'quantity'])
        return { lineId: uuid(row.lineId), quantity: int(row.quantity, 999) }
      }).sort((a, b) => a.lineId.localeCompare(b.lineId))
      if (new Set(items.map(item => item.lineId)).size !== items.length) invalid()
      return { command: 'save_service_course', operationId: operationId(), orderId: orderId(), expectedRevision: expectedRevision(), courseId: uuid(input.courseId), name: text(input.name, 60, 1), items }
    }
    case 'send_service_course': case 'cancel_service_course': keys(['operationId', 'orderId', 'expectedRevision', 'courseId']); return { command: input.command, operationId: operationId(), orderId: orderId(), expectedRevision: expectedRevision(), courseId: uuid(input.courseId) }
    case 'save_service_reservation': {
      keys(['operationId', 'reservationId', 'expectedRevision', 'name', 'contact', 'partySize', 'startsAt', 'endsAt', 'tableIds', 'note'])
      const startsAt = timestamp(input.startsAt), endsAt = timestamp(input.endsAt), duration = Date.parse(endsAt) - Date.parse(startsAt)
      if (duration < 15 * 60_000 || duration > 12 * 60 * 60_000) invalid()
      return { command: 'save_service_reservation', operationId: operationId(), reservationId: uuid(input.reservationId), expectedRevision: input.expectedRevision === null ? null : expectedRevision(), name: text(input.name, 100, 1), contact: text(input.contact, 80), partySize: int(input.partySize, 100), startsAt, endsAt, tableIds: ids(input.tableIds), note: text(input.note, 200) }
    }
    case 'set_service_reservation_status':
      keys(['operationId', 'reservationId', 'expectedRevision', 'status', 'orderId'])
      if (!['confirmed', 'seated', 'cancelled', 'no_show', 'completed'].includes(input.status as string) || (input.status === 'seated') !== (input.orderId !== null)) invalid()
      return { command: 'set_service_reservation_status', operationId: operationId(), reservationId: uuid(input.reservationId), expectedRevision: expectedRevision(), status: input.status as ReservationStatus, orderId: input.orderId === null ? null : orderId() }
    default: return null
  }
}
