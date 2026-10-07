import { useEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import type { CatalogBulkPatch, Product, VatTreatment } from '../lib/pos-contracts';
import { AccountClientError } from '../lib/account';
import { posRequest, parsePrice, money, type PosAccess } from '../lib/pos';
import { bulkCatalogBatches, catalogBatches, catalogCsvMaxBytes, exportCatalogCsv, previewCatalogCsv, verifyCatalogBatchResponse, type CatalogCsvRow } from '../lib/catalog-csv';
import { CatalogRecoveryConflictError, clearCatalogBatchPlan, loadCatalogBatchPlan, saveCatalogBatchPlan, type CatalogBatchPlan } from '../lib/catalog-batch-recovery';
import { businessVatOptions } from '../lib/business-profile';
import { accessErrorCodes } from './useCatalog';
import { PendingIndicator } from './LoadingPlaceholder';
import { PosDialog } from './PosShared';

export default function CatalogBulkPanel({ access, products, actorId, defaultVatTreatment = 'unconfigured', onClose, onSaved, onSessionError }: {
  access: PosAccess; products: Product[]; actorId: string; defaultVatTreatment?: VatTreatment;
  onClose: () => void; onSaved: (products: Product[]) => void; onSessionError?: (error: AccountClientError) => void;
}) {
  const [mode, setMode] = useState<'csv' | 'bulk'>('csv'); const [rows, setRows] = useState<CatalogCsvRow[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]); const [category, setCategory] = useState(''); const [changeCategory, setChangeCategory] = useState(false);
  const [price, setPrice] = useState(''); const [active, setActive] = useState(''); const [tax, setTax] = useState('');
  const [plan, setPlan] = useState<CatalogBatchPlan | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const alive = useRef(true); const generation = useRef(0); const submitting = useRef<number | null>(null); const requestId = useRef(0); const fileInput = useRef<HTMLInputElement>(null);
  const identityScope = JSON.stringify([access.businessId, actorId, access.operatorToken, access.deviceToken ?? null]);
  const currentIdentity = useRef(identityScope); currentIdentity.current = identityScope;
  useEffect(() => {
    alive.current = true; generation.current++; submitting.current = null;
    setPlan(null); setBusy(false); setRows(null); setSelected([]); setError(''); setNotice(''); setRecoveryBlocked(false);
    try { setPlan(loadCatalogBatchPlan(access.businessId, actorId)); } catch (caught) { setRecoveryBlocked(true); setError(caught instanceof Error ? caught.message : 'No pudimos recuperar la edición pendiente.'); }
    return () => { alive.current = false; generation.current++; };
  }, [identityScope]);

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([exportCatalogCsv(products)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'menu-pos-mexico.csv'; link.click(); URL.revokeObjectURL(url);
  }
  async function readFile(file: File | undefined) {
    if (!file || busy || plan || recoveryBlocked) return; setError(''); setNotice(''); setRows(null);
    const scope = generation.current;
    if (file.size > catalogCsvMaxBytes) { setError('El CSV supera 512 KB. Divide el archivo en partes.'); return; }
    try { const preview = previewCatalogCsv(await file.text(), products, defaultVatTreatment); if (alive.current && generation.current === scope && currentIdentity.current === identityScope) setRows(preview); }
    catch (caught) { if (alive.current && generation.current === scope && currentIdentity.current === identityScope) setError(caught instanceof Error ? caught.message : 'No pudimos leer el CSV.'); }
  }
  function prepare() {
    if (busy || plan || recoveryBlocked || !alive.current || currentIdentity.current !== identityScope) return; setError(''); setNotice('');
    try {
      let batches: CatalogBatchPlan['batches'];
      if (mode === 'csv') {
        if (!rows?.length || rows.some(row => row.errors.length || !row.input)) throw new Error('Corrige todas las filas antes de importar. No guardamos filas con errores.');
        batches = catalogBatches(rows.map(row => row.input!));
      } else {
        const chosen = products.filter(product => selected.includes(product.id)); if (!chosen.length) throw new Error('Selecciona los productos que quieres cambiar.');
        const patch: CatalogBulkPatch = {};
        if (changeCategory) patch.category = category;
        if (active) patch.active = active === 'true';
        if (tax) patch.vatTreatment = tax as VatTreatment;
        if (price) { const cents = parsePrice(price); if (cents === null) throw new Error('Revisa el precio base; usa hasta dos decimales.'); patch.priceCents = cents; }
        if (!Object.keys(patch).length) throw new Error('Elige al menos un cambio para los productos seleccionados.');
        batches = bulkCatalogBatches(chosen, patch);
      }
      const next: CatalogBatchPlan = { version: 1, businessId: access.businessId, actorId, completed: 0, uncertain: false, batches };
      saveCatalogBatchPlan(next, null); setPlan(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos preparar la edición. Permite el almacenamiento del navegador.'); }
  }
  async function run() {
    if (!plan || submitting.current !== null) return;
    const scope = generation.current, ticket = ++requestId.current;
    const currentScope = () => alive.current && generation.current === scope && currentIdentity.current === identityScope;
    submitting.current = ticket; setBusy(true); setError(''); setNotice('');
    let current = plan;
    try {
      while (current.completed < current.batches.length) {
        if (!currentScope()) return;
        const sending = { ...current, uncertain: true }; saveCatalogBatchPlan(sending, current); current = sending; setPlan(current);
        const result = await posRequest(access, current.batches[current.completed]);
        if (!currentScope()) return;
        if (!result || !Array.isArray(result.products) || !verifyCatalogBatchResponse(current.batches[current.completed], result.products)) throw new AccountClientError('SERVER_ERROR', 'No pudimos verificar el lote. Reintenta la misma solicitud.');
        const completed = { ...current, completed: current.completed + 1, uncertain: false };
        // Persist progress before sending another batch. A lost response replays
        // the stored UUID; no fresh import is guessed from a refreshed catalogue.
        saveCatalogBatchPlan(completed, current); current = completed; setPlan(current); onSaved(result.products);
      }
      if (!currentScope()) return;
      clearCatalogBatchPlan(access.businessId, actorId, current);
      if (currentScope()) { setPlan(null); setRows(null); setSelected([]); setNotice('Todos los lotes se guardaron. El catálogo está actualizado.'); }
    } catch (caught) {
      if (!currentScope()) return;
      if (caught instanceof CatalogRecoveryConflictError) { setRecoveryBlocked(true); setError(caught.message); return; }
      if (caught instanceof AccountClientError && !['NETWORK_ERROR', 'SERVER_ERROR', ...accessErrorCodes].includes(caught.code)) {
        const refused = { ...current, uncertain: false }; try { saveCatalogBatchPlan(refused, current); current = refused; } catch { current = { ...current, uncertain: true }; }
      }
      if (currentScope()) {
        setPlan(current); setError(caught instanceof Error ? caught.message : 'No pudimos completar la edición. Conservamos la solicitud para reintentar.');
        if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
      }
    } finally { if (submitting.current === ticket) submitting.current = null; if (currentScope()) setBusy(false); }
  }
  function discard() {
    if (busy || !plan || plan.uncertain) return;
    if (!alive.current || currentIdentity.current !== identityScope) return;
    try { clearCatalogBatchPlan(access.businessId, actorId, plan); setPlan(null); setRows(null); setNotice('Se descartaron únicamente los lotes pendientes. Los cambios ya guardados se conservan.'); }
    catch (caught) { if (caught instanceof CatalogRecoveryConflictError) { setRecoveryBlocked(true); setError(caught.message); } else setError('No pudimos quitar la recuperación pendiente. Permite el almacenamiento del navegador.'); }
  }

  return <PosDialog title="Gestionar catálogo" busy={busy} onClose={onClose}>
    {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}
    {notice && <p className="mb-4 text-sm" role="status">{notice}</p>}
    {recoveryBlocked ? <div className="space-y-4"><p>Hay una edición pendiente que este navegador no puede recuperar. Conservamos su registro para evitar repetir cambios. Revisa el almacenamiento del navegador antes de guardar otra edición.</p><button type="button" className="pos-button pos-secondary" onClick={exportCsv}><Download size={20} aria-hidden="true" />Exportar catálogo actual</button></div> : plan ? <div className="space-y-4">
      <p><strong>{plan.completed} de {plan.batches.length} lotes guardados.</strong> Cada lote se guarda completo; si uno falla, sus cambios no se aplican.</p>
      <p className="text-sm text-muted">Conservamos la solicitud en este navegador para recuperarla después de recargar. Actualizar el catálogo no cambia las ventas registradas.</p>
      {plan.uncertain && <p className="text-sm">Este lote necesita confirmación. Reintenta su solicitud original antes de descartarlo o iniciar otra importación.</p>}
      <ul className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-line p-4" aria-label="Cambios preparados">{plan.batches.flatMap(batch => batch.command === 'import_products' ? batch.items.map(item => <li key={item.productId}>{item.name} · {item.expectedVersion === null ? 'Nuevo' : 'Actualizar'} · {money(item.priceCents)}</li>) : batch.products.map(item => <li key={item.productId}>{products.find(product => product.id === item.productId)?.name ?? item.productId} · {batch.patch.category !== undefined ? `Categoría: ${batch.patch.category || 'Sin categoría'}. ` : ''}{batch.patch.priceCents !== undefined ? `Precio base: ${money(batch.patch.priceCents)}. ` : ''}{batch.patch.active !== undefined ? batch.patch.active ? 'Activo. ' : 'Inactivo. ' : ''}{batch.patch.vatTreatment ? `IVA: ${businessVatOptions.find(option => option.value === batch.patch.vatTreatment)?.label}.` : ''}</li>))}</ul>
      <button type="button" className="pos-button pos-primary w-full" disabled={busy} onClick={() => void run()}>{busy && <PendingIndicator label="Guardando catálogo" />}{plan.completed ? 'Reintentar / continuar lotes pendientes' : 'Confirmar y guardar cambios'}</button>
      <button type="button" className="pos-button pos-secondary w-full" disabled={busy || plan.uncertain} onClick={discard}>Descartar lotes pendientes</button>
    </div> : <>
      <div className="mb-6 flex gap-3"><button type="button" className="pos-button flex-1" aria-pressed={mode === 'csv'} onClick={() => { setMode('csv'); setError(''); }}>Importar / exportar</button><button type="button" className="pos-button flex-1" aria-pressed={mode === 'bulk'} onClick={() => { setMode('bulk'); setError(''); }}>Edición masiva</button></div>
      {mode === 'csv' ? <div className="space-y-4">
        <p className="text-sm text-muted">Exporta una plantilla con IDs y versiones para actualizar sin duplicar. Los CSV nuevos necesitan nombre y precio_mxn. Hasta 500 productos y 512 KB.</p>
        <div className="flex flex-wrap gap-3"><button type="button" className="pos-button pos-secondary" onClick={exportCsv}><Download size={20} aria-hidden="true" />Exportar CSV</button><button type="button" className="pos-button pos-secondary" onClick={() => fileInput.current?.click()}><Upload size={20} aria-hidden="true" />Elegir CSV</button><input ref={fileInput} className="sr-only" type="file" accept=".csv,text/csv" aria-label="Archivo CSV del menú" onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
        <p className="text-sm text-muted">detalles_json conserva tamaños y extras, incluidos sus vínculos compartidos. Las fotos conservan referencias del mismo negocio; el CSV no incluye archivos de imagen.</p>
        {rows && <><p>{rows.filter(row => row.existing).length} actualizaciones · {rows.filter(row => !row.existing).length} productos nuevos · {rows.filter(row => row.errors.length).length} filas con errores.</p><ul className="max-h-96 divide-y divide-line overflow-y-auto border-y border-line" aria-label="Vista previa del CSV">{rows.map(row => <li key={row.line} className="py-4"><strong>Fila {row.line}: {row.name}</strong>{row.input && <p className="text-sm">{row.existing ? `${money(row.existing.priceCents)} → ` : 'Nuevo · '}{money(row.input.priceCents)} · {row.input.active ? 'Activo' : 'Inactivo'} · {row.input.category || 'Sin categoría'}</p>}{row.errors.map(problem => <p key={problem} className="text-sm text-danger">{problem}</p>)}{row.warnings.map(warning => <p key={warning} className="text-sm text-muted">{warning}</p>)}</li>)}</ul><button type="button" className="pos-button pos-primary w-full" disabled={rows.some(row => row.errors.length)} onClick={prepare}>Revisar importación</button></>}
      </div> : <div className="space-y-4">
        <p className="text-sm text-muted">Elige productos y revisa los cambios antes de guardarlos. Tamaños, extras, fotos e historial se conservan.</p>
        <label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={selected.length === products.length && Boolean(products.length)} onChange={event => setSelected(event.target.checked ? products.map(product => product.id) : [])} />Seleccionar todos ({products.length})</label>
        <ul className="max-h-72 overflow-y-auto border-y border-line" aria-label="Seleccionar productos">{products.map(product => <li key={product.id}><label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={selected.includes(product.id)} onChange={event => setSelected(event.target.checked ? [...selected, product.id] : selected.filter(id => id !== product.id))} /><span>{product.name} · {money(product.priceCents)}</span></label></li>)}</ul>
        <label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={changeCategory} onChange={event => setChangeCategory(event.target.checked)} />Cambiar categoría</label>
        {changeCategory && <div className="field"><label htmlFor="bulk-category">Nueva categoría</label><input id="bulk-category" maxLength={60} value={category} onChange={event => setCategory(event.target.value)} /><p className="text-sm text-muted">Vacía para quitar la categoría.</p></div>}
        <div className="field"><label htmlFor="bulk-price">Nuevo precio base</label><input id="bulk-price" inputMode="decimal" placeholder="Conservar precio" value={price} onChange={event => setPrice(event.target.value)} /><p className="text-sm text-muted">Los tamaños conservan sus propios precios.</p></div>
        <div className="field"><label htmlFor="bulk-active">Estado</label><select id="bulk-active" value={active} onChange={event => setActive(event.target.value)}><option value="">Conservar estado</option><option value="true">Activo</option><option value="false">Inactivo</option></select></div>
        <div className="field"><label htmlFor="bulk-tax">IVA</label><select id="bulk-tax" value={tax} onChange={event => setTax(event.target.value)}><option value="">Conservar IVA</option>{businessVatOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        <button type="button" className="pos-button pos-primary w-full" disabled={!selected.length} onClick={prepare}>Revisar cambios en {selected.length} productos</button>
      </div>}
    </>}
  </PosDialog>;
}
