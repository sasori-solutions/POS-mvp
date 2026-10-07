import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { catalogBatches, catalogBatchMaxBytes, exportCatalogCsv, previewCatalogCsv, readCatalogCsv, validCatalogBatch } from '../../src/lib/catalog-csv';
import { emptyDetails } from '../../src/lib/product-details';
import type { Product } from '../../src/lib/pos-contracts';
import { parsePosCommand } from '../../supabase/functions/account/pos-validation';

describe('catalogue CSV preview and bounded mutations', () => {
  it('round trips descriptions, cents, names, variants, negative/repeat extras and shared references without losing ids', () => {
    const group = randomUUID();
    const product: Product = { id: randomUUID(), name: '=Café, "Especial"', category: "'=Bebidas", priceCents: 12345, active: false, version: 7,
      details: { ...emptyDetails(), description: '+Descripción', sku: '00012', barcode: '001234', taxTreatment: 'vat_16', taxBps: 1600,
        variations: [{ id: randomUUID(), name: 'Grande', priceCents: 13567, sku: '00013', barcode: '', soldOut: false }],
        modifierSets: [{ id: group, libraryId: group, name: 'Leches', min: 0, max: 2, options: [{ id: randomUUID(), name: 'Sin leche', priceCents: -100, soldOut: true, maxQuantity: 2 }] }] } };
    const csv = exportCatalogCsv([product]);
    const rows = readCatalogCsv(csv); expect(rows[1].cells[3]).toBe("'=Café, \"Especial\"");
    const preview = previewCatalogCsv(csv, [product]);
    expect(preview[0].errors).toEqual([]); expect(preview[0].input).toMatchObject({ productId: product.id, expectedVersion: 7, name: product.name, category: product.category, priceCents: 12345, active: false, details: product.details });
    expect(preview[0].input!.details!.barcode).toBe('001234');
  });

  it('preserves legacy exact VAT when no fiscal treatment was recorded', () => {
    const product: Product = { id: randomUUID(), name: 'Anterior', category: '', priceCents: 1001, active: true, version: 1, details: { ...emptyDetails(), taxBps: 1600 } };
    const row = previewCatalogCsv(exportCatalogCsv([product]), [product])[0];
    expect(row.errors).toEqual([]); expect(row.input!.details!.taxBps).toBe(1600); expect(row.input!.details).not.toHaveProperty('taxTreatment');
  });

  it('supports small external menus with explicit business tax defaults and per-row errors', () => {
    const rows = previewCatalogCsv('nombre,precio_mxn,categoria\r\nCafé,10.01,Bebidas\r\nTé,1.001,Bebidas\r\n,9,Comida', [], 'exempt');
    expect(rows[0].input).toMatchObject({ expectedVersion: null, priceCents: 1001, details: { taxTreatment: 'exempt', taxBps: 0 } });
    expect(rows[1].errors[0]).toMatch(/precio/); expect(rows[2].errors[0]).toMatch(/nombre/);
    expect(rows[1].line).toBe(3);
  });

  it('rejects malformed/unknown/stale rows before a request and warns on duplicate names', () => {
    const product: Product = { id: randomUUID(), name: 'Café', category: '', priceCents: 100, active: true, version: 3 };
    expect(() => readCatalogCsv('nombre,precio_mxn\n"Café,1')).toThrow(/comillas/);
    expect(() => previewCatalogCsv('nombre,precio_mxn,secreto\nCafé,1,no', [])).toThrow(/columnas/);
    const stale = previewCatalogCsv(`id,version,nombre,precio_mxn\n${product.id},2,Café,1`, [product]);
    expect(stale[0].errors).toContain('El producto cambió. Exporta nuevamente para conservar los cambios más recientes.');
    const duplicate = previewCatalogCsv('nombre,precio_mxn\nCafé,1', [product]); expect(duplicate[0].warnings[0]).toMatch(/Ya existe/);
    const unknownPhoto = previewCatalogCsv(`nombre,precio_mxn,detalles_json\nCafé,1,"${JSON.stringify({ ...emptyDetails(), imageId: randomUUID() }).replaceAll('"', '""')}"`, []);
    expect(unknownPhoto[0].errors).toContain('La imagen no existe en este catálogo. El CSV conserva referencias; añade la foto desde el editor.');
  });

  it('parses quoted commas, escaped quotes and CRLF correctly', () => {
    expect(readCatalogCsv('\uFEFFnombre,descripcion\r\n"Café, doble","Dijo ""hola""\r\nSegundo"\r\n')).toEqual([{ line: 1, cells: ['nombre', 'descripcion'] }, { line: 2, cells: ['Café, doble', 'Dijo "hola"\r\nSegundo'] }]);
  });

  it('limits batch bytes as UTF-8, preserves original payloads and validates bulk exact keys', () => {
    const inputs = Array.from({ length: 33 }, (_, index) => ({ productId: randomUUID(), expectedVersion: null, name: `Producto ${index}`, category: '', priceCents: 101, active: true, details: { ...emptyDetails(), description: 'á'.repeat(400) } }));
    const batches = catalogBatches(inputs); expect(batches.length).toBeGreaterThan(2);
    expect(batches.reduce((sum, batch) => sum + (batch.command === 'import_products' ? batch.items.length : 0), 0)).toBe(33);
    for (const batch of batches) { expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(catalogBatchMaxBytes); expect(validCatalogBatch(batch)).toBe(true); }
    const bulk = { command: 'bulk_edit_products', operationId: randomUUID(), products: [{ productId: randomUUID(), expectedVersion: 2 }], patch: { category: 'Bebidas', active: false, priceCents: 1001, vatTreatment: 'vat_16' } };
    expect(parsePosCommand(bulk, [])).toEqual(bulk);
    expect(validCatalogBatch({ ...bulk, patch: { secret: 'no' } })).toBe(false);
    expect(validCatalogBatch({ ...bulk, products: [...bulk.products, ...bulk.products] })).toBe(false);
  });
});
