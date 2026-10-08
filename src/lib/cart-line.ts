import type { CartLine, Product, SaleInputLine, VatTreatment } from './pos-contracts';
import type { OrderInputLine, OrderLine } from './operations-contracts';
import { productDetails, selectedPrice, selectionLabel } from './product-details';
import { productVat, vatRates, type VatLine } from './vat';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cartLineName(line: CartLine): string {
  return line.kind === 'amount' ? line.name.trim().replace(/\s+/g, ' ') || 'Importe libre' : line.product.name;
}
export function cartLinePrice(line: CartLine): number {
  return line.kind === 'amount' ? line.unitPriceCents : selectedPrice(line.product, line.selection);
}
export function cartLineSelection(line: CartLine): string {
  return line.kind === 'amount' ? '' : selectionLabel(line.product, line.selection);
}
export function cartLineInput(line: CartLine): SaleInputLine {
  return line.kind === 'amount'
    ? { kind: 'amount', name: line.name.trim().replace(/\s+/g, ' '), quantity: line.quantity, unitPriceCents: line.unitPriceCents }
    : { productId: line.product.id, version: line.product.version, quantity: line.quantity, unitPriceCents: selectedPrice(line.product, line.selection), ...(line.selection ? { selection: line.selection } : {}) };
}
export function cartLineOrderInput(line: CartLine): OrderInputLine {
  return { ...cartLineInput(line), lineId: line.kind === 'amount' && uuid.test(line.id) ? line.id : crypto.randomUUID(), note: '' };
}
export function savedOrderLineInput(line: OrderLine): OrderInputLine {
  return line.kind === 'amount'
    ? { kind: 'amount', lineId: line.lineId, name: line.name, quantity: line.quantity, unitPriceCents: line.unitPriceCents, note: '' }
    : { lineId: line.lineId, productId: line.productId!, version: line.version, quantity: line.quantity, unitPriceCents: line.unitPriceCents, note: line.note, ...(line.selection ? { selection: line.selection } : {}) };
}
export function savedOrderCartLine(line: OrderLine): CartLine {
  return line.kind === 'amount'
    ? { kind: 'amount', id: line.lineId, name: line.name, unitPriceCents: line.unitPriceCents, quantity: line.quantity - line.paidQuantity }
    : { product: { id: line.productId!, name: line.name, category: line.category, active: true, priceCents: line.unitPriceCents, version: line.version }, quantity: line.quantity - line.paidQuantity };
}
export function cartLineVat(line: CartLine, defaultVatTreatment: VatTreatment = 'vat_16'): VatLine {
  if (line.kind === 'amount') return { totalCents: line.unitPriceCents * line.quantity, taxTreatment: defaultVatTreatment, taxBps: vatRates[defaultVatTreatment] };
  const details = productDetails(line.product);
  return { totalCents: selectedPrice(line.product, line.selection) * line.quantity, taxBps: details.taxBps, taxTreatment: productVat(details) };
}
export function saleInputCartLine(line: SaleInputLine, index: number, products: Product[], editable = false): CartLine {
  return 'kind' in line && line.kind === 'amount'
    ? { kind: 'amount', id: editable ? crypto.randomUUID() : `pending-${index}`, name: line.name, unitPriceCents: line.unitPriceCents, quantity: line.quantity }
    : { product: { id: line.productId, name: products.find(product => product.id === line.productId)?.name ?? 'Producto de la venta pendiente', category: '', active: true, priceCents: line.unitPriceCents, version: line.version }, quantity: line.quantity, selection: line.selection };
}
