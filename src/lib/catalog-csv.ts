import type { CatalogBulkPatch, CatalogImportProduct, PosCommand, Product, VatTreatment } from './pos-contracts';
import { emptyDetails } from './product-details';
import { parsePrice, priceInput } from './pos';
import { parseProductDetails } from '../../supabase/functions/account/product-validation';
import { parsePosCommand } from '../../supabase/functions/account/pos-validation';

export const catalogCsvMaxRows = 500;
export const catalogCsvMaxBytes = 512 * 1024;
export const catalogBatchMaxBytes = 7000;
export const catalogBatchMaxRows = 20;
export const catalogCsvHeaders = ['formato', 'id', 'version', 'nombre', 'categoria', 'precio_mxn', 'activo', 'iva', 'descripcion', 'sku', 'codigo_barras', 'detalles_json'] as const;
export type CatalogBatchCommand = Extract<PosCommand, { command: 'import_products' | 'bulk_edit_products' }>;
export interface CatalogCsvRow { line: number; name: string; input: CatalogImportProduct | null; existing: Product | null; errors: string[]; warnings: string[] }

function formulaText(value: string): boolean { return /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value); }
function encodeText(value: string): string { return formulaText(value) || value.startsWith("'") ? `'${value}` : value; }
function decodeText(value: string): string { return value.startsWith("'") && (formulaText(value.slice(1)) || value.slice(1).startsWith("'")) ? value.slice(1) : value; }
function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

/** Spreadsheet-safe, lossless text. Photos stay tenant-scoped references, not bytes. */
export function exportCatalogCsv(products: Product[]): string {
  const rows = products.map(product => {
    const details = { ...emptyDetails(), ...product.details };
    return ['pos_mexico_v1', product.id, String(product.version), encodeText(product.name), encodeText(product.category), priceInput(product.priceCents), product.active ? 'si' : 'no', details.taxTreatment ?? '', encodeText(details.description), encodeText(details.sku), encodeText(details.barcode), JSON.stringify(details)];
  });
  return '\uFEFF' + [catalogCsvHeaders.map(csvCell).join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

/** RFC 4180 parser; quotes/newlines are data only inside a quoted cell. */
export function readCatalogCsv(source: string): { line: number; cells: string[] }[] {
  if (new TextEncoder().encode(source).length > catalogCsvMaxBytes) throw new Error('El CSV supera 512 KB. Divide el archivo en partes.');
  const text = source.replace(/^\uFEFF/, '');
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], cell = '', quoted = false, closed = false, line = 1, startLine = 1;
  function pushCell() { cells.push(cell); cell = ''; closed = false; }
  function pushRow() { pushCell(); if (cells.some(value => value !== '')) rows.push({ line: startLine, cells }); cells = []; startLine = line + 1; }
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; closed = true; }
      } else { cell += character; if (character === '\n') line++; }
      continue;
    }
    if (character === '"') { if (cell || closed) throw new Error(`Fila ${line}: revisa las comillas del CSV.`); quoted = true; }
    else if (character === ',') pushCell();
    else if (character === '\r' || character === '\n') {
      pushRow(); if (character === '\r' && text[index + 1] === '\n') index++; line++;
      if (rows.length > catalogCsvMaxRows + 1) throw new Error(`El archivo admite hasta ${catalogCsvMaxRows} productos.`);
    } else { if (closed) throw new Error(`Fila ${line}: hay texto después de cerrar una celda.`); cell += character; }
  }
  if (quoted) throw new Error(`Fila ${startLine}: falta cerrar una celda entre comillas.`);
  if (cell || cells.length || closed) pushRow();
  if (rows.length > catalogCsvMaxRows + 1) throw new Error(`El archivo admite hasta ${catalogCsvMaxRows} productos.`);
  return rows;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taxes: VatTreatment[] = ['vat_16', 'vat_0', 'exempt', 'border_8', 'unconfigured'];
