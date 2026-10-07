import { useEffect, useRef, useState } from 'react';
import { Plus, ExternalLink, Copy, Download } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { MenuCommand, MenuConfiguration, MenuSchedule } from '../lib/menu-contracts';
import type { Product } from '../lib/pos-contracts';
import { AccountClientError } from '../lib/account';
import { posRequest, type PosAccess } from '../lib/pos';
import { parseMenuCommand } from '../../supabase/functions/account/menu-validation';
import { RequestValidationError } from '../../supabase/functions/account/validation';
import { menuWeekdays, minuteFromInput, minuteLabel, scheduleLabel } from '../lib/menu-schedule';
import { accessErrorCodes } from './useCatalog';
import { PendingIndicator } from './LoadingPlaceholder';
type SaveMenu = Extract<MenuCommand, { command: 'save_menu' }>;
type Draft = Omit<SaveMenu, 'command' | 'operationId'>;
type Recovery = { version: 1; businessId: string; actorId: string; command: SaveMenu; uncertain: boolean };
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function storageKey(business: string, actor: string) { return `pos-menu-edit-v1:${business}:${actor}`; }
class RecoveryConflictError extends Error {
  constructor() { super('La solicitud guardada cambió en otra sesión o pestaña. Reabre Menús para recuperar ese registro.'); }
}
function readRecovery(businessId: string, actorId: string): Recovery | null {
  const encoded = localStorage.getItem(storageKey(businessId, actorId));
  if (!encoded) return null;
  const value = JSON.parse(encoded) as Recovery;
  if (!value || Object.keys(value).length !== 5 || value.version !== 1 || value.businessId !== businessId || value.actorId !== actorId || typeof value.uncertain !== 'boolean') throw new Error('La recuperación del menú no es válida. Conservamos su registro antes de iniciar otra edición.');
  const command = parseMenuCommand(value.command as unknown as Record<string, unknown>, []);
  if (!command || command.command !== 'save_menu' || new TextEncoder().encode(JSON.stringify(command)).length > 7000) throw new Error('La recuperación del menú no es válida.');
  return { ...value, command };
}
function assertStoredRecovery(businessId: string, actorId: string, expected: Recovery | null) {
  const stored = readRecovery(businessId, actorId);
  if (Boolean(stored) !== Boolean(expected) || stored && expected && JSON.stringify(stored.command) !== JSON.stringify(expected.command)) throw new RecoveryConflictError();
}
function writeRecovery(value: Recovery, expected: Recovery | null) {
  assertStoredRecovery(value.businessId, value.actorId, expected);
  const key = storageKey(value.businessId, value.actorId), encoded = JSON.stringify(value); localStorage.setItem(key, encoded);
  if (localStorage.getItem(key) !== encoded) throw new Error('No pudimos conservar esta solicitud. Permite el almacenamiento del navegador.');
}
function clearRecovery(businessId: string, actorId: string, expected: Recovery | null) {
  assertStoredRecovery(businessId, actorId, expected);
  localStorage.removeItem(storageKey(businessId, actorId));
}
function newDraft(): Draft { return { menuId: crypto.randomUUID(), expectedRevision: null, name: '', locationLabel: '', productIds: [], published: false, schedules: [] }; }
function fromMenu(menu: MenuConfiguration): Draft { return { menuId: menu.id, expectedRevision: menu.revision, name: menu.name, locationLabel: menu.locationLabel, productIds: menu.productIds, published: menu.published, schedules: menu.schedules }; }
function sameSchedules(first: MenuSchedule[], second: MenuSchedule[]): boolean {
  return Array.isArray(first) && first.length === second.length && first.every((schedule, index) => schedule && schedule.startMinute === second[index].startMinute && schedule.endMinute === second[index].endMinute && JSON.stringify(schedule.weekdays) === JSON.stringify(second[index].weekdays));
}
export default function MenuManager({ access, actorId, products, onSessionError }: { access: PosAccess; actorId: string; products: Product[]; onSessionError?: (error: AccountClientError) => void }) {
  const [menus, setMenus] = useState<MenuConfiguration[]>([]), [draft, setDraft] = useState<Draft | null>(null), [pending, setPending] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [blocked, setBlocked] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), submitting = useRef(false), alive = useRef(true);
  const identityScope = JSON.stringify([access.businessId, actorId, access.operatorToken, access.deviceToken ?? null]);
  const currentIdentity = useRef(identityScope); currentIdentity.current = identityScope;
  function fail(caught: unknown) { setError(caught instanceof RequestValidationError ? 'Revisa el nombre, los productos y los horarios. Cada horario necesita días seleccionados y horas diferentes.' : caught instanceof Error ? caught.message : 'No pudimos completar la solicitud.'); if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) { generation.current++; setMenus([]); setDraft(null); setPending(null); setBlocked(true); onSessionError?.(caught); } }
  async function reload(scope = generation.current) {
    const currentScope = () => alive.current && scope === generation.current && currentIdentity.current === identityScope;
    if (!currentScope()) return;
    setLoading(true);
    try { const result = await posRequest(access, { command: 'menus' }); if (currentScope()) setMenus(result.menus); }
    catch (caught) { if (currentScope()) fail(caught); }
    finally { if (currentScope()) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    const scope = ++generation.current; submitting.current = false; setMenus([]); setDraft(null); setPending(null); setBlocked(false); setError(''); setNotice(''); setBusy(false);
    try {
      const value = readRecovery(access.businessId, actorId);
      if (value) { setPending(value); setDraft(value.command); }
    } catch (caught) { setBlocked(true); setError(caught instanceof Error ? caught.message : 'No pudimos recuperar la edición pendiente.'); }
    void reload(scope); return () => { alive.current = false; generation.current++; };
    // The session scope invalidates every pending callback and subsequent read.
  }, [identityScope]);
  function update(patch: Partial<Draft>) { if (draft && !pending && !busy && !blocked) setDraft({ ...draft, ...patch }); }
  function updateSchedule(index: number, patch: Partial<MenuSchedule>) { if (draft) update({ schedules: draft.schedules.map((schedule, position) => position === index ? { ...schedule, ...patch } : schedule) }); }
  async function save() {
    if (!draft || busy || submitting.current || blocked) return;
    const scope = generation.current; let recovery = pending;
    const currentScope = () => alive.current && scope === generation.current && currentIdentity.current === identityScope;
    try {
      if (!currentScope()) return;
      if (!recovery) {
        const parsed = parseMenuCommand({ ...draft, command: 'save_menu', operationId: crypto.randomUUID() }, []);
        if (!parsed || parsed.command !== 'save_menu') throw new Error('Revisa el menú y sus horarios.');
        if (new TextEncoder().encode(JSON.stringify(parsed)).length > 7000) throw new Error('El menú supera el tamaño permitido. Reduce sus productos u horarios.');
        recovery = { version: 1, businessId: access.businessId, actorId, command: parsed, uncertain: false };
        writeRecovery(recovery, null); setPending(recovery);
      }
      const sending = { ...recovery, uncertain: true }; writeRecovery(sending, recovery); recovery = sending; setPending(recovery); submitting.current = true; setBusy(true); setError(''); setNotice('');
      const saved = await posRequest(access, recovery.command);
      if (!currentScope()) return;
      if (!saved || saved.id?.toLowerCase() !== recovery.command.menuId.toLowerCase() || !validId.test(saved.publicId) || !Number.isInteger(saved.revision) || saved.revision <= (recovery.command.expectedRevision ?? 0)
        || saved.name !== recovery.command.name || saved.locationLabel !== recovery.command.locationLabel || saved.published !== recovery.command.published
        || !Array.isArray(saved.productIds) || JSON.stringify(saved.productIds.map(id => id.toLowerCase())) !== JSON.stringify(recovery.command.productIds.map(id => id.toLowerCase())) || !sameSchedules(saved.schedules, recovery.command.schedules)) throw new AccountClientError('SERVER_ERROR', 'No pudimos verificar el guardado. Conservamos la solicitud original.');
      clearRecovery(access.businessId, actorId, recovery);
      setPending(null); setDraft(null); setMenus(current => [...current.filter(menu => menu.id !== saved.id), saved]); setNotice(saved.published ? 'Menú publicado. El QR consulta los precios y la disponibilidad actuales.' : 'Borrador guardado. Su enlace público está desactivado.');
    } catch (caught) {
      if (!currentScope()) return;
      if (caught instanceof RecoveryConflictError) { setBlocked(true); setDraft(null); setPending(null); fail(caught); return; }
      if (recovery && caught instanceof AccountClientError && !['NETWORK_ERROR', 'SERVER_ERROR', ...accessErrorCodes].includes(caught.code)) { const refused = { ...recovery, uncertain: false }; try { writeRecovery(refused, recovery); recovery = refused; } catch { recovery = { ...recovery, uncertain: true }; } }
      if (recovery) setPending(recovery); fail(caught);
    } finally { if (currentScope()) { submitting.current = false; setBusy(false); } }
  }
  function discard() {
    if (busy || pending?.uncertain) return;
    if (!alive.current || currentIdentity.current !== identityScope) return;
    try { clearRecovery(access.businessId, actorId, pending); setPending(null); setDraft(null); setError(''); } catch (caught) { if (caught instanceof RecoveryConflictError) setBlocked(true); fail(caught); }
  }
  function downloadQr(menu: MenuConfiguration) {
    const svg = document.getElementById(`menu-qr-${menu.id}`);
    if (!svg) { setError('No pudimos preparar el QR. Actualiza la lista de menús.'); return; }
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    const link = document.createElement('a'); link.href = url; link.download = `menu-${menu.id}.svg`; link.click(); URL.revokeObjectURL(url);
  }
  const locked = busy || Boolean(pending) || blocked;
  return <section className="management-shell space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2>Menús para clientes</h2><button type="button" className="pos-button pos-secondary" disabled={busy || Boolean(pending) || blocked} onClick={() => { setDraft(newDraft()); setError(''); setNotice(''); }}><Plus size={18} aria-hidden="true" />Crear menú</button></div>
    <p className="text-sm text-muted">Crea un menú para cada punto de atención: terraza, barra o desayuno. Son selecciones del catálogo de este negocio; los precios y la disponibilidad se actualizan al consultarlo.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {blocked && <p>No sobrescribimos una recuperación ilegible. Revisa el almacenamiento del navegador para continuar.</p>}
    {draft && <form className="space-y-5 rounded-xl border border-line p-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3>{draft.expectedRevision === null ? 'Nuevo menú' : 'Editar menú'}</h3>
      {pending && <p className="text-sm">Conservamos la solicitud original. {pending.uncertain ? 'Su resultado necesita confirmación; reinténtala antes de iniciar otra edición.' : 'Puedes reintentar o descartar la solicitud rechazada.'}</p>}
      <fieldset disabled={locked} className="space-y-5">
        <div className="field"><label htmlFor="menu-name">Nombre del menú</label><input id="menu-name" value={draft.name} maxLength={100} required onChange={event => update({ name: event.target.value })} /></div>
        <div className="field"><label htmlFor="menu-location">Ubicación o punto de atención</label><input id="menu-location" maxLength={80} placeholder="Ej. Barra principal" value={draft.locationLabel} onChange={event => update({ locationLabel: event.target.value })} /></div>
        <fieldset><legend>Productos del menú ({draft.productIds.length}/100)</legend><ul className="max-h-80 overflow-y-auto border-y border-line">{products.map(product => <li key={product.id}><label className="flex min-h-12 items-center gap-3 py-2"><input type="checkbox" checked={draft.productIds.includes(product.id)} disabled={!draft.productIds.includes(product.id) && draft.productIds.length >= 100} onChange={event => update({ productIds: event.target.checked ? [...draft.productIds, product.id] : draft.productIds.filter(id => id !== product.id) })} />{product.details?.customerName || product.name}{!product.active ? ' · Inactivo, se oculta' : ''}</label></li>)}</ul></fieldset>
        {draft.productIds.filter(id => !products.some(product => product.id === id)).map(id => <div key={id}><p className="text-sm text-danger">Este producto ya no está en el catálogo: {id}</p><button type="button" className="pos-button pos-secondary" onClick={() => update({ productIds: draft.productIds.filter(value => value !== id) })}>Quitar referencia del producto eliminado</button></div>)}
        <fieldset className="space-y-4"><legend>Horarios del local</legend><p className="text-sm text-muted">Sin franjas, el menú está disponible todo el día. Un cierre anterior al inicio corresponde al día siguiente. Usamos el horario guardado del negocio.</p>
          {draft.schedules.map((schedule, index) => <div key={index} className="space-y-3 rounded-lg border border-line p-4"><div className="flex flex-wrap gap-3">{menuWeekdays.map((day, weekday) => <label key={day} className="flex min-h-12 items-center gap-2"><input type="checkbox" checked={schedule.weekdays.includes(weekday)} onChange={event => updateSchedule(index, { weekdays: event.target.checked ? [...schedule.weekdays, weekday].sort((a, b) => a - b) : schedule.weekdays.filter(value => value !== weekday) })} />{day}</label>)}</div><div className="grid grid-cols-2 gap-4"><div className="field"><label htmlFor={`menu-start-${index}`}>Desde</label><input id={`menu-start-${index}`} type="time" value={minuteLabel(schedule.startMinute)} required onChange={event => { const minute = minuteFromInput(event.target.value); if (minute !== null) updateSchedule(index, { startMinute: minute }); }} /></div><div className="field"><label htmlFor={`menu-end-${index}`}>Hasta</label><input id={`menu-end-${index}`} type="time" value={schedule.endMinute === 1440 ? '00:00' : minuteLabel(schedule.endMinute)} required onChange={event => { const minute = minuteFromInput(event.target.value); if (minute !== null) updateSchedule(index, { endMinute: minute || 1440 }); }} /></div></div><button type="button" className="pos-button pos-secondary" onClick={() => update({ schedules: draft.schedules.filter((_, position) => position !== index) })}>Quitar horario {index + 1}</button></div>)}
          <button type="button" className="pos-button pos-secondary" disabled={draft.schedules.length >= 14} onClick={() => update({ schedules: [...draft.schedules, { weekdays: [0, 1, 2, 3, 4, 5, 6], startMinute: 480, endMinute: 1080 }] })}>Añadir horario</button>
        </fieldset>
        <label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={draft.published} onChange={event => update({ published: event.target.checked })} />Publicar este menú</label>
      </fieldset>
      <p className="rounded-lg border border-line bg-white p-4 text-sm">Al publicar, cualquier persona con el QR podrá ver el nombre del negocio y ubicación, nombres para clientes, precios, descripciones, tamaños, extras, ingredientes del combo, alérgenos y fotografías seleccionadas. Los productos agotados mostrarán “Agotado”; los inactivos se ocultan. Desactivar la publicación cierra el enlace al volver a consultarlo.</p>
      <button type="submit" className="pos-button pos-primary w-full" disabled={busy || blocked || (!pending && draft.published && !draft.productIds.length)}>{busy && <PendingIndicator label="Guardando menú" />}{pending ? 'Reintentar solicitud original' : draft.published ? 'Guardar y publicar menú' : 'Guardar borrador'}</button>
      <button type="button" className="pos-button pos-secondary w-full" disabled={busy || pending?.uncertain} onClick={discard}>{pending ? 'Descartar solicitud rechazada' : 'Cancelar edición'}</button>
    </form>}
    {loading && <p role="status">Cargando menús…</p>}
    <ul className="space-y-5">{menus.map(menu => { const link = `${window.location.origin}/menu/${menu.publicId}`; return <li key={menu.id} className="space-y-3 rounded-xl border border-line p-5"><h3>{menu.name} {menu.locationLabel && `· ${menu.locationLabel}`}</h3><p className="text-sm text-muted">{menu.published ? 'Publicado' : 'Borrador'} · {menu.productIds.length} productos</p>{menu.schedules.map((schedule, index) => <p key={index} className="text-sm text-muted">{scheduleLabel(schedule)}</p>)}<div className="flex flex-wrap gap-3"><button type="button" className="pos-button pos-secondary" disabled={busy || Boolean(pending) || blocked} onClick={() => { setDraft(fromMenu(menu)); setError(''); setNotice(''); }}>Editar {menu.name}</button>{menu.published && <><a className="pos-button pos-secondary" href={link} target="_blank" rel="noreferrer"><ExternalLink size={18} aria-hidden="true" />Ver menú público</a><button type="button" className="pos-button pos-secondary" onClick={() => { void navigator.clipboard.writeText(link).then(() => setNotice('Enlace copiado.'), () => setError('No pudimos copiar el enlace. Abre el menú público y copia su dirección.')); }}><Copy size={18} aria-hidden="true" />Copiar enlace</button><button type="button" className="pos-button pos-secondary" onClick={() => downloadQr(menu)}><Download size={18} aria-hidden="true" />Descargar QR</button></>}</div>{menu.published && <figure className="inline-flex flex-col items-center gap-3 rounded-lg border border-line bg-white p-4"><QRCodeSVG id={`menu-qr-${menu.id}`} value={link} size={208} marginSize={4} level="M" aria-label={`QR del menú ${menu.name}`} title={menu.name} /><figcaption className="text-sm">Escanea para consultar {menu.name}</figcaption></figure>}</li>; })}</ul>
    {!loading && !menus.length && <p>Aún no tienes menús publicados. Crea uno con los productos que verá el cliente.</p>}
    <button type="button" className="pos-button pos-secondary" disabled={loading || busy} onClick={() => { void reload(); }}>Actualizar lista de menús</button>
  </section>;
}
