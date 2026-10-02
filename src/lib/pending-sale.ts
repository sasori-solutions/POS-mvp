import type { PosCommand } from './pos-contracts'

export type PendingSale = Extract<PosCommand, { command: 'complete_sale' }>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Durable retry command only. Never store Google/device/operator credentials or card details. */
export function pendingSaleKey(businessId: string, employeeId: string): string {
  return `pos-mexico-pending-sale:${businessId}:${employeeId}`
}

export function readPendingSale(key: string, storage: Storage = localStorage): PendingSale | null {
  const raw = storage.getItem(key)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as PendingSale
    if (value.command !== 'complete_sale' || !uuid.test(value.operationId) || !['cash', 'card_external', 'transfer'].includes(value.paymentMethod)
      || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 40
      || !Number.isSafeInteger(value.totalCents) || value.totalCents < 0 || value.totalCents > 9_999_999_999
      || value.items.some(line => !uuid.test(line.productId) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 999
        || !Number.isInteger(line.unitPriceCents) || line.unitPriceCents < 0 || line.unitPriceCents > 99_999_999
        || !Number.isInteger(line.version) || line.version < 1 || line.version > 2_147_483_647)
      || new Set(value.items.map(line => line.productId)).size !== value.items.length
      || value.items.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0) !== value.totalCents) throw new Error()
    return { command: 'complete_sale', operationId: value.operationId, items: value.items.map(line => ({
      productId: line.productId, quantity: line.quantity, unitPriceCents: line.unitPriceCents, version: line.version,
    })), totalCents: value.totalCents, paymentMethod: value.paymentMethod }
  } catch {
    throw new Error('Hay un registro pendiente que no pudimos leer. Conserva este dispositivo y pide ayuda antes de volver a cobrar.')
  }
}

export function writePendingSale(key: string, command: PendingSale, storage: Storage = localStorage): void {
  // A failed durable write stops the request, so an uncertain response can always be retried after reload.
  storage.setItem(key, JSON.stringify(command))
}

export function clearPendingSale(key: string, operationId: string, storage: Storage = localStorage): void {
  // Another tab may already have started the next sale. Never erase its recovery command.
  if (readPendingSale(key, storage)?.operationId === operationId) storage.removeItem(key)
}
