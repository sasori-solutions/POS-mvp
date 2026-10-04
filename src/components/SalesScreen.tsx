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
import LoadingPlaceholder from "./LoadingPlaceholder";
import "../features/operations/operations-polish.css";
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
  const requestSequence = useRef(0);
  const retryMore = useRef(false);
  useEffect(() => {
    alive.current = true;
    fetching.current = false;
    setSales([]);
    setCursor(null);
    setLoaded(false);
    setSelectedId(null);
    void load(false);
    const refresh = () => { if (document.visibilityState !== 'hidden') void load(false); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive.current = false;
      requestSequence.current++;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [access.businessId, access.operatorToken, access.deviceToken]);
  async function load(more: boolean) {
    if (fetching.current) return;
    fetching.current = true;
    retryMore.current = more;
    const request = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await posRequest(access, {
        command: "sales",
        cursor: more ? cursor : null,
      });
      if (!alive.current || requestSequence.current !== request) return;
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
      if (!alive.current || requestSequence.current !== request) return;
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
      if (requestSequence.current === request) {
        fetching.current = false;
        if (alive.current) setLoading(false);
      }
    }
  }
  return (
    <div className="sales-screen operations-polish sales-workspace" aria-busy={loading}>
      {ownOnly && <p className="operations-caption sales-scope">Tus ventas</p>}
      {error && (
        <div
          className="operations-error"
          role="alert"
        >
          <p>{error}</p>
          <button
            className="pos-button pos-secondary compact"
            disabled={loading}
            onClick={() => void load(retryMore.current)}
          >
            Reintentar
          </button>
        </div>
      )}
      {loading && !loaded && (
        <LoadingPlaceholder variant="list" rows={5} label="Cargando ventas" />
      )}
      {loaded && !sales.length && (
        <div className="operations-empty">
          <ReceiptText
            className="pos-empty-icon mb-2 text-muted"
            size={32}
            strokeWidth={1.4}
            aria-hidden="true"
          />
          <h2>Aún no hay ventas</h2>
        </div>
      )}
      <ul className="sales-list sales-history-list">
        {sales.map((sale) => (
          <li key={sale.id}>
            <button
              onClick={() => setSelectedId(sale.id)}
              aria-label={`Ver venta ${sale.id.slice(0, 8)}, ${money(sale.totalCents)}`}
            >
              <span className="sales-receipt-icon"><ReceiptText size={20} aria-hidden="true" /></span>
              <div>
                <strong>#{sale.id.slice(0, 8).toUpperCase()}</strong>
                <p>{saleDate(sale.createdAt, sale.timezone)}</p>
                <span>{sale.itemCount} {sale.itemCount === 1 ? 'artículo' : 'artículos'}</span>
              </div>
              <span className="sales-history-amount"><b>{money(sale.totalCents)}</b><small>{paymentLabels[sale.paymentMethod]}</small></span>
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          className="pos-button pos-secondary history-more"
          disabled={loading}
          onClick={() => void load(true)}
        >
          Ver más ventas
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
  const sequence = useRef(0);
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
    setSale(null);
    void load();
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [saleId, access.businessId, access.operatorToken, access.deviceToken]);
  async function load() {
    const request = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await posRequest(access, { command: "sale", saleId });
      if (mounted.current && sequence.current === request) setSale(result);
    } catch (caught) {
      if (!mounted.current || sequence.current !== request) return;
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
      if (mounted.current && sequence.current === request) setLoading(false);
    }
  }
  return (
    <PosDialog title="Venta" onClose={onClose} busy={mutation?.busy}>
      {loading && !sale && <LoadingPlaceholder variant="detail" rows={3} label="Cargando venta" />}
      {error && (
        <div
          className="operations-polish operations-error"
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
      {sale && <div className="operations-polish sales-detail-content" aria-busy={loading}><SaleDetail sale={sale} /></div>}
      {sale?.paymentMethod === 'card_integrated' && canReverse && <PointRefund access={access} saleId={sale.id} onSessionError={onSessionError} />}
      {sale && sale.paymentMethod !== 'card_integrated' && canReverse && mutation && <div className="ops-section operations-polish sale-reversal-panel">
        {mutation.error && <p role="alert">{mutation.error}</p>}
        {mutation.pending && <><p className="operations-caption">No repitas la devolución. Reintenta el registro guardado.</p><button className="pos-button pos-secondary" disabled={mutation.busy} onClick={() => { const command = mutation.pending; if (command) void mutation.execute(command).then(() => onOperationSaved?.()).catch(() => {}) }}>Reintentar solicitud guardada</button></>}
        {current.loading && !currentAttempt && <LoadingPlaceholder variant="form" rows={2} label="Consultando devolución" />}
        {current.error && <p role="alert">{current.error}<button className="pos-button pos-secondary" onClick={current.retry}>Reintentar consulta</button></p>}
        {currentAttempt ? <><div aria-busy={current.loading}><AttemptPanel attempt={currentAttempt} mutation={{ ...mutation, busy: mutation.busy || current.blocked }} collectionAllowed={collectionAllowed} onSaved={a => { setAttempt(a); void onOperationSaved?.(); }} /></div>{currentAttempt.status === 'aborted' && <button className="pos-button pos-secondary" disabled={mutation.busy || Boolean(mutation.pending)} onClick={() => { void Promise.resolve(onOperationSaved?.()).then(() => setAttempt(null)); }}>Preparar otra devolución</button>}</> : <details className="sale-reversal-disclosure"><summary>Devolver venta completa</summary><div className="ops-form"><p className="operations-caption">Se conserva la venta original.</p>{!collectionAllowed && <p className="attempt-warning">Turno cerrado. Abre o reanuda la caja.</p>}<label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={mutation.busy || Boolean(mutation.pending)} /></label><button className="pos-button pos-secondary" disabled={!collectionAllowed || mutation.busy || Boolean(mutation.pending) || !reason.trim()} onClick={() => { void (async () => { try { setAttempt(await mutation.execute({ command: 'prepare_reversal', operationId: crypto.randomUUID(), saleId: sale.id, reason: reason.trim() })); await onOperationSaved?.(); } catch { /* Recovery remains visible. */ } })() }}>Preparar devolución completa</button></div></details>}
      </div>}
    </PosDialog>
  );
}
