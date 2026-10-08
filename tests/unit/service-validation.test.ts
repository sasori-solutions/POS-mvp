import { describe, expect, test } from 'vitest'
import { parsePosCommand } from '../../supabase/functions/account/pos-validation'
import { serviceLocalInput, serviceLocalTimestamp } from '../../src/lib/service-time'

const id = '00000000-0000-4000-8000-000000000001', id2 = '00000000-0000-4000-8000-000000000002'
const reservation = { command: 'save_service_reservation', operationId: id, reservationId: id2, expectedRevision: null, name: '  Mesa  de amigos ', contact: '', partySize: 2, startsAt: '2026-10-09T12:00:00-06:00', endsAt: '2026-10-09T20:00:00Z', tableIds: [id2, id], note: '' }
const course = { command: 'save_service_course', operationId: id, orderId: id, expectedRevision: 1, courseId: id2, name: ' Principales ', items: [{ lineId: id2, quantity: 2 }, { lineId: id, quantity: 1 }] }
describe('strict restaurant service HTTP boundary', () => {
  test('normalizes text, ordering and timestamps without private or financial fields', () => {
    expect(parsePosCommand(reservation, [])).toEqual({ ...reservation, name: 'Mesa de amigos', startsAt: '2026-10-09T18:00:00.000Z', endsAt: '2026-10-09T20:00:00.000Z', tableIds: [id, id2] })
    expect(parsePosCommand(course, [])).toEqual({ ...course, name: 'Principales', items: [{ lineId: id, quantity: 1 }, { lineId: id2, quantity: 2 }] })
  })
  test.each([{ balanceCents: 10 }, { employeeId: id }, { expectedRevision: 0 }, { expectedRevision: 1.1 }, { courseId: 'wrong' }, { items: [] }, { items: [{ lineId: id, quantity: 1 }, { lineId: id, quantity: 2 }] }, { items: [{ lineId: id, quantity: 1.5 }] }, { items: [{ lineId: id, quantity: 1, priceCents: 1 }] }])('rejects course forgery and invalid quantities: %j', patch => {
    expect(() => parsePosCommand({ ...course, ...patch }, [])).toThrow()
  })
  test.each([{ tableIds: [id, id] }, { tableIds: [null] }, { partySize: 0 }, { contact: 'texto\ncontrol' }, { startsAt: '2026-02-30T12:00:00Z' }, { startsAt: '2026-10-09T24:00:00Z' }, { startsAt: '2026-10-09T12:00:00+14:01' }, { startsAt: '2026-10-09T12:00:00' }, { startsAt: '2026-10-09T20:00:00Z' }, { endsAt: '2026-10-09T18:14:59Z' }, { endsAt: '2026-10-10T06:00:01Z' }])('rejects reservation bounds/calendar mistakes: %j', patch => {
    expect(() => parsePosCommand({ ...reservation, ...patch }, [])).toThrow()
  })
  test('validates real days and links accounts only for arrivals', () => {
    expect(parsePosCommand({ command: 'service_day', date: '2028-02-29' }, [])).toEqual({ command: 'service_day', date: '2028-02-29' })
    for (const date of ['2026-02-29', '2026-2-01', '1999-12-31', '2101-01-01']) expect(() => parsePosCommand({ command: 'service_day', date }, [])).toThrow()
    const status = { command: 'set_service_reservation_status', operationId: id, reservationId: id2, expectedRevision: 1, status: 'seated', orderId: id }
    expect(parsePosCommand(status, [])).toEqual(status)
    expect(() => parsePosCommand({ ...status, orderId: null }, [])).toThrow()
    expect(() => parsePosCommand({ ...status, status: 'cancelled' }, [])).toThrow()
  })
  test('requires the independent visit revision to associate tables', () => {
    const command = { command: 'associate_service_tables', operationId: id, orderId: id, expectedRevision: 2, expectedVisitRevision: null, tableIds: [] }
    expect(parsePosCommand(command, [])).toEqual(command)
    expect(parsePosCommand({ ...command, expectedVisitRevision: 3 }, [])).toMatchObject({ expectedVisitRevision: 3 })
    expect(() => parsePosCommand({ ...command, expectedVisitRevision: 0 }, [])).toThrow()
    const { expectedVisitRevision: _omitted, ...missing } = command
    expect(() => parsePosCommand(missing, [])).toThrow()
  })
})
describe('business-local reservation time', () => {
  test('uses Mexico City rather than the device timezone', () => {
    expect(serviceLocalTimestamp('2026-10-09T12:00', 'America/Mexico_City')).toBe('2026-10-09T18:00:00.000Z')
    expect(serviceLocalInput('2026-10-09T18:00:00Z', 'America/Mexico_City')).toBe('2026-10-09T12:00')
    expect(serviceLocalTimestamp('2026-10-09T12:00', 'America/Cancun')).toBe('2026-10-09T17:00:00.000Z')
  })
  test('rejects impossible calendar days, DST gaps and repeated hours', () => {
    expect(serviceLocalTimestamp('2026-02-30T12:00', 'America/Mexico_City')).toBeNull()
    expect(serviceLocalTimestamp('2026-03-08T02:30', 'America/New_York')).toBeNull()
    expect(serviceLocalTimestamp('2026-11-01T01:30', 'America/New_York')).toBeNull()
    expect(serviceLocalTimestamp('2026-11-01T03:30', 'America/New_York')).toBe('2026-11-01T08:30:00.000Z')
  })
})
