import LoadingPlaceholder from "./LoadingPlaceholder";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight,
  KeyRound,
  LockKeyhole,
  LogOut,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { BusinessContext } from "../lib/contracts";
import { availableDestinations, initialDestination, type Destination } from "../lib/navigation";
export type { Destination } from "../lib/navigation";
import WorkspaceShell from "./WorkspaceShell";
import ReportDashboard, { type ReportTab } from "../features/operations/ReportDashboard";
import { useReportController } from "../features/operations/usePeriodReport";
import { businessDate } from "../lib/reporting";
import { hasPermission } from "../lib/business-access";
import type { OperationsResponses, OperationalOrder, OrderInputLine, CheckoutAttempt } from "../lib/operations-contracts";
import type { CartLine, ItemSelection, Product } from "../lib/pos-contracts";
import { lineKey, selectedPrice } from "../lib/product-details";
import { cartLineOrderInput, savedOrderLineInput } from "../lib/cart-line";
import { AccountClientError, accountRequest, deviceRequest } from "../lib/account";
import ProductsScreen from "./ProductsScreen";
import SaleScreen from "./SaleScreen";
import CheckoutPanel from "./CheckoutPanel";
import SalesScreen from "./SalesScreen";
import SaleReceiptDialog from "./SaleReceiptDialog";
import { accessErrorCodes, useCatalog } from "./useCatalog";
import { posRequest } from "../lib/pos";
import { PosDialog } from "./PosShared";
import { useOperationalMutation, useOperations } from "../features/operations/useOperations";
import CashScreen from "../features/operations/CashScreen";
import OrdersScreen from "../features/operations/OrdersScreen";
import ReportsScreen from "../features/operations/ReportsScreen";
import PersonalMetricsScreen from "../features/operations/PersonalMetricsScreen";
import OrderDetail from "../features/operations/OrderDetail";
import OrderEditor from "../features/operations/OrderEditor";
import PointSetup from './PointSetup';
import PointDashboard from './PointDashboard';
import PointPayment from './PointPayment';
import { usePoint } from './usePoint';
import type { PointCheckout } from '../lib/point-contracts';
import { pointRequest, takePointOAuthReturn } from '../lib/point-client';
import type { CheckoutDraft } from "../lib/checkout-selection";

interface HomeScreenProps {
  business: BusinessContext;
  accountName?: string;
  operatorToken: string;
  deviceToken?: string;
  onSessionError?: (error: AccountClientError) => void;
  onLock: () => void;
  onLogout: () => void;
  busy: boolean;
  error: string;
  notice?: string;
  destination?: Destination;
  onDestinationChange?: (destination: Destination) => void;
  focusOnReturn?: string;
  onNotifications?: () => void;
  unreadCount?: number;
  onSettings?: (section?: 'payment-methods') => void;
  onTeam?: () => void;
  onDevices?: () => void;
  onSwitchBusiness?: () => void;
  onChangePin?: (returnFocus?: string) => void;
  onAccountProfile?: () => void;
  onSwitchEmployee?: () => void;
  logoutLabel?: string;
  managementContent?: ReactNode;
  managementTitle?: string;
  managementKey?: string;
}

