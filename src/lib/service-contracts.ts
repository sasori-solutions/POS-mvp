import type { CheckoutSelection, KitchenBatch, OperationalOrder } from './operations-contracts.ts'

export interface ServiceVisit {
  id: string; revision: number; name: string; status: 'active' | 'closed'
  createdAt: string; closedAt: string | null; tableIds: string[]
  orders: OperationalOrder[]; balanceCents: number
}
export interface ServiceCourse {
  id: string; orderId: string; name: string; status: 'held' | 'sent' | 'released'
  items: CheckoutSelection[]; batchId: string | null; createdAt: string; sentAt: string | null
  batch?: KitchenBatch | null
}
export interface ServiceOrderState { visit: ServiceVisit | null; courses: ServiceCourse[] }
export type ReservationStatus = 'confirmed' | 'seated' | 'cancelled' | 'no_show' | 'completed'
export interface ServiceReservation {
  id: string; revision: number; name: string; contact: string; partySize: number
  startsAt: string; endsAt: string; tableIds: string[]; note: string; status: ReservationStatus
  visitId: string | null; createdAt: string; updatedAt: string
}
export interface ServiceDay { date: string; timezone: string; reservations: ServiceReservation[]; visits: ServiceVisit[] }
export type ServiceCommand =
  | { command: 'service_day'; date: string }
  | { command: 'service_order'; orderId: string }
  | { command: 'associate_service_tables'; operationId: string; orderId: string; expectedRevision: number; expectedVisitRevision: number | null; tableIds: string[] }
  | { command: 'release_service_visit'; operationId: string; visitId: string; expectedRevision: number }
  | { command: 'continue_service_order'; operationId: string; sourceOrderId: string; expectedRevision: number; orderId: string; name: string }
  | { command: 'save_service_course'; operationId: string; orderId: string; expectedRevision: number; courseId: string; name: string; items: CheckoutSelection[] }
  | { command: 'send_service_course'; operationId: string; orderId: string; expectedRevision: number; courseId: string }
  | { command: 'cancel_service_course'; operationId: string; orderId: string; expectedRevision: number; courseId: string }
  | { command: 'save_service_reservation'; operationId: string; reservationId: string; expectedRevision: number | null; name: string; contact: string; partySize: number; startsAt: string; endsAt: string; tableIds: string[]; note: string }
  | { command: 'set_service_reservation_status'; operationId: string; reservationId: string; expectedRevision: number; status: ReservationStatus; orderId: string | null }
export interface ServiceResponses {
  service_day: ServiceDay
  service_order: ServiceOrderState
  associate_service_tables: { order: OperationalOrder; visit: ServiceVisit }
  release_service_visit: ServiceVisit
  continue_service_order: { order: OperationalOrder; visit: ServiceVisit }
  save_service_course: { order: OperationalOrder; courses: ServiceCourse[] }
  send_service_course: { order: OperationalOrder; courses: ServiceCourse[] }
  cancel_service_course: { order: OperationalOrder; courses: ServiceCourse[] }
  save_service_reservation: ServiceReservation
  set_service_reservation_status: { reservation: ServiceReservation; visit: ServiceVisit | null }
}
export type ServiceErrorCode = 'VISIT_CHANGED' | 'VISIT_BALANCE_PENDING' | 'VISIT_LIMIT_REACHED' | 'RESERVATION_CHANGED' | 'RESERVATION_CONFLICT' | 'COURSE_CHANGED' | 'COURSE_HELD'
export type ServiceMutationCommand = Extract<ServiceCommand, { operationId: string }>
export interface ServiceMutation {
  busy: boolean; pending: unknown; error: string
  execute<C extends ServiceMutationCommand['command']>(command: Extract<ServiceMutationCommand, { command: C }>): Promise<ServiceResponses[C]>
}
