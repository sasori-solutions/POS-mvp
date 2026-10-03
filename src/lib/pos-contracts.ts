export type VatTreatment = 'vat_16' | 'vat_0' | 'exempt' | 'border_8' | 'unconfigured'

import type { PaymentMethod } from './contracts.ts'
import type { OperationsCommand, OperationsResponses, OperationsErrorCode } from './operations-contracts.ts'

export interface Variation {
  id: string; name: string; priceCents: number; sku: string; barcode: string; soldOut: boolean
}
export interface Modifier { id: string; name: string; priceCents: number }
export interface ModifierSet { id: string; name: string; min: number; max: number; options: Modifier[] }
export interface ProductDetails {
  description: string; imageId: string | null; tileColor: string; tileLabel: string
  itemType: 'prepared' | 'physical' | 'service' | 'digital' | 'event' | 'other'
  customerName: string; kitchenName: string; sku: string; barcode: string
  soldOut: boolean; favorite: boolean; variablePrice: boolean
  trackStock: boolean; stock: number; lowStockAlert: number
  costCents: number | null; taxBps: number; taxTreatment?: VatTreatment
  calories: number | null; dietary: string; allergens: string
  variations: Variation[]; modifierSets: ModifierSet[]
}
export interface ItemSelection { variationId: string | null; modifierIds: string[]; variablePriceCents: number | null }

export interface Product {
  id: string
  name: string
  category: string
  priceCents: number
  active: boolean
  version: number
  details?: ProductDetails
  image?: string | null
}

export interface ProductInput {
  productId: string
  expectedVersion: number | null
  name: string
  category: string
  priceCents: number
  details?: ProductDetails
}

export interface CartLine {
  product: Product
  quantity: number
  selection?: ItemSelection
}

export interface SaleInputLine {
  productId: string
  quantity: number
  unitPriceCents: number
  version: number
  selection?: ItemSelection
}

export interface SaleItem {
  productId: string
  name: string
  category: string
  quantity: number
  unitPriceCents: number
  totalCents: number
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
  | ({ command: 'save_product'; operationId: string } & ProductInput)
  | { command: 'set_product_active'; operationId: string; productId: string; expectedVersion: number; active: boolean }
  | { command: 'delete_product'; operationId: string; productId: string; expectedVersion: number }
  | { command: 'set_product_sold_out'; operationId: string; productId: string; expectedVersion: number; soldOut: boolean }
  | { command: 'upload_product_image'; operationId: string; imageId: string; part: number; parts: number; data: string }
  | { command: 'complete_sale'; operationId: string; items: SaleInputLine[]; totalCents: number; paymentMethod: PaymentMethod }
  | { command: 'sales'; cursor: SaleCursor | null }
  | { command: 'sale'; saleId: string }

export interface PosResponses extends OperationsResponses {
  catalog: { products: Product[]; paymentMethods: PaymentMethod[] }
  save_product: Product
  set_product_active: Product
  delete_product: { id: string; deleted: true }
  set_product_sold_out: Product
  upload_product_image: { imageId: string; complete: boolean }
  complete_sale: Sale
  sales: { sales: SaleSummary[]; nextCursor: SaleCursor | null }
  sale: Sale
}

export type PosErrorCode = 'PRODUCT_CHANGED' | 'PRODUCT_UNAVAILABLE' | 'SALE_NOT_FOUND' | 'PAYMENT_METHOD_DISABLED' | OperationsErrorCode