export function previewCatalogCsv(source: string, products: Product[], defaultVat: VatTreatment = 'unconfigured', makeId = () => crypto.randomUUID()): CatalogCsvRow[] {
  const rows = readCatalogCsv(source); if (!rows.length) throw new Error('El archivo está vacío.');
  const headers = rows[0].cells.map(value => value.trim().toLocaleLowerCase('es-MX'));
  if (new Set(headers).size !== headers.length || headers.some(header => !catalogCsvHeaders.includes(header as never))) throw new Error('Revisa las columnas: usa la plantilla del POS y conserva sus encabezados.');
  if (!headers.includes('nombre') || !headers.includes('precio_mxn')) throw new Error('El CSV necesita las columnas nombre y precio_mxn.');
  if (rows.length === 1) throw new Error('El CSV tiene encabezados, pero no contiene productos.');
  const seen = new Set<string>();
  return rows.slice(1).map(row => {
    const errors: string[] = [], warnings: string[] = [];
    const values = Object.fromEntries(headers.map((header, index) => [header, row.cells[index] ?? '']));
    if (row.cells.length !== headers.length) errors.push('La cantidad de columnas no coincide con el encabezado.');
    if (values.formato && values.formato !== 'pos_mexico_v1') errors.push('La versión del formato no es compatible.');
    const text = (key: string) => values.formato === 'pos_mexico_v1' ? decodeText(values[key] ?? '') : values[key] ?? '';
    const name = text('nombre').trim().replace(/\s+/g, ' '); const category = text('categoria').trim().replace(/\s+/g, ' ');
    if (!name || Array.from(name).length > 100 || /[\u0000-\u001f\u007f]/.test(text('nombre'))) errors.push('El nombre debe tener de 1 a 100 caracteres y no incluir saltos de línea.');
    if (Array.from(category).length > 60 || /[\u0000-\u001f\u007f]/.test(text('categoria'))) errors.push('La categoría admite hasta 60 caracteres y no incluye saltos de línea.');
    const price = parsePrice(values.precio_mxn ?? ''); if (price === null) errors.push('Escribe un precio MXN de 0 a 999999.99 con hasta dos decimales.');
    const id = values.id?.trim() || makeId(); if (!uuidPattern.test(id)) errors.push('El ID debe ser un UUID del POS o quedar vacío para un producto nuevo.');
    if (seen.has(id.toLowerCase())) errors.push('Este ID se repite en el archivo.'); seen.add(id.toLowerCase());
    const existing = products.find(product => product.id.toLowerCase() === id.toLowerCase()) ?? null;
    const version = values.version?.trim() ? Number(values.version) : null;
    if (version !== null && (!/^[1-9][0-9]*$/.test(values.version) || !Number.isSafeInteger(version) || version > 2_147_483_647)) errors.push('La versión debe ser un entero positivo del POS.');
    if (existing && version === null) errors.push('Conserva la versión exportada para actualizar este producto.');
    if (existing && version !== existing.version) errors.push('El producto cambió. Exporta nuevamente para conservar los cambios más recientes.');
    if (!existing && version !== null) errors.push('No encontramos este ID y versión en el catálogo actual.');
    const activeText = values.activo?.trim().toLocaleLowerCase('es-MX');
    const active = !activeText ? existing?.active ?? true : ['si', 'sí', 'true', '1'].includes(activeText);
    if (activeText && !['si', 'sí', 'true', '1', 'no', 'false', '0'].includes(activeText)) errors.push('Activo debe ser si o no.');
    let details = existing ? structuredClone({ ...emptyDetails(), ...existing.details }) : emptyDetails();
    try { if (values.detalles_json?.trim()) details = parseProductDetails(JSON.parse(values.detalles_json)); }
    catch { errors.push('detalles_json contiene opciones o valores inválidos. Conserva el JSON exportado o corrígelo en el editor.'); }
    const tax = values.iva?.trim() || details.taxTreatment || (existing || values.detalles_json?.trim() ? undefined : defaultVat);
    if (tax && !taxes.includes(tax as VatTreatment)) errors.push('IVA debe ser vat_16, vat_0, exempt, border_8 o unconfigured.');
    else if (tax) { details.taxTreatment = tax as VatTreatment; details.taxBps = tax === 'vat_16' ? 1600 : tax === 'border_8' ? 800 : 0; }
    for (const [header, key] of [['descripcion', 'description'], ['sku', 'sku'], ['codigo_barras', 'barcode']] as const) if (headers.includes(header)) details[key] = text(header);
    try { details = parseProductDetails(details); } catch { errors.push('Revisa descripción, SKU, código y opciones del producto.'); }
    if (details.imageId && !products.some(product => product.details?.imageId === details.imageId)) errors.push('La imagen no existe en este catálogo. El CSV conserva referencias; añade la foto desde el editor.');
    if (!existing && products.some(product => product.name.toLocaleLowerCase('es-MX') === name.toLocaleLowerCase('es-MX'))) warnings.push('Ya existe un producto con ese nombre. Este registro creará otro producto; usa su ID y versión para actualizarlo.');
    if (details.modifierSets.some(group => group.libraryId) && !existing) warnings.push('Los extras compartidos conservan su vínculo y deben existir en este negocio.');
    const input: CatalogImportProduct = { productId: id, expectedVersion: existing ? version : null, name, category, priceCents: price ?? 0, active, details };
    if (new TextEncoder().encode(JSON.stringify({ command: 'import_products', operationId: makeId(), items: [input] })).length > catalogBatchMaxBytes) errors.push('Este producto supera el tamaño permitido. Edita sus opciones dentro del POS.');
    return { line: row.line, name: name || `Fila ${row.line}`, input: errors.length ? null : input, existing, errors, warnings };
  });
}

