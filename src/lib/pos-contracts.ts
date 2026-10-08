export type VatTreatment = 'vat_16' | 'vat_0' | 'exempt' | 'border_8' | 'unconfigured'

import type { PaymentMethod } from './contracts.ts'
import type { OperationsCommand, OperationsResponses, OperationsErrorCode } from './operations-contracts.ts'

export interface Variation {
  id: string; name: string; priceCents: number; sku: string; barcode: string; soldOut: boolean
}
export interface Modifier { id: string; name: string; priceCents: number; soldOut?: boolean; maxQuantity?: number }
export interface ModifierSet { id: string; name: string; min: number; max: number; options: Modifier[]; libraryId?: string; parentOptionId?: string }
export interface SharedModifierGroup extends ModifierSet { version: number; linkedProducts: { id: string; name: string }[] }
export interface ProductAttribute { name: string; value: string }
export interface ProductDetails {
  description: string; imageId: string | null; tileColor: string; tileLabel: string
  itemType: 'prepared' | 'physical' | 'service' | 'digital' | 'event' | 'other'
  customerName: string; kitchenName: string; sku: string; barcode: string
  soldOut: boolean; favorite: boolean; variablePrice: boolean
  trackStock: boolean; stock: number; lowStockAlert: number
  costCents: number | null; taxBps: number; taxTreatment?: VatTreatment
  calories: number | null; dietary: string; allergens: string
  variations: Variation[]; modifierSets: ModifierSet[]
  skipCustomization?: boolean; customAttributes?: ProductAttribute[]; comboComponents?: ComboComponentInput[]
}
export interface ItemSelection { variationId: string | null; modifierIds: string[]; variablePriceCents: number | null }
export interface ComboComponentInput { productId: string; version: number; quantity: number; selection?: ItemSelection }
/** Fixed preparation per combo unit, captured when the catalog configuration is accepted. */
export interface ComboComponentSnapshot { productId: string; version: number; quantity: number; name: string; kitchenName: string; selectionLabel: string }

export interface Product {
  id: string
  name: string
  category: string
  priceCents: number
  active: boolean
  version: number
  details?: ProductDetails
  image?: string | null
  comboComponents?: ComboComponentSnapshot[]
  comboUnavailableReason?: string | null
}

export interface ProductInput {
  productId: string
  expectedVersion: number | null
  name: string
  category: string
  priceCents: number
  details?: ProductDetails
}
export interface CatalogImportProduct extends ProductInput { active: boolean }
export interface CatalogBulkPatch { category?: string; active?: boolean; priceCents?: number; vatTreatment?: VatTreatment }

export interface ProductCartLine {
  kind?: 'product'
  product: Product
  quantity: number
  selection?: ItemSelection
}
export interface AmountCartLine { kind: 'amount'; id: string; name: string; quantity: number; unitPriceCents: number }
export type CartLine = ProductCartLine | AmountCartLine

export interface ProductSaleInputLine {
  kind?: undefined
  productId: string
  quantity: number
  unitPriceCents: number
  version: number
  selection?: ItemSelection
}
export interface AmountSaleInputLine { kind: 'amount'; name: string; quantity: number; unitPriceCents: number }
export type SaleInputLine = ProductSaleInputLine | AmountSaleInputLine

export interface SaleItem {
  comboComponents?: ComboComponentSnapshot[]
  allocatedGrossCents?: number
  kind?: 'product' | 'amount'
  productId: string | null
  name: string
  category: string
  quantity: number
  unitPriceCents: number
  totalCents: number
  discountCents?: number
  selectionLabel?: string
  taxCents?: number
  taxBps?: number | null
  taxTreatment?: VatTreatment | 'legacy'
}

export interface SaleSummary {
  id: string
  createdAt: string
  timezone: string
  totalCents: number
  paymentMethod: PaymentMethod
  itemCount: number
  operatorName: string
}

export interface Sale extends SaleSummary {
  items: SaleItem[]
}

export interface SaleCursor { createdAt: string; id: string }

export type PosCommand =
  | OperationsCommand
  | { command: 'catalog' }
  | { command: 'modifier_groups' }
  | { command: 'save_modifier_group'; operationId: string; groupId: string; expectedVersion: number | null; name: string; min: number; max: number; options: Modifier[] }
  | { command: 'set_modifier_option_sold_out'; operationId: string; productId: string; expectedVersion: number; modifierId: string; soldOut: boolean }
  | ({ command: 'save_product'; operationId: string } & ProductInput)
  | { command: 'import_products'; operationId: string; items: CatalogImportProduct[] }
  | { command: 'bulk_edit_products'; operationId: string; products: { productId: string; expectedVersion: number }[]; patch: CatalogBulkPatch }
  | { command: 'set_product_active'; operationId: string; productId: string; expectedVersion: number; active: boolean }
  | { command: 'delete_product'; operationId: string; productId: string; expectedVersion: number }
  | { command: 'set_product_sold_out'; operationId: string; productId: string; expectedVersion: number; soldOut: boolean; variationId?: string }
  | { command: 'upload_product_image'; operationId: string; imageId: string; part: number; parts: number; data: string }
  | { command: 'complete_sale'; operationId: string; items: SaleInputLine[]; totalCents: number; paymentMethod: PaymentMethod }
  | { command: 'sales'; cursor: SaleCursor | null }
  | { command: 'sale'; saleId: string }

export interface PosResponses extends OperationsResponses {
  catalog: { products: Product[]; paymentMethods: PaymentMethod[] }
  modifier_groups: { groups: SharedModifierGroup[] }
  save_modifier_group: { group: SharedModifierGroup; products: Product[] }
  set_modifier_option_sold_out: { products: Product[]; group?: SharedModifierGroup }
  save_product: Product
  import_products: { products: Product[] }
  bulk_edit_products: { products: Product[] }
  set_product_active: Product
  delete_product: { id: string; deleted: true }
  set_product_sold_out: Product
  upload_product_image: { imageId: string; complete: boolean }
  complete_sale: Sale
  sales: { sales: SaleSummary[]; nextCursor: SaleCursor | null }
  sale: Sale
}

export type PosErrorCode = 'PRODUCT_CHANGED' | 'PRODUCT_UNAVAILABLE' | 'SALE_NOT_FOUND' | 'PAYMENT_METHOD_DISABLED' | OperationsErrorCode
