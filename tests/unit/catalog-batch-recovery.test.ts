// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearCatalogBatchPlan, loadCatalogBatchPlan, saveCatalogBatchPlan, type CatalogBatchPlan } from '../../src/lib/catalog-batch-recovery';

beforeEach(() => localStorage.clear());
function plan(): CatalogBatchPlan { return { version: 1, businessId: randomUUID(), actorId: randomUUID(), completed: 0, uncertain: true, batches: [{ command: 'bulk_edit_products', operationId: randomUUID(), products: [{ productId: randomUUID(), expectedVersion: 3 }], patch: { priceCents: 1001 } }] }; }
describe('catalogue payload recovery scope', () => {
  it('stores only catalogue payloads scoped by business and actor, preserving UUID and expected versions', () => {
    const value = plan(); saveCatalogBatchPlan({ ...value, operatorToken: 'must never persist', pin: '123456' } as CatalogBatchPlan);
    expect(loadCatalogBatchPlan(value.businessId, value.actorId)).toEqual(value);
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('must never persist');
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('123456');
    expect(loadCatalogBatchPlan(randomUUID(), value.actorId)).toBeNull(); expect(loadCatalogBatchPlan(value.businessId, randomUUID())).toBeNull();
    clearCatalogBatchPlan(value.businessId, randomUUID()); expect(loadCatalogBatchPlan(value.businessId, value.actorId)).toEqual(value);
  });
  it('rejects unknown keys, mutated scope, invalid progress and oversized payloads rather than guessing a new operation', () => {
    const value = plan(); const key = `pos-catalog-batches-v1:${value.businessId}:${value.actorId}`;
    for (const change of [{ completed: 2 }, { actorId: randomUUID() }, { token: 'no' }, { batches: [{ ...value.batches[0], patch: { unknown: true } }] }, { batches: [{ ...value.batches[0], patch: { category: 'á'.repeat(8000) } }] }]) {
      localStorage.setItem(key, JSON.stringify({ ...value, ...change }));
      expect(() => loadCatalogBatchPlan(value.businessId, value.actorId)).toThrow(/recuperación/);
    }
  });
  it('cannot overwrite or clear another operation under the same business and actor', () => {
    const previous = plan(), current = { ...plan(), businessId: previous.businessId, actorId: previous.actorId };
    saveCatalogBatchPlan(current);
    expect(() => saveCatalogBatchPlan({ ...previous, completed: 1, uncertain: false }, previous)).toThrow(/otra sesión/);
    expect(() => clearCatalogBatchPlan(previous.businessId, previous.actorId, previous)).toThrow(/otra sesión/);
    expect(loadCatalogBatchPlan(current.businessId, current.actorId)).toEqual(current);
    const changedPayload = { ...previous, batches: previous.batches.map(batch => batch.command === 'bulk_edit_products' ? { ...batch, patch: { priceCents: 999 } } : batch) };
    localStorage.setItem(`pos-catalog-batches-v1:${previous.businessId}:${previous.actorId}`, JSON.stringify(changedPayload));
    expect(() => clearCatalogBatchPlan(previous.businessId, previous.actorId, previous)).toThrow(/otra sesión/);
    expect(loadCatalogBatchPlan(previous.businessId, previous.actorId)).toEqual(changedPayload);
  });
});