export default function HomeScreen({
  business,
  accountName,
  operatorToken,
  deviceToken,
  onSessionError,
  onLock,
  onLogout,
  busy,
  error,
  notice,
  destination: selectedDestination,
  onDestinationChange,
  focusOnReturn,
  onSettings,
  onTeam,
  onDevices,
  onSwitchBusiness,
  onChangePin,
  onAccountProfile,
  onSwitchEmployee,
  onNotifications,
  unreadCount = 0,
  logoutLabel = "Cerrar sesión",
  managementContent, managementTitle, managementKey,
}: HomeScreenProps) {
  const [localDestination, setLocalDestination] = useState<Destination>(
    initialDestination(business),
  );
  const [selectedOrder, setSelectedOrder] = useState<OperationalOrder | null>(null);
  const sessionErrorHandler = useRef(onSessionError);
  sessionErrorHandler.current = onSessionError;
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [checkoutRequested, setCheckoutRequested] = useState(false);
  const [editingOrder, setEditingOrder] = useState<{ order?: OperationalOrder } | null>(null);
  const [savedCounter, setSavedCounter] = useState<OperationalOrder | null>(null);
  const [saleResetToken, setSaleResetToken] = useState(0);
  const saleAccountOperation = useRef<string | null>(null);
  const counterOrderId = useRef<string | null>(null);
  const backOrder = useRef<OperationalOrder | null>(null);
  const checkoutDraft = useRef<{ scope: string; value: CheckoutDraft } | null>(null);
  const [backError, setBackError] = useState("");
  const operatorScope = `${business.id}:${operatorToken}:${deviceToken ?? ''}`;
  const [receipt, setReceipt] = useState<{ scope: string; saleId: string; afterCheckout: boolean } | null>(null);
  const currentOperator = useRef<string | null>(operatorScope);
  currentOperator.current = operatorScope;
  useEffect(() => {
    currentOperator.current = operatorScope;
    return () => { currentOperator.current = null; checkoutDraft.current = null; };
  }, [operatorScope]);
  const destination = selectedDestination ?? localDestination;
  const allowed = availableDestinations(business);
  const active = allowed.includes(destination) ? destination : initialDestination(business);
  const isOwner = business.role === 'owner';
  const canReadReports = hasPermission(business, 'reports.read');
  const canReadReceipts = hasPermission(business, 'sales.read_own') || hasPermission(business, 'sales.read_all');
  const canReadOwnMetrics = !isOwner && hasPermission(business, 'reports.read_own');
  const [operating, setOperating] = useState(!isOwner || active === 'Venta' || active === 'Comandas');
  const [saleVisited, setSaleVisited] = useState(active === 'Venta');
  useEffect(() => { if (active === 'Venta') setSaleVisited(true); }, [active]);
  const access = { businessId: business.id, operatorToken, deviceToken };
  const point = usePoint(access, isOwner || hasPermission(business, 'sales.create') || hasPermission(business, 'reports.read'), onSessionError);
  const paymentMethodKey = business.profile.paymentMethods.join('|');
  const managing = Boolean(managementContent);
  const pointReadinessContext = useRef({ scope: operatorScope, managing, paymentMethodKey });
  useEffect(() => {
    const previous = pointReadinessContext.current;
    pointReadinessContext.current = { scope: operatorScope, managing, paymentMethodKey };
    // Settings owns a separate Point controller. Read its saved changes when returning to work.
    if (previous.scope === operatorScope && !managing && (previous.managing || previous.paymentMethodKey !== paymentMethodKey)) void point.refresh();
  }, [operatorScope, managing, paymentMethodKey, point.refresh]);
  const [pointPage, setPointPage] = useState<'setup' | 'admin' | null>(null);
  useEffect(() => {
    // Parent-owned management and local Point pages are exclusive destinations.
    if (managementContent) setPointPage(null);
  }, [managementContent, pointPage]);
  const [pointReport, setPointReport] = useState(false);
  const [recoverPoint, setRecoverPoint] = useState<PointCheckout | null>(null);
  const [pointBlocked, setPointBlocked] = useState(false);
  const [pointNotice, setPointNotice] = useState('');
  const pointScope = useRef(operatorScope);
  pointScope.current = operatorScope;
  useEffect(() => {
    const callback = takePointOAuthReturn();
    if (!callback) return;
    setPointPage('setup');
    if ('rejected' in callback) { setPointNotice('La autorización de Mercado Pago fue rechazada o está incompleta. Puedes conectar de nuevo.'); return; }
    const captured = operatorScope;
    void pointRequest(access, {command: 'oauth_callback', ...callback}).then(settings => {
      if (pointScope.current !== captured) return;
      point.setSettings(settings); setPointNotice('error' in callback ? 'Autorización rechazada. Puedes conectar de nuevo.' : '');
    }).catch(caught => { if (pointScope.current === captured) setPointNotice(caught instanceof Error ? caught.message : 'La autorización venció. Reconecta Mercado Pago.'); });
    return () => { pointScope.current = ''; };
  }, [operatorScope]);
  const [reportTab, setReportTab] = useState<ReportTab>('sales');
  const [datePulse, setDatePulse] = useState(0);
  const today = businessDate(business.timezone);
  const presenceScope = `${business.id}:${operatorToken}:${deviceToken ?? ''}`;
  const [presenceSnapshot, setPresenceSnapshot] = useState<{ scope: string; employees: BusinessContext['connectedEmployees']; error: string } | null>(null);
  const [presenceRefresh, setPresenceRefresh] = useState(0);
  const scopedPresence = presenceSnapshot?.scope === presenceScope ? presenceSnapshot : null;
  const presence = scopedPresence ? scopedPresence.employees : business.connectedEmployees;
  const homeAnalytics = useReportController(access, business.timezone, onSessionError,
    !managementContent && !pointPage && active === 'Inicio', hasPermission(business, 'reports.read'));
  const analytics = useReportController(access, business.timezone, onSessionError,
    !managementContent && !pointPage && active === 'Reportes' && !canReadOwnMetrics, canReadReports);
  const ownMetrics = useReportController(access, business.timezone, onSessionError,
    !managementContent && !pointPage && active === 'Reportes' && canReadOwnMetrics, canReadOwnMetrics, 'own');
  useEffect(() => {
    const timer = window.setInterval(() => setDatePulse(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (business.role !== 'owner' || managementContent || active !== 'Inicio') return;
    let alive = true;
    let inFlight = false;
    async function refreshPresence() {
      if (!alive || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const context = deviceToken
          ? await deviceRequest({ action: 'device_context', deviceToken, operatorToken })
          : await accountRequest({ action: 'context', businessId: business.id, operatorToken });
        if (!alive || context.business.id !== business.id) return;
        if (!context.business.connectedEmployees) throw new Error('Presencia sin confirmar');
        setPresenceSnapshot({ scope: presenceScope, employees: context.business.connectedEmployees, error: '' });
      } catch (caught) {
        if (!alive) return;
        if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) sessionErrorHandler.current?.(caught);
        else setPresenceSnapshot(previous => ({ scope: presenceScope, employees: previous?.scope === presenceScope ? previous.employees : business.connectedEmployees, error: 'No pudimos actualizar los empleados.' }));
      } finally { inFlight = false; }
    }
    const resume = () => { void refreshPresence(); };
    resume();
    const timer = window.setInterval(resume, 30_000);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [business.id, business.role, managementContent, active, operatorToken, deviceToken, presenceScope, presenceRefresh]);
  useEffect(() => {
    if (homeAnalytics.date !== today || homeAnalytics.period !== 'day') {
      homeAnalytics.setDate(today);
      homeAnalytics.setPeriod('day');
    }
  }, [today, datePulse, homeAnalytics.date, homeAnalytics.period, homeAnalytics.setDate, homeAnalytics.setPeriod]);
  useEffect(() => {
    if (managementContent || active !== 'Inicio' || !canReadReports) return;
    let pending = false;
    const refresh = () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      void homeAnalytics.refresh().finally(() => { pending = false; });
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [managementContent, active, canReadReports, homeAnalytics.refresh]);
  useEffect(() => { setReportTab('sales'); }, [operatorScope]);
  const catalog = useCatalog(
    access,
    hasPermission(business, 'catalog.read') && !managementContent && (active === 'Venta' || active === 'Productos' || Boolean(editingOrder || selectedOrder)),
    onSessionError,
  );
  const accountsEnabled = business.profile.accountsEnabled !== false;
  const canCreateAccount = hasPermission(business, 'orders.manage') && hasPermission(business, 'catalog.read');
  const canTakeOrder = hasPermission(business, 'catalog.read') && (hasPermission(business, 'sales.create') || accountsEnabled && canCreateAccount);
  const canOperate = business.role === 'owner' || (business.permissions ?? []).some(p => ['sales.create', 'sales.reverse', 'orders.read', 'orders.manage', 'kitchen.read', 'cash.read'].includes(p));
  const needsOperations = operating || active === 'Caja' || active === 'Ventas' && hasPermission(business, 'sales.reverse') || Boolean(selectedOrder);
  const operation = useOperations(access, canOperate && needsOperations, onSessionError);
  const mutation = useOperationalMutation(access, business.employee?.id ?? 'owner', onSessionError);
  const snapshot = operation.snapshot;
  const selectedSnapshot = snapshot?.orders.find(o => o.id === selectedOrder?.id);
  const order = selectedSnapshot && selectedSnapshot.revision >= (selectedOrder?.revision ?? 0)
    ? selectedSnapshot : selectedOrder;
  const counterSnapshot = snapshot?.orders.find(o => o.id === savedCounter?.id);
  const counter = counterSnapshot && counterSnapshot.revision >= (savedCounter?.revision ?? 0)
    ? counterSnapshot : savedCounter;
  useEffect(() => {
    if (counterSnapshot && counterSnapshot.revision > (savedCounter?.revision ?? 0)) setSavedCounter(counterSnapshot);
  }, [counterSnapshot, savedCounter?.revision]);
  function isCounterOrder(value: OperationalOrder) {
    return value.orderKind === 'counter' || value.orderKind == null && value.id === counterOrderId.current;
  }
  function orderSaved(saved: OperationalOrder) {
    if (currentOperator.current !== operatorScope) return;
    if (isCounterOrder(saved)) { counterOrderId.current = saved.id; setSavedCounter(saved); }
    else if (saved.orderKind === 'service' && saved.id === counterOrderId.current) { counterOrderId.current = null; setSavedCounter(null); }
    setSelectedOrder(saved);
  }
  function paymentRecorded(saved: OperationalOrder, saleId?: string) {
    if (currentOperator.current !== operatorScope) return;
    const settled = ['paid', 'closed', 'waived', 'cancelled'].includes(saved.status);
    const closingCheckout = settled && checkoutRequested && selectedOrder?.id === saved.id;
    if (settled && saleId && canReadReceipts) setReceipt({ scope: operatorScope, saleId, afterCheckout: closingCheckout });
    if (settled && checkoutDraft.current?.value.orderId === saved.id) checkoutDraft.current = null;
    if (saved.id === counterOrderId.current) setSavedCounter(saved);
    setSelectedOrder(settled && !closingCheckout ? null : saved);
    setPaymentComplete(closingCheckout);
    if (settled && !closingCheckout) setCheckoutRequested(false);
    backOrder.current = null;
    setBackError("");
  }
  function counterItems(): OrderInputLine[] {
    return counter?.items.map(savedOrderLineInput) ?? [];
  }
  async function updateCounter(items: OrderInputLine[]) {
    if (!counter || counter.status !== 'open' || counter.phase !== 'service' || counter.frozen) return;
    const saved = await mutation.execute({ command: 'save_order', operationId: crypto.randomUUID(), orderId: counter.id, expectedRevision: counter.revision, name: counter.name, tableId: counter.tableId, items, ...(counter.orderKind ? { orderKind: counter.orderKind } : {}) }, 'counter');
    if (currentOperator.current !== operatorScope) return;
    setSavedCounter(saved);
    await operation.refresh();
  }
  async function addCounterItem(product: Product, selection?: ItemSelection) {
    const items = counterItems(), price = selectedPrice(product, selection);
    const existing = items.find(line => 'productId' in line && line.productId === product.id && line.version === product.version && line.unitPriceCents === price && lineKey({ product, selection: line.selection }) === lineKey({ product, selection }));
    await updateCounter(existing
      ? items.map(line => line.lineId === existing.lineId ? { ...line, quantity: line.quantity + 1 } : line)
      : [...items, { lineId: crypto.randomUUID(), productId: product.id, version: product.version, unitPriceCents: price, quantity: 1, note: '', ...(selection ? { selection } : {}) }]);
  }
  async function addCounterAmount(amountCents: number, name: string) {
    await updateCounter([...counterItems(), { kind: 'amount', lineId: crypto.randomUUID(), name, quantity: 1, unitPriceCents: amountCents, note: '' }]);
  }
  async function changeCounterQuantity(lineId: string, change: number | 'remove') {
    await updateCounter(counterItems().flatMap(line => {
      if (line.lineId !== lineId) return [line];
      const quantity = change === 'remove' ? 0 : line.quantity + change;
      return quantity > 0 ? [{ ...line, quantity }] : [];
    }));
  }
  async function saveSaleAccount(cart: CartLine[], name?: string) {
    if (currentOperator.current !== operatorScope) return;
    if (counter?.status === 'open') {
      setCheckoutRequested(true);
      setSelectedOrder(counter);
      return;
    }
    const serviceAccount = accountsEnabled;
    if (serviceAccount && !canCreateAccount) throw new Error('Necesitas permiso para administrar cuentas. Pide al dueño que revise tu acceso.');
    const orderId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    saleAccountOperation.current = operationId;
    if (!serviceAccount) counterOrderId.current = orderId;
    const saved = await mutation.execute({ command: 'save_order', operationId, orderId, expectedRevision: null, name: serviceAccount ? name?.trim() || 'Cuenta' : 'Mostrador', tableId: null, orderKind: serviceAccount ? 'service' : 'counter', items: cart.map(cartLineOrderInput) }, serviceAccount ? 'service' : 'counter');
    if (currentOperator.current !== operatorScope) return;
    saleAccountOperation.current = null;
    if (serviceAccount) setSaleResetToken(value => value + 1);
    else setSavedCounter(saved);
    setCheckoutRequested(!serviceAccount);
    setSelectedOrder(saved);
    await operation.refresh();
  }
  function retryOperation() {
    const command = mutation.pending;
    if (!command) return;
    const origin = mutation.pendingOrigin;
    const counterSave = command.command === 'save_order' && command.orderKind !== 'service' && (command.orderKind === 'counter' || origin === 'counter' || command.orderId === counterOrderId.current);
    if (counterSave && command.command === 'save_order') counterOrderId.current = command.orderId;
    const retry = origin ? mutation.execute(command, origin) : mutation.execute(command);
    void retry.then(result => {
      if (currentOperator.current !== operatorScope) return;
      if (command.command === 'save_order') {
        const saved = result as OperationalOrder;
        if (saleAccountOperation.current === command.operationId) {
          saleAccountOperation.current = null;
          if (saved.orderKind === 'service' || origin === 'service') setSaleResetToken(value => value + 1);
        }
        const acceptedCounter = saved.orderKind === 'counter' || saved.orderKind == null && counterSave;
        if (acceptedCounter) { counterOrderId.current = saved.id; setSavedCounter(saved); }
        else if (saved.id === counterOrderId.current) { counterOrderId.current = null; setSavedCounter(null); }
        if (acceptedCounter && !editingOrder && command.expectedRevision === null) {
          setCheckoutRequested(true);
          setSelectedOrder(saved);
        } else if (editingOrder || !acceptedCounter) {
          setEditingOrder(null);
          setCheckoutRequested(false);
          setSelectedOrder(saved);
        }
      }
      if (['record_payment', 'record_checkout'].includes(command.command)) {
        const accepted = result as OperationsResponses['record_payment'];
        paymentRecorded(accepted.order, accepted.attempt.saleId ?? undefined);
      }
      return operation.refresh();
    }).catch(() => {});
  }
  const checkoutView = Boolean(checkoutRequested && order && !editingOrder && hasPermission(business, 'sales.create'));
  async function prepareBackToOrder(): Promise<boolean> {
    backOrder.current = null;
    setBackError("");
    if (pointBlocked) { setBackError('Consulta o cancela el mismo intento integrado antes de volver a editar. Cerrar la pantalla no cancela el cargo.'); return false; }
    if (!order || mutation.pending) return !mutation.pending;
    const live = snapshot?.attempts.find(attempt => attempt.orderId === order.id && attempt.kind === 'payment');
    const accepted = mutation.lastResult?.result as CheckoutAttempt | undefined;
    const last = accepted?.kind === 'payment' && accepted.orderId === order.id ? accepted : undefined;
    let attempt = last && (!live || last.id === live.id && last.revision > live.revision || last.id !== live.id && last.createdAt >= live.createdAt) ? last : live;
    try {
      if (attempt && !['completed', 'aborted'].includes(attempt.status)) {
        attempt = await posRequest(access, {command: 'attempt', attemptId: attempt.id});
        if (currentOperator.current !== operatorScope) return false;
        if (['completed', 'aborted'].includes(attempt.status)) await operation.refresh();
      }
      if (attempt?.status === 'prepared') {
        await mutation.execute({ command: 'resolve_checkout', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, resolution: 'abort', confirmed: true, reason: 'Reserva cancelada al volver a la cuenta' });
        await operation.refresh();
      } else if (!attempt && order.status === 'open' && order.phase === 'checkout' && !order.frozen) {
        const saved = await mutation.execute({ command: 'resume_order_service', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision });
        if (currentOperator.current !== operatorScope) return false;
        orderSaved(saved);
        await operation.refresh();
      }
      if (currentOperator.current !== operatorScope) return false;
      if (!isCounterOrder(order) && order.status === 'open' && !order.frozen && hasPermission(business, 'orders.manage')) {
        const saved = await posRequest(access, { command: 'order', orderId: order.id });
        if (currentOperator.current !== operatorScope) return false;
        if (saved.status === 'open' && saved.phase === 'service' && !saved.frozen) backOrder.current = saved;
      }
      return true;
    } catch (caught) {
      if (currentOperator.current !== operatorScope) return false;
      setBackError(caught instanceof Error ? caught.message : 'No pudimos volver a la orden. Reintenta.');
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
      return false;
    }
  }
  function closeOrderPanel() {
    setCheckoutRequested(false);
    setPaymentComplete(false);
    setSelectedOrder(null);
    setEditingOrder(backOrder.current ? { order: backOrder.current } : null);
    backOrder.current = null;
    setBackError("");
  }
  const OrderPanel = checkoutView ? CheckoutPanel : PosDialog;
  const more = useRef<HTMLDivElement>(null);
  function setActive(next: Destination) {
    setPointPage(null);
    if (isOwner && (next === 'Inicio' || next === 'Productos' || next === 'Reportes' || next === 'Caja')) setOperating(false);
    if (next === 'Venta' || next === 'Comandas') setOperating(true);
    setLocalDestination(next);
    onDestinationChange?.(next);
  }
  function openManagement(action: () => void) {
    setPointPage(null);
    setPointNotice('');
    action();
  }
  function openPoint(page: 'setup' | 'admin') {
    // This also returns App from its management route before opening Point.
    setActive(active);
    setPointNotice('');
    setPointPage(page);
  }
  function openReport(tab: ReportTab) {
    analytics.setDate(today);
    analytics.setPeriod('day');
    setReportTab(tab);
    setActive('Reportes');
  }
  useEffect(() => {
    if (!focusOnReturn || managementContent) return;
    const moreAction = more.current?.querySelector<HTMLButtonElement>(
      `[data-more-item="${focusOnReturn}"]`,
    );
    const workspaceButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-workspace-action]'),
    ).filter((button) => button.getClientRects().length > 0);
    const workspaceAction = workspaceButtons.find(
      (button) => button.dataset.workspaceAction === focusOnReturn,
    ) ?? workspaceButtons.find((button) => button.dataset.workspaceAction === 'menu');
    (moreAction ?? workspaceAction)?.focus();
  }, [focusOnReturn, managementContent, active]);
  function row(
    id: string,
    label: string,
    Icon: LucideIcon,
    action: () => void,
    description?: string,
    navigates = true,
  ) {
    return (
      <button
        type="button"
        className="pos-menu-row"
        data-more-item={id}
        aria-label={label}
        aria-describedby={description ? `more-${id}-help` : undefined}
        disabled={busy}
        onClick={action}
      >
        <Icon className="pos-menu-icon" size={21} strokeWidth={1.6} aria-hidden="true" />
        <span className="pos-menu-copy flex min-w-0 flex-1 flex-col gap-1 [&>span]:font-medium [&_small]:text-sm [&_small]:text-muted">
          <span>{label}</span>
          {description && <small className="sr-only" id={`more-${id}-help`}>{description}</small>}
        </span>
        {navigates && (
          <ChevronRight className="pos-menu-chevron" size={18} strokeWidth={1.6} aria-hidden="true" />
        )}
      </button>
    );
  }
  const visiblePointPage = managementContent ? null : pointPage;
  const title = visiblePointPage === 'setup' ? 'Vincular una terminal' : visiblePointPage === 'admin' ? 'SASORI' : managementTitle ?? (active === 'Ventas' && (!isOwner || operating) ? 'Historial' : active === 'Reportes' && canReadOwnMetrics ? 'Mis métricas' : active);
  return (
    <WorkspaceShell business={business} accountName={accountName} active={active} operating={operating && !managementContent && !pointPage} title={title} busy={busy}
      onSelect={setActive} onLock={onLock} onLogout={onLogout} logoutLabel={logoutLabel} onTeam={onTeam ? () => openManagement(onTeam) : undefined} onDevices={onDevices ? () => openManagement(onDevices) : undefined} onSettings={onSettings ? () => openManagement(onSettings) : undefined} onChangePin={onChangePin ? () => openManagement(onChangePin) : undefined} onAccountProfile={onAccountProfile ? () => openManagement(onAccountProfile) : undefined} onSwitchEmployee={onSwitchEmployee}
      onSwitchBusiness={onSwitchBusiness} onNotifications={onNotifications ? () => openManagement(onNotifications) : undefined} unreadCount={unreadCount} pendingCount={snapshot?.pendingKitchenCount ?? 0} managementKey={pointPage ?? managementKey}
      onPointSetup={isOwner && !deviceToken ? () => openPoint('setup') : undefined} onPointAdmin={point.settings?.permissions.admin ? () => openPoint('admin') : undefined}
      headingAside={active === 'Venta' && !managementContent && !pointPage && snapshot && !operation.error && snapshot.shift?.status !== 'open'
        ? hasPermission(business, 'cash.read')
          ? <button type="button" className="cash-shift-notice" aria-label="Turno cerrado. Ir a Caja" onClick={() => setActive('Caja')}>Turno cerrado</button>
          : <span className="cash-shift-notice" role="status">Turno cerrado</span>
        : undefined}>
      {visiblePointPage && <div className="workspace-management">
        {pointNotice && <p role="status" className="mb-4">{pointNotice}</p>}
        {visiblePointPage === 'setup' ? <PointSetup access={access} controller={point} paymentMethodEnabled={business.profile.paymentMethods.includes('card_integrated')} onOpenPaymentMethods={onSettings ? () => { setPointNotice(''); setPointPage(null); onSettings('payment-methods'); } : undefined} readyToCharge={Boolean(snapshot?.enabled && snapshot.shift?.status === 'open')} onOpenCash={() => { setPointNotice(''); setActive('Caja'); }} onStartSale={() => { setPointNotice(''); setActive('Venta'); }} onSessionError={onSessionError} /> : <PointDashboard access={access} timezone={business.timezone} settings={point.settings} admin onSessionError={onSessionError} />}
      </div>}
      {managementContent && <div className="workspace-management">{managementContent}</div>}
      {point.settings?.sandbox?.testBusiness && !pointPage && !managementContent && <p className="mb-4 text-sm text-muted" role="status">Negocio de pruebas · Los cobros con Mercado Pago son simulados.</p>}
      <section
        className="pos-content flex min-w-0 flex-1 flex-col"
        hidden={Boolean(managementContent || pointPage)}
        aria-labelledby="pos-section-title"
      >
        {notice && (
          <p className="pos-notice mt-4 text-sm text-ink" role="status">
            {notice}
          </p>
        )}
        {Boolean(point.settings?.pending.length) && <section className="ops-message" aria-label="Cobros integrados pendientes"><p>Hay cobros integrados por confirmar. Recupera el mismo intento sin cobrar de nuevo.</p>{point.settings!.pending.map(checkout => <button key={checkout.id} className="pos-button pos-secondary" onClick={() => setRecoverPoint(checkout)}>Recuperar cobro {checkout.id.slice(0, 8).toUpperCase()}</button>)}</section>}
        {error && (
          <p
            className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
            role="alert"
          >
            {error}
          </p>
        )}
        {needsOperations && canOperate && operation.error && <div className="ops-message" role="alert"><p>{operation.error}</p><button className="pos-button pos-secondary" onClick={() => void operation.refresh()} disabled={operation.loading}>Reintentar carga</button></div>}
        {!mutation.busy && (mutation.pending || mutation.error) && <div className="ops-message" role={mutation.error ? 'alert' : 'status'}>
          {mutation.error && <p>{mutation.error}</p>}
          {!mutation.busy && mutation.pending && <><p>Hay una solicitud por confirmar. Reintenta el mismo registro sin repetir el movimiento de dinero.</p><button className="pos-button pos-secondary" onClick={retryOperation}>Reintentar solicitud guardada</button></>}
        </div>}

        {(saleVisited || active === 'Venta') && canTakeOrder && (
          <div hidden={active !== "Venta"}>
            <SaleScreen
              access={access}
              businessName={business.name}
              employeeId={business.employee?.id ?? "owner"}
              catalog={catalog}
              onProducts={() => setActive("Productos")}
              onHistory={() => setActive("Ventas")}
              onSessionError={onSessionError}
              canAvailability={hasPermission(business, 'catalog.availability')}
              canFavorite={hasPermission(business, 'catalog.manage')}
              onAccount={snapshot?.enabled ? saveSaleAccount : undefined}
              serviceAccounts={accountsEnabled}
              canCreateAccount={canCreateAccount}
              resetToken={saleResetToken}
              canAmount={hasPermission(business, 'sales.create') || hasPermission(business, 'orders.manage')}
              defaultVatTreatment={business.profile.defaultVatTreatment}
              configuredMethods={business.profile.paymentMethods}
              collectionReady={Boolean(snapshot) && !operation.error && !mutation.pending && !mutation.busy}
              collectionAllowed={snapshot?.shift?.status === 'open'}
              activationRequired={snapshot?.enabled === false}
              onOpenCash={hasPermission(business, 'cash.read') ? () => setActive('Caja') : undefined}
              savedCounter={counter ?? undefined}
              onAccountAdd={addCounterItem}
              onAccountAmount={addCounterAmount}
              accountPending={Boolean(mutation.pending)}
              onAccountQuantity={changeCounterQuantity}
              onAccountClear={() => updateCounter([])}
            />
          </div>
        )}
        {active === "Inicio" && !managementContent ? (
          <ReportDashboard controller={homeAnalytics} presence={business.role === 'owner' ? presence : undefined} presenceError={scopedPresence?.error} onPresenceRetry={() => setPresenceRefresh(value => value + 1)} onOpenReport={openReport} onOpenTeam={onTeam} />
        ) : active === "Reportes" && !managementContent ? (
          canReadOwnMetrics ? <PersonalMetricsScreen controller={ownMetrics} /> : <>
            {point.settings?.permissions.reports && <div role="group" aria-label="Tipo de reporte" className="analytics-metric-switch mb-4"><button aria-pressed={!pointReport} onClick={() => setPointReport(false)}>Operación del POS</button><button aria-pressed={pointReport} onClick={() => setPointReport(true)}>Pagos integrados</button></div>}
            {pointReport && point.settings?.permissions.reports ? <PointDashboard access={access} timezone={business.timezone} settings={point.settings} onSessionError={onSessionError} /> : <ReportsScreen controller={analytics} tab={reportTab} onTabChange={setReportTab} />}
          </>
        ) : active === "Caja" ? (
          snapshot ? <CashScreen business={business} access={access} snapshot={snapshot} mutation={mutation} refresh={operation.refresh} onSessionError={onSessionError} /> : !operation.error && <LoadingPlaceholder variant="cards" rows={3} label="Cargando caja" />
        ) : active === "Productos" ? (
          <ProductsScreen
            access={access}
            catalog={catalog}
            canManage={hasPermission(business, 'catalog.manage')}
            defaultVatTreatment={business.profile.defaultVatTreatment}
            canAvailability={hasPermission(business, 'catalog.availability')}
            onSessionError={onSessionError}
          />
        ) : active === "Ventas" ? (
          <SalesScreen
            key={`${business.employee?.id}:${JSON.stringify(business.permissions)}`}
            businessName={business.name}
            access={access}
            ownOnly={!hasPermission(business, 'sales.read_all')}
            canReverse={hasPermission(business, 'sales.reverse')}
            attempts={snapshot?.attempts ?? []}
            collectionAllowed={snapshot?.shift?.status === 'open'}
            mutation={mutation}
            onOperationSaved={operation.refresh}
            onSessionError={onSessionError}
          />
        ) : active === "Comandas" ? (
          snapshot ? <OrdersScreen business={business} access={access} snapshot={snapshot} mutation={mutation} onOrder={saved => { setCheckoutRequested(false); setSelectedOrder(saved); }} onNew={() => { setCheckoutRequested(false); setEditingOrder({}); }} refresh={operation.refresh} onSessionError={onSessionError} /> : !operation.error && <LoadingPlaceholder variant="cards" rows={4} label="Cargando comandas" />
        ) : active === "Más" && !isOwner ? (
          <div className="pos-more mt-6 w-full max-w-160 tablet:max-w-280" ref={more}>
            {!isOwner && allowed.length === 1 && <p>Tu cuenta no tiene permisos de operación. Pide al dueño que revise tu acceso.</p>}
            {onChangePin && (
              <section
                className="pos-menu-group [&+section]:mt-7 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:text-muted tablet:[&_h2]:mb-0"
                aria-labelledby="more-access-title"
              >
                <h2 id="more-access-title">Mi acceso</h2>
                {onChangePin &&
                  row("pin", "Cambiar mi PIN", KeyRound, () => onChangePin('pin'))}
              </section>
            )}
            <section
              className="pos-menu-group [&+section]:mt-7 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:text-muted tablet:[&_h2]:mb-0"
              aria-labelledby="more-session-title"
            >
              <h2 id="more-session-title">Sesión</h2>
              {onSwitchBusiness && row('business','Cambiar negocio',Users,onSwitchBusiness)}
              {onSwitchEmployee &&
                row(
                  "employee",
                  "Cambiar empleado",
                  Users,
                  onSwitchEmployee,
                  "Volver a la lista de empleados",
                  false,
                )}
              {!onSwitchEmployee &&
                row(
                  "lock",
                  "Bloquear app",
                  LockKeyhole,
                  onLock,
                  "Pedir PIN para volver a entrar",
                  false,
                )}
              {!onSwitchEmployee &&
                row(
                  "logout",
                  logoutLabel,
                  LogOut,
                  onLogout,
                  "Volver a entrar con Google y PIN",
                  false,
                )}
            </section>
          </div>
        ) : null}
      </section>
      {(editingOrder || order) && <OrderPanel {...(checkoutView ? { completed: paymentComplete } : editingOrder ? { className: 'order-editor-dialog' } : {})} title={editingOrder ? editingOrder.order ? 'Editar cuenta' : 'Abrir cuenta' : checkoutView ? 'Cobrar' : order!.name} busy={mutation.busy || pointBlocked} beforeClose={checkoutView ? prepareBackToOrder : undefined} onClose={closeOrderPanel}>
        <div className="ops-section">
          {backError && !mutation.error && <p role="alert">{backError}</p>}
          {mutation.error && <p role="alert">{mutation.error}</p>}
          {!mutation.busy && mutation.pending && <><p>Reintenta la solicitud guardada sin repetir el cobro.</p><button className="pos-button pos-secondary" onClick={retryOperation}>Reintentar solicitud guardada</button></>}
          {editingOrder ? <OrderEditor key={editingOrder.order?.id ?? 'new'} order={editingOrder.order} serviceAccount={!editingOrder.order || !isCounterOrder(editingOrder.order)} products={catalog.products} catalogLoading={!catalog.loaded && !catalog.error} catalogError={!catalog.loaded ? catalog.error : ''} onRetryCatalog={catalog.refresh} mutation={mutation} onSaved={saved => { setEditingOrder(null); setCheckoutRequested(false); orderSaved(saved); void operation.refresh(); }} onCancel={() => setEditingOrder(null)} /> : order && <OrderDetail key={order.id} checkoutView={checkoutView} serviceAccount={order.orderKind === 'service'} onStartCheckout={() => setCheckoutRequested(true)} access={access} onSessionError={onSessionError} order={order} business={business} methods={catalog.loaded && !catalog.error ? catalog.paymentMethods : business.profile.paymentMethods} attempts={snapshot?.attempts ?? []} mutation={mutation} collectionAllowed={snapshot?.shift?.status === 'open'} onSaved={orderSaved} onPaymentRecorded={paymentRecorded} onEdit={() => setEditingOrder({ order })} refresh={operation.refresh} pointSettings={point.settings} onPointBlocked={setPointBlocked}
            onReceipt={canReadReceipts ? saleId => { if (currentOperator.current === operatorScope) setReceipt({ scope: operatorScope, saleId, afterCheckout: false }); } : undefined}
            draft={checkoutDraft.current?.scope === operatorScope ? checkoutDraft.current.value : undefined}
            onDraftChange={value => { if (!paymentComplete && currentOperator.current === operatorScope) checkoutDraft.current = { scope: operatorScope, value }; }}
            onOpenCash={hasPermission(business, 'cash.read') ? () => { void prepareBackToOrder().then(canClose => {
              if (!canClose || currentOperator.current !== operatorScope) return;
              backOrder.current = null;
              closeOrderPanel();
              setActive('Caja');
            }); } : undefined}
          />}
        </div>
      </OrderPanel>}
      {receipt?.scope === operatorScope && canReadReceipts && (!receipt.afterCheckout || !selectedOrder) && <SaleReceiptDialog key={`${operatorScope}:${receipt.saleId}`} access={access} businessName={business.name} saleId={receipt.saleId} onSessionError={onSessionError} onClose={() => setReceipt(null)} />}
      {recoverPoint && <CheckoutPanel title="Recuperar cobro integrado" busy={pointBlocked} onClose={() => setRecoverPoint(null)}><PointPayment access={access} businessName={business.name} initialCheckout={recoverPoint} settings={point.settings} onSessionError={onSessionError} onBlocked={setPointBlocked} onResolved={() => { void operation.refresh(); void point.refresh(); }} onDone={() => { setRecoverPoint(null); setPointBlocked(false); void operation.refresh(); void point.refresh(); }} /></CheckoutPanel>}


    </WorkspaceShell>
  );
}
