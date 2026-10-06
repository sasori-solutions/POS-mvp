import type { ItemSelection, PosCommand, SaleInputLine } from './pos-contracts'

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
      || !Number.isSafeInteger(value.totalCents) || value.totalCents < 0 || value.totalCents > 9_999_999_999) throw new Error()
    const items = value.items.map(validatedLine)
    const products = items.filter(line => 'productId' in line)
    if (new Set(products.map(line => JSON.stringify([line.productId, validatedSelection(line.selection)]))).size !== products.length
      || items.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0) !== value.totalCents) throw new Error()
    return { command: 'complete_sale', operationId: value.operationId, items, totalCents: value.totalCents, paymentMethod: value.paymentMethod }
  } catch {
    throw new Error('Hay un registro pendiente que no pudimos leer. Conserva este dispositivo y pide ayuda antes de volver a cobrar.')
  }
}

function validatedLine(value: unknown): SaleInputLine {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid line')
  const line = value as Record<string, unknown>
  if (!Number.isInteger(line.quantity) || Number(line.quantity) < 1 || Number(line.quantity) > 999
    || !Number.isInteger(line.unitPriceCents) || Number(line.unitPriceCents) < 0 || Number(line.unitPriceCents) > 99_999_999) throw new Error('Invalid line')
  const quantity = Number(line.quantity), unitPriceCents = Number(line.unitPriceCents)
  if (line.kind === 'amount') {
    if (Object.keys(line).length !== 4 || typeof line.name !== 'string' || [...line.name].length > 100 || unitPriceCents < 1) throw new Error('Invalid amount')
    return { kind: 'amount', name: line.name, quantity, unitPriceCents }
  }
  if ('kind' in line || typeof line.productId !== 'string' || !uuid.test(line.productId)
    || !Number.isInteger(line.version) || Number(line.version) < 1 || Number(line.version) > 2_147_483_647) throw new Error('Invalid product')
  const selection = validatedSelection(line.selection as ItemSelection | undefined)
  return { productId: line.productId, quantity, unitPriceCents, version: Number(line.version), ...(selection ? { selection } : {}) }
}

export function writePendingSale(key: string, command: PendingSale, storage: Storage = localStorage): void {
  // A failed durable write stops the request, so an uncertain response can always be retried after reload.
  storage.setItem(key, JSON.stringify(command))
}

export function clearPendingSale(key: string, operationId: string, storage: Storage = localStorage): void {
  // Another tab may already have started the next sale. Never erase its recovery command.
  if (readPendingSale(key, storage)?.operationId === operationId) storage.removeItem(key)
}

function validatedSelection(value: ItemSelection | undefined): ItemSelection | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || !['variationId','modifierIds','variablePriceCents'].every(key => Object.hasOwn(value,key))
    || (value.variationId !== null && !uuid.test(value.variationId))
    || !Array.isArray(value.modifierIds) || value.modifierIds.length > 24 || value.modifierIds.some(id => !uuid.test(id))
    || new Set(value.modifierIds).size !== value.modifierIds.length
    || (value.variablePriceCents !== null && (!Number.isSafeInteger(value.variablePriceCents) || value.variablePriceCents < 0 || value.variablePriceCents > 99_999_999))) throw new Error('Invalid selection')
  return { variationId: value.variationId, modifierIds: [...value.modifierIds].sort(), variablePriceCents: value.variablePriceCents }
}