export function catalogBatches(inputs: CatalogImportProduct[], makeId = () => crypto.randomUUID()): CatalogBatchCommand[] {
  const batches: CatalogBatchCommand[] = []; let items: CatalogImportProduct[] = [];
  for (const input of inputs) {
    const next = { command: 'import_products' as const, operationId: '0'.repeat(36), items: [...items, input] };
    if (items.length && (items.length >= catalogBatchMaxRows || new TextEncoder().encode(JSON.stringify(next)).length > catalogBatchMaxBytes)) {
      batches.push({ command: 'import_products', operationId: makeId(), items }); items = [];
    }
    items.push(input);
    if (new TextEncoder().encode(JSON.stringify({ ...next, items })).length > catalogBatchMaxBytes) throw new Error(`El producto ${input.name} supera el límite de una solicitud.`);
  }
  if (items.length) batches.push({ command: 'import_products', operationId: makeId(), items }); return batches;
}
export function bulkCatalogBatches(products: Product[], patch: CatalogBulkPatch, makeId = () => crypto.randomUUID()): CatalogBatchCommand[] {
  const batches: CatalogBatchCommand[] = [];
  for (let index = 0; index < products.length; index += catalogBatchMaxRows) batches.push({ command: 'bulk_edit_products', operationId: makeId(), products: products.slice(index, index + catalogBatchMaxRows).map(product => ({ productId: product.id, expectedVersion: product.version })), patch });
  return batches;
}
export function validCatalogBatch(value: unknown): value is CatalogBatchCommand {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || new TextEncoder().encode(JSON.stringify(value)).length > catalogBatchMaxBytes) return false;
    const parsed = parsePosCommand(value as Record<string, unknown>, []);
    return parsed.command === 'import_products' || parsed.command === 'bulk_edit_products';
  } catch { return false; }
}

export function verifyCatalogBatchResponse(command: CatalogBatchCommand, products: Product[]): boolean {
  const inputs = command.command === 'import_products' ? command.items : command.products;
  if (!products.every(product => product && typeof product.id === 'string')) return false;
  if (products.length !== inputs.length || new Set(products.map(product => product.id.toLowerCase())).size !== inputs.length) return false;
  return inputs.every(input => {
    const saved = products.find(product => product.id.toLowerCase() === input.productId.toLowerCase());
    if (!saved || !Number.isInteger(saved.version) || saved.version <= (input.expectedVersion ?? 0) || !Number.isSafeInteger(saved.priceCents) || saved.priceCents < 0 || saved.priceCents > 99_999_999 || typeof saved.active !== 'boolean') return false;
    if (command.command === 'import_products') {
      const requested = command.items.find(item => item.productId === input.productId)!;
      return saved.name === requested.name.trim().replace(/\s+/g, ' ') && saved.category === requested.category.trim().replace(/\s+/g, ' ') && saved.priceCents === requested.priceCents && saved.active === requested.active;
    }
    const patch = command.patch;
    return (patch.category === undefined || saved.category === patch.category.trim().replace(/\s+/g, ' ')) && (patch.active === undefined || saved.active === patch.active) && (patch.priceCents === undefined || saved.priceCents === patch.priceCents) && (patch.vatTreatment === undefined || saved.details?.taxTreatment === patch.vatTreatment);
  });
}
