import type { PaymentMethod } from './contracts.ts'

export interface Product {
  id: string
  name: string
  category: string
  priceCents: number
  active: boolean
  version: number
}

export interface ProductInput {
  productId: string
  expectedVersion: number | null
  name: string
  category: string
  priceCents: number
}

export interface CartLine {
  product: Product
  quantity: number
}

export interface SaleInputLine {
  productId: string
  quantity: number
  unitPriceCents: number
  version: number
}

export interface SaleItem {
  productId: string
  name: string
  category: string
  quantity: number
  unitPriceCents: number
  totalCents: number
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
  | { command: 'catalog' }
  | ({ command: 'save_product'; operationId: string } & ProductInput)
  | { command: 'set_product_active'; operationId: string; productId: string; expectedVersion: number; active: boolean }
  | { command: 'complete_sale'; operationId: string; items: SaleInputLine[]; totalCents: number; paymentMethod: PaymentMethod }
  | { command: 'sales'; cursor: SaleCursor | null }
  | { command: 'sale'; saleId: string }

export interface PosResponses {
  catalog: { products: Product[]; paymentMethods: PaymentMethod[] }
  save_product: Product
  set_product_active: Product
  complete_sale: Sale
  sales: { sales: SaleSummary[]; nextCursor: SaleCursor | null }
  sale: Sale
}

export type PosErrorCode = 'PRODUCT_CHANGED' | 'PRODUCT_UNAVAILABLE' | 'SALE_NOT_FOUND' | 'PAYMENT_METHOD_DISABLED'
