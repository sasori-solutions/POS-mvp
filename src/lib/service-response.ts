import type { ServiceDay, ServiceOrderState } from './service-contracts'

type Row = Record<string, unknown>
function record(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function ids(value: unknown): value is string[] { return Array.isArray(value) && value.every(id => typeof id === 'string') }
function timestamp(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function visit(value: unknown): boolean {
  return record(value) && typeof value.name === 'string' && ids(value.tableIds) && Array.isArray(value.orders) && value.orders.length > 0
    && value.orders.every(order => record(order) && typeof order.id === 'string' && typeof order.name === 'string' && typeof order.balanceCents === 'number')
}
function courses(value: unknown): boolean {
  return Array.isArray(value) && value.every(course => record(course) && typeof course.id === 'string' && typeof course.name === 'string'
    && ['held', 'sent', 'released'].includes(String(course.status)) && Array.isArray(course.items)
    && course.items.every(item => record(item) && typeof item.lineId === 'string' && typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity > 0)
    && (course.batch === undefined || course.batch === null || record(course.batch) && Array.isArray(course.batch.items)
      && course.batch.items.every(item => record(item) && typeof item.lineId === 'string' && typeof item.name === 'string')))
}
/** Structural checks complement posRequest's financial assertions before rendering. */
export function assertServiceOrderView(value: unknown): asserts value is ServiceOrderState {
  if (!record(value) || !courses(value.courses) || value.visit !== null && !visit(value.visit)) throw new Error('Invalid service view')
}
export function assertServiceDayView(value: unknown): asserts value is ServiceDay {
  if (!record(value) || typeof value.timezone !== 'string' || !Array.isArray(value.visits) || !value.visits.every(visit)
    || !Array.isArray(value.reservations) || !value.reservations.every(row => record(row) && typeof row.id === 'string' && typeof row.name === 'string'
      && typeof row.contact === 'string' && typeof row.note === 'string' && ids(row.tableIds) && timestamp(row.startsAt) && timestamp(row.endsAt)
      && ['confirmed', 'seated', 'cancelled', 'no_show', 'completed'].includes(String(row.status)))) throw new Error('Invalid reservation view')
}
