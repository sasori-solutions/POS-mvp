import type { MenuCommand, MenuSchedule } from '../../../src/lib/menu-contracts.ts'
import { isUuid, RequestValidationError } from './validation.ts'

function invalid(): never { throw new RequestValidationError() }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid()
  return record
}
function integer(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(); return value }
function uuid(value: unknown): string { if (!isUuid(value)) invalid(); return value }
function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid()
  const normalized = value.trim().replace(/\s+/g, ' '); if (normalized.length < min) invalid(); return normalized
}
export function parseMenuSchedule(value: unknown): MenuSchedule {
  const schedule = exact(value, ['weekdays', 'startMinute', 'endMinute'])
  if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length < 1 || schedule.weekdays.length > 7) invalid()
  const weekdays = schedule.weekdays.map(day => integer(day, 0, 6))
  if (weekdays.some((day, index) => index > 0 && day <= weekdays[index - 1])) invalid()
  const startMinute = integer(schedule.startMinute, 0, 1439), endMinute = integer(schedule.endMinute, 1, 1440)
  if (startMinute === endMinute) invalid()
  return { weekdays, startMinute, endMinute }
}
export function parseMenuCommand(input: Record<string, unknown>, base: string[]): MenuCommand | null {
  if (input.command === 'menus') { exact(input, [...base, 'command']); return { command: 'menus' } }
  if (input.command !== 'save_menu') return null
  exact(input, [...base, 'command', 'operationId', 'menuId', 'expectedRevision', 'name', 'locationLabel', 'published', 'productIds', 'schedules'])
  if (typeof input.published !== 'boolean' || !Array.isArray(input.productIds) || input.productIds.length > 100 || !Array.isArray(input.schedules) || input.schedules.length > 14) invalid()
  const productIds = input.productIds.map(uuid)
  if (new Set(productIds.map(id => id.toLowerCase())).size !== productIds.length || (input.published && !productIds.length)) invalid()
  return { command: 'save_menu', operationId: uuid(input.operationId), menuId: uuid(input.menuId), expectedRevision: input.expectedRevision === null ? null : integer(input.expectedRevision, 1, 2147483647),
    name: text(input.name, 1, 100), locationLabel: text(input.locationLabel, 0, 80), published: input.published, productIds, schedules: input.schedules.map(parseMenuSchedule) }
}
