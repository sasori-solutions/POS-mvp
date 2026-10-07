import { parseModifierSet, parseProductDetails, parseSelection } from './product-validation.ts'
import { parseOperationsCommand } from './operations-validation.ts'
import type { PosCommand, ProductSaleInputLine, SaleInputLine, VatTreatment } from '../../../src/lib/pos-contracts.ts'
import type { PaymentMethod } from '../../../src/lib/contracts.ts'
import { isUuid, RequestValidationError } from './validation.ts'

function invalid(): never { throw new RequestValidationError() }
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid()
  return value
}
function uuid(value: unknown): string { if (!isUuid(value)) invalid(); return value }
function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) invalid()
  const result = value.trim().replace(/\s+/g, ' ')
  if (Array.from(result).length < min || Array.from(result).length > max) invalid()
  return result
}

export function parsePosCommand(input: Record<string, unknown>, accessKeys: string[]): PosCommand {
  const operation = parseOperationsCommand(input, accessKeys)
  if (operation) return operation
  const keys = (extra: string[]) => exactKeys(input, [...accessKeys, 'command', ...extra])
  switch (input.command) {
    case 'import_products': {
      keys(['operationId', 'items'])
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) invalid()
      const items = input.items.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
        const item = value as Record<string, unknown>
        exactKeys(item, ['productId', 'expectedVersion', 'name', 'category', 'priceCents', 'active', ...(Object.hasOwn(item, 'details') ? ['details'] : [])])
        if (typeof item.active !== 'boolean') invalid()
        const { active, ...payload } = item
        const parsed = parsePosCommand({ ...payload, command: 'save_product', operationId: input.operationId }, [])
        if (parsed.command !== 'save_product') invalid()
        const { command: _command, operationId: _operationId, ...product } = parsed
        return { ...product, active: active as boolean }
      })
      if (new Set(items.map(item => item.productId.toLowerCase())).size !== items.length) invalid()
      return { command: 'import_products', operationId: uuid(input.operationId), items }
    }
    case 'bulk_edit_products': {
      keys(['operationId', 'products', 'patch'])
      if (!Array.isArray(input.products) || input.products.length < 1 || input.products.length > 20 || !input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) invalid()
      const products = input.products.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
        const item = value as Record<string, unknown>; exactKeys(item, ['productId', 'expectedVersion'])
        return { productId: uuid(item.productId), expectedVersion: integer(item.expectedVersion, 1, 2_147_483_647) }
      })
      if (new Set(products.map(item => item.productId.toLowerCase())).size !== products.length) invalid()
      const patch = input.patch as Record<string, unknown>
      if (Object.keys(patch).length < 1 || Object.keys(patch).some(key => !['category', 'active', 'priceCents', 'vatTreatment'].includes(key))) invalid()
      if (Object.hasOwn(patch, 'active') && typeof patch.active !== 'boolean') invalid()
      if (Object.hasOwn(patch, 'vatTreatment') && !['vat_16', 'vat_0', 'exempt', 'border_8', 'unconfigured'].includes(patch.vatTreatment as string)) invalid()
      return { command: 'bulk_edit_products', operationId: uuid(input.operationId), products, patch: {
        ...(Object.hasOwn(patch, 'category') ? { category: text(patch.category, 0, 60) } : {}),
        ...(Object.hasOwn(patch, 'priceCents') ? { priceCents: integer(patch.priceCents, 0, 99_999_999) } : {}),
        ...(Object.hasOwn(patch, 'active') ? { active: patch.active as boolean } : {}),
        ...(Object.hasOwn(patch, 'vatTreatment') ? { vatTreatment: patch.vatTreatment as VatTreatment } : {}),
      } }
    }
    case 'catalog': keys([]); return { command: 'catalog' }
    case 'modifier_groups': keys([]); return { command: 'modifier_groups' }
    case 'save_modifier_group': {
      keys(['operationId', 'groupId', 'expectedVersion', 'name', 'min', 'max', 'options'])
      const group = parseModifierSet({ id: input.groupId, name: input.name, min: input.min, max: input.max, options: input.options })
      return { command: 'save_modifier_group', operationId: uuid(input.operationId), groupId: group.id,
        expectedVersion: input.expectedVersion === null ? null : integer(input.expectedVersion, 1, 2_147_483_647),
        name: group.name, min: group.min, max: group.max, options: group.options }
    }
    case 'set_modifier_option_sold_out':
      keys(['operationId', 'productId', 'expectedVersion', 'modifierId', 'soldOut'])
      if (typeof input.soldOut !== 'boolean') invalid()
      return { command: 'set_modifier_option_sold_out', operationId: uuid(input.operationId), productId: uuid(input.productId),
        expectedVersion: integer(input.expectedVersion, 1, 2_147_483_647), modifierId: uuid(input.modifierId), soldOut: input.soldOut }
    case 'save_product':
      keys(['operationId', 'productId', 'expectedVersion', 'name', 'category', 'priceCents', ...(Object.hasOwn(input, 'details') ? ['details'] : [])])
      return { command: input.command, operationId: uuid(input.operationId), productId: uuid(input.productId),
        expectedVersion: input.expectedVersion === null ? null : integer(input.expectedVersion, 1, 2_147_483_647),
        name: text(input.name, 1, 100), category: text(input.category, 0, 60), priceCents: integer(input.priceCents, 0, 99_999_999), ...(Object.hasOwn(input, 'details') ? { details: parseProductDetails(input.details) } : {}) }
    case 'delete_product':
      keys(['operationId', 'productId', 'expectedVersion'])
      return { command: input.command, operationId: uuid(input.operationId), productId: uuid(input.productId),
        expectedVersion: integer(input.expectedVersion, 1, 2_147_483_647) }
    case 'set_product_active':
      keys(['operationId', 'productId', 'expectedVersion', 'active'])
      if (typeof input.active !== 'boolean') invalid()
      return { command: input.command, operationId: uuid(input.operationId), productId: uuid(input.productId),
        expectedVersion: integer(input.expectedVersion, 1, 2_147_483_647), active: input.active }
    case 'set_product_sold_out':
      keys(['operationId', 'productId', 'expectedVersion', 'soldOut', ...(Object.hasOwn(input, 'variationId') ? ['variationId'] : [])])
      if (typeof input.soldOut !== 'boolean') invalid()
      return { command: input.command, operationId: uuid(input.operationId), productId: uuid(input.productId), expectedVersion: integer(input.expectedVersion, 1, 2_147_483_647), soldOut: input.soldOut, ...(Object.hasOwn(input, 'variationId') ? {variationId: uuid(input.variationId)} : {}) }
    case 'upload_product_image':
      keys(['operationId', 'imageId', 'part', 'parts', 'data'])
      if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/=]{1,4096}$/.test(input.data)) invalid()
      if (integer(input.part, 0, 59) >= integer(input.parts, 1, 60)) invalid()
      return { command: input.command, operationId: uuid(input.operationId), imageId: uuid(input.imageId), part: input.part as number, parts: input.parts as number, data: input.data }
    case 'complete_sale': {
      keys(['operationId', 'items', 'totalCents', 'paymentMethod'])
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 40) invalid()
      if (!['cash', 'card_external', 'transfer'].includes(input.paymentMethod as string)) invalid()
      const items: SaleInputLine[] = input.items.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
        const line = value as Record<string, unknown>
        if (line.kind === 'amount') {
          exactKeys(line, ['kind', 'name', 'quantity', 'unitPriceCents'])
          return { kind:'amount' as const, name:text(line.name,0,100), quantity:integer(line.quantity,1,999), unitPriceCents:integer(line.unitPriceCents,1,99_999_999) }
        }
        exactKeys(line, ['productId', 'quantity', 'unitPriceCents', 'version', ...(Object.hasOwn(line, 'selection') ? ['selection'] : [])])
        return { productId: uuid(line.productId), quantity: integer(line.quantity, 1, 999),
          unitPriceCents: integer(line.unitPriceCents, 0, 99_999_999), version: integer(line.version, 1, 2_147_483_647), ...(Object.hasOwn(line, 'selection') ? { selection: parseSelection(line.selection) } : {}) }
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      const productItems = items.filter((line): line is ProductSaleInputLine => line.kind !== 'amount')
      if (new Set(productItems.map(line => JSON.stringify([line.productId, line.selection]))).size !== productItems.length) invalid()
      const totalCents = integer(input.totalCents, 0, 9_999_999_999)
      if (items.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0) !== totalCents) invalid()
      return { command: input.command, operationId: uuid(input.operationId), items, totalCents, paymentMethod: input.paymentMethod as PaymentMethod }
    }
    case 'sales': {
      keys(['cursor'])
      if (input.cursor === null) return { command: 'sales', cursor: null }
      if (!input.cursor || typeof input.cursor !== 'object' || Array.isArray(input.cursor)) invalid()
      const cursor = input.cursor as Record<string, unknown>
      exactKeys(cursor, ['createdAt', 'id'])
      if (typeof cursor.createdAt !== 'string' || cursor.createdAt.length > 40
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.createdAt)
        || !Number.isFinite(Date.parse(cursor.createdAt))) invalid()
      return { command: 'sales', cursor: { createdAt: cursor.createdAt, id: uuid(cursor.id) } }
    }
    case 'sale': keys(['saleId']); return { command: 'sale', saleId: uuid(input.saleId) }
    default: return invalid()
  }
}
