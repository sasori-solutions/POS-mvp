import { useEffect, useRef, useState } from "react";
import { ChevronRight, ReceiptText } from "lucide-react";
import { AccountClientError } from "../lib/account";
import type { Sale, SaleCursor, SaleSummary } from "../lib/pos-contracts";
import { money, posRequest, saleDate, type PosAccess } from "../lib/pos";
import { paymentLabels, PosDialog, SaleDetail } from "./PosShared";
import { accessErrorCodes } from "./useCatalog";
import type { CheckoutAttempt } from "../lib/operations-contracts";
import type { OperationalMutation } from "../features/operations/useOperations";
import AttemptPanel from "../features/operations/AttemptPanel";
import { useCurrentAttempt } from "../features/operations/useCurrentAttempt";
import PointRefund from './PointRefund';
const noAttempts: CheckoutAttempt[] = [];

export default function SalesScreen({
  access,
  ownOnly,
  onSessionError,
  canReverse = false,
  attempts = noAttempts,
  mutation,
  onOperationSaved,
  collectionAllowed = true,
}: {
  access: PosAccess;
  ownOnly: boolean;
  onSessionError?: (error: AccountClientError) => void;
  canReverse?: boolean;
  attempts?: CheckoutAttempt[];
  mutation?: OperationalMutation;
  onOperationSaved?: () => Promise<void>;
  collectionAllowed?: boolean;
}) {
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [cursor, setCursor] = useState<SaleCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const alive = useRef(true);
  const fetching = useRef(false);
  useEffect(() => {
    alive.current = true;
    void load(false);
    return () => {
      alive.current = false;
    };
  }, []);
  async function load(more: boolean) {
    if (fetching.current) return;
    fetching.current = true;
    setLoading(true);
    setError("");
    try {
      const result = await posRequest(access, {
        command: "sales",
        cursor: more ? cursor : null,
      });
      if (!alive.current) return;
      setSales((previous) =>
        more
          ? [
              ...previous,
              ...result.sales.filter(
                (sale) => !previous.some((existing) => existing.id === sale.id),
              ),
            ]
          : result.sales,
      );
      setCursor(result.nextCursor);
      setLoaded(true);
    } catch (caught) {
      if (!alive.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "No pudimos cargar las ventas.",
      );
      if (
        caught instanceof AccountClientError &&
        accessErrorCodes.includes(caught.code)
      )
        onSessionError?.(caught);
    } finally {
      fetching.current = false;
      if (alive.current) setLoading(false);
    }
  }
  return (
    <div className="sales-screen">
      <div className="catalog-toolbar my-6 flex items-center justify-between gap-4 [&_p]:text-[15px] max-tablet:flex-wrap">
        {ownOnly && <p>Tus ventas</p>}
        <button
          className="pos-button pos-secondary compact ml-auto"
          onClick={() => void load(false)}
          disabled={loading}
        >
          Actualizar ventas
        </button>
      </div>
      {error && (
        <div
          className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
          role="alert"
        >
          <p>{error}</p>
          <button
            className="pos-button pos-secondary compact"
            disabled={loading}
            onClick={() => void load(Boolean(sales.length && cursor))}
          >
            Reintentar
          </button>
        </div>
      )}
      {loading && !loaded && (
        <p className="pos-status my-4 text-sm text-muted" role="status">
          Cargando ventas…
        </p>
      )}
      {loaded && !sales.length && (
        <div className="pos-empty flex min-h-70 flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center tablet:min-h-90 [&_h2]:text-[22px] [&_p]:max-w-[32ch]">
          <ReceiptText
            className="pos-empty-icon mb-2 text-muted"
            size={32}
            strokeWidth={1.4}
            aria-hidden="true"
          />
          <h2>Aún no hay ventas</h2>
          <p>Cuando registres una venta, aparecerá aquí.</p>
        </div>
      )}
      <ul className="sales-list mt-6 list-none border-t border-line p-0">
        {sales.map((sale) => (
          <li key={sale.id}>
            <button
              onClick={() => setSelectedId(sale.id)}
              aria-label={`Ver venta ${sale.id.slice(0, 8)}, ${money(sale.totalCents)}`}
            >
              <div>
                <strong>#{sale.id.slice(0, 8).toUpperCase()}</strong>
                <p>{saleDate(sale.createdAt, sale.timezone)}</p>
                <span>
                  {paymentLabels[sale.paymentMethod]} / {sale.itemCount}{" "}
                  artículos
                </span>
              </div>
              <b>{money(sale.totalCents)}</b>
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          className="pos-button pos-secondary history-more mx-auto my-6 max-w-70"
          disabled={loading}
          onClick={() => void load(true)}
        >
          Cargar más ventas
        </button>
      )}
      {selectedId && (
        <SaleDetailDialog
          access={access}
          saleId={selectedId}
          onClose={() => setSelectedId(null)}
          onSessionError={onSessionError}
          canReverse={canReverse}
          attempts={attempts}
          mutation={mutation}
          onOperationSaved={onOperationSaved}
          collectionAllowed={collectionAllowed}
        />
      )}
    </div>
  );
}

function SaleDetailDialog({
  access,
  saleId,
  onClose,
  onSessionError,
  canReverse,
  attempts,
  mutation,
  onOperationSaved,
  collectionAllowed = true,
}: {
  access: PosAccess;
  saleId: string;
  onClose: () => void;
  onSessionError?: (error: AccountClientError) => void;
  canReverse?: boolean;
  attempts: CheckoutAttempt[];
  mutation?: OperationalMutation;
  onOperationSaved?: () => Promise<void>;
  collectionAllowed?: boolean;
}) {
  const [sale, setSale] = useState<Sale | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null);
  useEffect(() => {
    const recovered = mutation?.lastResult?.result as CheckoutAttempt | undefined;
    if (recovered?.kind === 'reversal' && recovered.originalSaleId === saleId) setAttempt(recovered);
  }, [saleId, mutation?.lastResult]);
  const persistedAttempt = attempts.find(a => a.kind === 'reversal' && a.originalSaleId === saleId);
  useEffect(() => { if (persistedAttempt && (!attempt || persistedAttempt.id !== attempt.id || persistedAttempt.revision > attempt.revision)) setAttempt(persistedAttempt); }, [persistedAttempt, attempt]);
  const selectedAttempt = persistedAttempt && persistedAttempt.id !== attempt?.id ? persistedAttempt : attempt ?? persistedAttempt;
  const current = useCurrentAttempt(access, selectedAttempt, attempts, onSessionError);
  const currentAttempt = current.attempt;
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [saleId]);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await posRequest(access, { command: "sale", saleId });
      if (mounted.current) setSale(result);
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "No pudimos cargar esta venta.",
      );
      if (
        caught instanceof AccountClientError &&
        accessErrorCodes.includes(caught.code)
      )
        onSessionError?.(caught);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  return (
    <PosDialog title="Detalle de venta" onClose={onClose} busy={mutation?.busy}>
      {loading && <p role="status">Cargando venta…</p>}
      {error && (
        <div
          className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
          role="alert"
        >
          <p>{error}</p>
          <button
            className="pos-button pos-secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            Reintentar
          </button>
        </div>
      )}
      {sale && <SaleDetail sale={sale} />}
      {sale?.paymentMethod === 'card_integrated' && canReverse && <PointRefund access={access} saleId={sale.id} onSessionError={onSessionError} />}
      {sale && sale.paymentMethod !== 'card_integrated' && canReverse && mutation && <div className="ops-section">
        {mutation.error && <p role="alert">{mutation.error}</p>}
        {mutation.pending && <><p>Reintenta el registro pendiente sin repetir la devolución.</p><button className="pos-button pos-secondary" disabled={mutation.busy} onClick={() => { const command = mutation.pending; if (command) void mutation.execute(command).then(() => onOperationSaved?.()).catch(() => {}) }}>Reintentar solicitud guardada</button></>}
        {current.loading && <p role="status">Consultando el estado del intento…</p>}
        {current.error && <p role="alert">{current.error}<button className="pos-button pos-secondary" onClick={current.retry}>Reintentar consulta</button></p>}
        {currentAttempt ? <><AttemptPanel attempt={currentAttempt} mutation={{ ...mutation, busy: mutation.busy || current.blocked }} collectionAllowed={collectionAllowed} onSaved={a => { setAttempt(a); void onOperationSaved?.(); }} />{currentAttempt.status === 'aborted' && <button className="pos-button pos-secondary" disabled={mutation.busy || Boolean(mutation.pending)} onClick={() => { void Promise.resolve(onOperationSaved?.()).then(() => setAttempt(null)); }}>Preparar otra devolución</button>}</> : <details><summary>Devolver venta completa</summary><div className="ops-form"><p>La venta original se conserva. El efectivo devuelto se registra en el turno abierto actual.</p>{!collectionAllowed && <p>Abre o reanuda el turno en Caja antes de devolver dinero.</p>}<label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={mutation.busy || Boolean(mutation.pending)} /></label><button className="pos-button pos-secondary" disabled={!collectionAllowed || mutation.busy || Boolean(mutation.pending) || !reason.trim()} onClick={() => { void (async () => { try { setAttempt(await mutation.execute({ command: 'prepare_reversal', operationId: crypto.randomUUID(), saleId: sale.id, reason: reason.trim() })); await onOperationSaved?.(); } catch { /* Recovery remains visible. */ } })() }}>Preparar devolución completa</button></div></details>}
      </div>}
    </PosDialog>
  );
}
