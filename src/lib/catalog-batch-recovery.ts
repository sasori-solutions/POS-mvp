import { validCatalogBatch, type CatalogBatchCommand } from './catalog-csv';

export interface CatalogBatchPlan { version: 1; businessId: string; actorId: string; batches: CatalogBatchCommand[]; completed: number; uncertain: boolean }
function key(businessId: string, actorId: string) { return `pos-catalog-batches-v1:${businessId}:${actorId}`; }
export class CatalogRecoveryConflictError extends Error {
  constructor() { super('La edición guardada cambió en otra sesión o pestaña. Reabre Gestionar catálogo para recuperar ese registro.'); }
}
function encodePlan(plan: CatalogBatchPlan) { return JSON.stringify({ version: plan.version, businessId: plan.businessId, actorId: plan.actorId, batches: plan.batches, completed: plan.completed, uncertain: plan.uncertain }); }
export function assertCatalogBatchPlan(businessId: string, actorId: string, expected: CatalogBatchPlan | null) {
  const stored = loadCatalogBatchPlan(businessId, actorId);
  if (Boolean(stored) !== Boolean(expected) || stored && expected && encodePlan(stored) !== encodePlan(expected)) throw new CatalogRecoveryConflictError();
}
export function loadCatalogBatchPlan(businessId: string, actorId: string): CatalogBatchPlan | null {
  const value = localStorage.getItem(key(businessId, actorId)); if (!value) return null;
  const plan = JSON.parse(value) as CatalogBatchPlan;
  if (!plan || Object.keys(plan).some(field => !['version', 'businessId', 'actorId', 'batches', 'completed', 'uncertain'].includes(field)) || plan.version !== 1 || plan.businessId !== businessId || plan.actorId !== actorId || !Array.isArray(plan.batches) || !plan.batches.length || plan.batches.length > 500
    || !plan.batches.every(validCatalogBatch) || !Number.isInteger(plan.completed) || plan.completed < 0 || plan.completed > plan.batches.length || typeof plan.uncertain !== 'boolean') throw new Error('La recuperación del catálogo no es válida. Conserva el archivo y revisa los productos antes de importar otra vez.');
  return plan;
}
/** Only catalogue payloads: never an operator token, device credential or PIN. */
export function saveCatalogBatchPlan(plan: CatalogBatchPlan, expected?: CatalogBatchPlan | null): void {
  if (expected !== undefined) assertCatalogBatchPlan(plan.businessId, plan.actorId, expected);
  const encoded = encodePlan(plan); const item = key(plan.businessId, plan.actorId);
  localStorage.setItem(item, encoded);
  if (localStorage.getItem(item) !== encoded) throw new Error('No pudimos conservar la solicitud. Permite el almacenamiento del navegador antes de guardar.');
}
export function clearCatalogBatchPlan(businessId: string, actorId: string, expected?: CatalogBatchPlan | null): void { if (expected !== undefined) assertCatalogBatchPlan(businessId, actorId, expected); localStorage.removeItem(key(businessId, actorId)); }
