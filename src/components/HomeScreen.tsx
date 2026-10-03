import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  Bell,
  ChevronRight,
  KeyRound,
  LockKeyhole,
  LogOut,
  Package,
  Wallet,
  ChartNoAxesCombined,
  Store,
  Tablet,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { BusinessContext } from "../lib/contracts";
import { availableDestinations, initialDestination, type Destination } from "../lib/navigation";
export type { Destination } from "../lib/navigation";
import WorkspaceShell from "./WorkspaceShell";
import ReportDashboard from "../features/operations/ReportDashboard";
import { hasPermission } from "../lib/business-access";
import type { OperationsResponses, OperationalOrder, OrderInputLine, CheckoutAttempt } from "../lib/operations-contracts";
import type { CartLine, ItemSelection, Product } from "../lib/pos-contracts";
import { lineKey, selectedPrice } from "../lib/product-details";
import { AccountClientError } from "../lib/account";
import ProductsScreen from "./ProductsScreen";
import SaleScreen from "./SaleScreen";
import CheckoutPanel from "./CheckoutPanel";
import SalesScreen from "./SalesScreen";
import { accessErrorCodes, useCatalog } from "./useCatalog";
import { posRequest } from "../lib/pos";
import { PosDialog } from "./PosShared";
import { useOperationalMutation, useOperations } from "../features/operations/useOperations";
import CashScreen from "../features/operations/CashScreen";
import OrdersScreen from "../features/operations/OrdersScreen";
import ReportsScreen from "../features/operations/ReportsScreen";
import OrderDetail from "../features/operations/OrderDetail";
import OrderEditor from "../features/operations/OrderEditor";

interface HomeScreenProps {
  business: BusinessContext;
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
  onSettings?: () => void;
  onTeam?: () => void;
  onDevices?: () => void;
  onSwitchBusiness?: () => void;
  onChangePin?: () => void;
  onSwitchEmployee?: () => void;
  logoutLabel?: string;
  managementContent?: ReactNode;
  managementTitle?: string;
  managementKey?: string;
}

export default function HomeScreen({
  business,
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
  const [confirmUnpaid, setConfirmUnpaid] = useState(false);
  const unpaidDecision = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => () => { unpaidDecision.current?.(false); }, []);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [editingOrder, setEditingOrder] = useState<{ order?: OperationalOrder } | null>(null);
  const [savedCounter, setSavedCounter] = useState<OperationalOrder | null>(null);
  const counterOrderId = useRef<string | null>(null);
  const backOrder = useRef<OperationalOrder | null>(null);
  const [backError, setBackError] = useState("");
  const operatorScope = `${business.id}:${operatorToken}:${deviceToken ?? ''}`;
  const currentOperator = useRef<string | null>(operatorScope);
  currentOperator.current = operatorScope;
  useEffect(() => {
    currentOperator.current = operatorScope;
    return () => { currentOperator.current = null; };
  }, [operatorScope]);
  const destination = selectedDestination ?? localDestination;
  const allowed = availableDestinations(business);
  const active = allowed.includes(destination) ? destination : initialDestination(business);
  const isOwner = business.role === 'owner';
  const [operating, setOperating] = useState(!isOwner || active === 'Venta' || active === 'Comandas');
  const [saleVisited, setSaleVisited] = useState(active === 'Venta');
  useEffect(() => { if (active === 'Venta') setSaleVisited(true); }, [active]);
  const access = { businessId: business.id, operatorToken, deviceToken };
  const catalog = useCatalog(
    access,
    hasPermission(business, 'catalog.read') && !managementContent && (active === 'Venta' || active === 'Productos' || Boolean(editingOrder || selectedOrder)),
    onSessionError,
  );
  const canOperate = business.role === 'owner' || (business.permissions ?? []).some(p => ['sales.create', 'sales.reverse', 'orders.read', 'kitchen.read', 'cash.read'].includes(p));
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
  function orderSaved(saved: OperationalOrder) {
    if (saved.id === counterOrderId.current) setSavedCounter(saved);
    setSelectedOrder(saved);
  }
  function paymentRecorded(saved: OperationalOrder) {
    if (currentOperator.current !== operatorScope) return;
    if (saved.id === counterOrderId.current) setSavedCounter(saved);
    setPaymentComplete(selectedOrder?.id === saved.id);
    backOrder.current = null;
    setBackError("");
  }
  function counterItems(): OrderInputLine[] {
    return counter?.items.map(line => ({ lineId: line.lineId, productId: line.productId, version: line.version, unitPriceCents: line.unitPriceCents, quantity: line.quantity, note: line.note, ...(line.selection ? { selection: line.selection } : {}) })) ?? [];
  }
  async function updateCounter(items: OrderInputLine[]) {
    if (!counter || counter.status !== 'open' || counter.phase !== 'service' || counter.frozen) return;
    const saved = await mutation.execute({ command: 'save_order', operationId: crypto.randomUUID(), orderId: counter.id, expectedRevision: counter.revision, name: counter.name, tableId: counter.tableId, items });
    setSavedCounter(saved);
    await operation.refresh();
  }
  async function addCounterItem(product: Product, selection?: ItemSelection) {
    const items = counterItems(), price = selectedPrice(product, selection);
    const existing = items.find(line => line.productId === product.id && line.version === product.version && line.unitPriceCents === price && lineKey({ product, selection: line.selection }) === lineKey({ product, selection }));
    await updateCounter(existing
      ? items.map(line => line.lineId === existing.lineId ? { ...line, quantity: line.quantity + 1 } : line)
      : [...items, { lineId: crypto.randomUUID(), productId: product.id, version: product.version, unitPriceCents: price, quantity: 1, note: '', ...(selection ? { selection } : {}) }]);
  }
  async function changeCounterQuantity(lineId: string, change: number | 'remove') {
    await updateCounter(counterItems().flatMap(line => {
      if (line.lineId !== lineId) return [line];
      const quantity = change === 'remove' ? 0 : line.quantity + change;
      return quantity > 0 ? [{ ...line, quantity }] : [];
    }));
  }
  async function saveCounter(cart: CartLine[]) {
    if (counter?.status === 'open') {
      setSelectedOrder(counter);
      return;
    }
    const orderId = crypto.randomUUID();
    counterOrderId.current = orderId;
    const saved = await mutation.execute({ command: 'save_order', operationId: crypto.randomUUID(), orderId, expectedRevision: null, name: 'Mostrador', tableId: null, items: cart.map(line => ({ lineId: crypto.randomUUID(), productId: line.product.id, version: line.product.version, unitPriceCents: selectedPrice(line.product, line.selection), quantity: line.quantity, note: '', ...(line.selection ? { selection: line.selection } : {}) })) });
    setSavedCounter(saved);
    setSelectedOrder(saved);
    await operation.refresh();
  }
  function retryOperation() {
    const command = mutation.pending;
    if (!command) return;
    if (command.command === 'save_order' && !command.tableId && command.name === 'Mostrador') counterOrderId.current = command.orderId;
    void mutation.execute(command).then(result => {
      if (command.command === 'save_order' && command.orderId === counterOrderId.current) {
        const saved = result as OperationalOrder;
        setSavedCounter(saved);
        if (command.expectedRevision === null) setSelectedOrder(saved);
      }
      if (['record_payment', 'record_checkout'].includes(command.command)) paymentRecorded((result as OperationsResponses['record_payment']).order);
      return operation.refresh();
    }).catch(() => {});
  }
  const checkoutView = Boolean(order && !editingOrder && hasPermission(business, 'sales.create'));
  async function prepareBackToOrder(): Promise<boolean> {
    backOrder.current = null;
    setBackError("");
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
        setConfirmUnpaid(true);
        const unpaid = await new Promise<boolean>(resolve => { unpaidDecision.current = resolve; });
        if (!unpaid || currentOperator.current !== operatorScope) return false;
        await mutation.execute({ command: 'resolve_checkout', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, resolution: 'abort', confirmed: true, reason: 'Operador confirma que no recibió pago al volver a editar' });
        await operation.refresh();
      } else if (!attempt && order.status === 'open' && order.phase === 'checkout' && !order.frozen) {
        const saved = await mutation.execute({ command: 'resume_order_service', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision });
        if (currentOperator.current !== operatorScope) return false;
        orderSaved(saved);
        await operation.refresh();
      }
      if (currentOperator.current !== operatorScope) return false;
      if (order.id !== counterOrderId.current && order.status === 'open' && !order.frozen && hasPermission(business, 'orders.manage')) {
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
    setPaymentComplete(false);
    setSelectedOrder(null);
    setEditingOrder(backOrder.current ? { order: backOrder.current } : null);
    backOrder.current = null;
    setBackError("");
  }
  const OrderPanel = checkoutView ? CheckoutPanel : PosDialog;
  const more = useRef<HTMLDivElement>(null);
  function setActive(next: Destination) {
    if (isOwner && (next === 'Inicio' || next === 'Productos' || next === 'Reportes' || next === 'Caja')) setOperating(false);
    if (next === 'Venta' || next === 'Comandas') setOperating(true);
    setLocalDestination(next);
    onDestinationChange?.(next);
  }
  useEffect(() => {
    if (focusOnReturn)
      more.current
        ?.querySelector<HTMLButtonElement>(
          `[data-more-item="${focusOnReturn}"]`,
        )
        ?.focus();
  }, [focusOnReturn]);
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
        className="pos-menu-row flex min-h-14 w-full items-center gap-4 border-0 border-b border-line bg-transparent py-4 text-left hover:bg-surface [&>svg]:shrink-0"
        data-more-item={id}
        aria-label={label}
        aria-describedby={description ? `more-${id}-help` : undefined}
        disabled={busy}
        onClick={action}
      >
        <Icon size={21} strokeWidth={1.6} aria-hidden="true" />
        <span className="pos-menu-copy flex min-w-0 flex-1 flex-col gap-1 [&>span]:font-medium [&_small]:text-sm [&_small]:text-muted">
          <span>{label}</span>
          {description && <small id={`more-${id}-help`}>{description}</small>}
        </span>
        {navigates && (
          <ChevronRight size={18} strokeWidth={1.6} aria-hidden="true" />
        )}
      </button>
    );
  }
  const title = managementTitle ?? (active === 'Ventas' && (!isOwner || operating) ? 'Historial' : active);
  return (
    <WorkspaceShell business={business} active={active} operating={operating && !managementContent} title={title} busy={busy}
      onSelect={setActive} onLock={onLock} onLogout={onLogout} logoutLabel={logoutLabel} onTeam={onTeam} onSettings={onSettings}
      onNotifications={onNotifications} unreadCount={unreadCount} pendingCount={snapshot?.pendingKitchenCount ?? 0} managementKey={managementKey}>
      {managementContent && <div className="workspace-management">{managementContent}</div>}
      <section
        className="pos-content flex min-w-0 flex-1 flex-col"
        hidden={Boolean(managementContent)}
        aria-labelledby="pos-section-title"
      >
        {notice && (
          <p className="pos-notice mt-4 text-sm text-ink" role="status">
            {notice}
          </p>
        )}
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

        {(saleVisited || active === 'Venta') && hasPermission(business, 'sales.create') && hasPermission(business, 'catalog.read') && (
          <div hidden={active !== "Venta"}>
            <SaleScreen
              access={access}
              employeeId={business.employee?.id ?? "owner"}
              catalog={catalog}
              onProducts={() => setActive("Productos")}
              onHistory={() => setActive("Ventas")}
              onSessionError={onSessionError}
              canAvailability={hasPermission(business, 'catalog.availability')}
              onAccount={snapshot?.enabled ? saveCounter : undefined}
              collectionReady={Boolean(snapshot) && !operation.error && !mutation.pending && !mutation.busy}
              savedCounter={counter ?? undefined}
              onAccountAdd={addCounterItem}
              onAccountQuantity={changeCounterQuantity}
              onAccountClear={() => updateCounter([])}
            />
          </div>
        )}
        {active === "Inicio" && !managementContent ? (
          <ReportDashboard access={access} timezone={business.timezone} onSessionError={onSessionError} onSale={() => setActive('Venta')} onCash={() => setActive('Caja')} onTeam={onTeam} />
        ) : active === "Reportes" && !managementContent ? (
          <ReportsScreen access={access} timezone={business.timezone} onSessionError={onSessionError} />
        ) : active === "Caja" ? (
          snapshot ? <CashScreen business={business} access={access} snapshot={snapshot} mutation={mutation} refresh={operation.refresh} onSessionError={onSessionError} /> : <p role="status">Cargando caja…</p>
        ) : active === "Productos" ? (
          <ProductsScreen
            access={access}
            catalog={catalog}
            canManage={hasPermission(business, 'catalog.manage')}
            canAvailability={hasPermission(business, 'catalog.availability')}
            onSessionError={onSessionError}
          />
        ) : active === "Ventas" ? (
          <SalesScreen
            key={`${business.employee?.id}:${JSON.stringify(business.permissions)}`}
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
          snapshot ? <OrdersScreen business={business} access={access} snapshot={snapshot} mutation={mutation} onOrder={setSelectedOrder} onNew={() => setEditingOrder({})} refresh={operation.refresh} onSessionError={onSessionError} /> : <p role="status">Cargando comandas…</p>
        ) : active === "Más" ? (
          <div className="pos-more mt-6 w-full max-w-160" ref={more}>
            {!isOwner && hasPermission(business, 'catalog.read') && <section className="pos-menu-group"><h2>Productos</h2>{row('products','Productos',Package,()=>setActive('Productos'),'Catálogo y disponibilidad autorizada')}</section>}
            {!isOwner && allowed.length === 1 && <p>Tu cuenta no tiene permisos de operación. Pide al dueño que revise tu acceso.</p>}
            {(hasPermission(business, 'cash.read') || hasPermission(business, 'reports.read')) && <section className="pos-menu-group [&+section]:mt-7 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:text-muted"><h2>Operación</h2>{hasPermission(business, 'cash.read') && row('cash', 'Caja', Wallet, () => setActive('Caja'), 'Turnos, efectivo y cierre')}{hasPermission(business, 'reports.read') && row('reports', 'Reportes', ChartNoAxesCombined, () => setActive('Reportes'), 'Ventas del día y diferencias de caja')}</section>}
            {business.role === "owner" && (
              <section
                className="pos-menu-group [&+section]:mt-7 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:text-muted"
                aria-labelledby="more-business-title"
              >
                <h2 id="more-business-title">Negocio</h2>
                {onNotifications &&
                  row(
                    "notifications",
                    "Notificaciones",
                    Bell,
                    onNotifications,
                    "Solicitudes de cambio de dispositivo",
                  )}
                {onSettings &&
                  row(
                    "settings",
                    "Datos del negocio",
                    Store,
                    onSettings,
                    "Nombre, dirección y formas de pago",
                  )}
                {onTeam &&
                  row(
                    "employees",
                    "Empleados",
                    Users,
                    onTeam,
                    "Agregar personas y administrar su acceso",
                  )}
                {onDevices &&
                  row(
                    "devices",
                    "Dispositivos de caja",
                    Tablet,
                    onDevices,
                    "Tablets y computadoras donde trabaja tu equipo",
                  )}
              </section>
            )}
            {onChangePin && (
              <section
                className="pos-menu-group [&+section]:mt-7 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:text-muted"
                aria-labelledby="more-access-title"
              >
                <h2 id="more-access-title">Mi acceso</h2>
                {onChangePin &&
                  row("pin", "Cambiar mi PIN", KeyRound, onChangePin)}
              </section>
            )}
            <section
              className="pos-menu-group [&+section]:mt-7 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:text-muted"
              aria-labelledby="more-session-title"
            >
              <h2 id="more-session-title">Sesión</h2>
              {onSwitchBusiness &&
                row(
                  "business",
                  "Cambiar negocio",
                  ArrowLeftRight,
                  onSwitchBusiness,
                )}
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
      {(editingOrder || order) && <OrderPanel {...(checkoutView ? { completed: paymentComplete } : {})} title={editingOrder ? editingOrder.order ? 'Editar cuenta' : 'Abrir cuenta' : checkoutView ? 'Cobrar' : order!.name} busy={mutation.busy} beforeClose={checkoutView ? prepareBackToOrder : undefined} onClose={closeOrderPanel}>
        <div className="ops-section">
          {backError && !mutation.error && <p role="alert">{backError}</p>}
          {mutation.error && <p role="alert">{mutation.error}</p>}
          {!mutation.busy && mutation.pending && <><p>Reintenta la solicitud guardada sin repetir el cobro.</p><button className="pos-button pos-secondary" onClick={retryOperation}>Reintentar solicitud guardada</button></>}
          {editingOrder ? <OrderEditor key={editingOrder.order?.id ?? 'new'} order={editingOrder.order} products={catalog.products} mutation={mutation} onSaved={saved => { setEditingOrder(null); orderSaved(saved); void operation.refresh(); }} onCancel={() => setEditingOrder(null)} /> : order && <OrderDetail key={order.id} checkoutView={checkoutView} access={access} onSessionError={onSessionError} order={order} business={business} methods={catalog.paymentMethods} attempts={snapshot?.attempts ?? []} mutation={mutation} collectionAllowed={snapshot?.shift?.status === 'open'} onSaved={orderSaved} onPaymentRecorded={paymentRecorded} onEdit={() => setEditingOrder({ order })} refresh={operation.refresh} />}
        </div>
      </OrderPanel>}
      {confirmUnpaid && <PosDialog title="¿Volver a la cuenta?" busy={false} onClose={() => { setConfirmUnpaid(false); unpaidDecision.current?.(false); }}>
        <p>Confirma que aún no recibiste el pago. Si ya recibiste dinero, registra o recupera ese pago antes de editar.</p>
        <div className="dialog-actions"><button className="pos-button pos-primary" onClick={() => { setConfirmUnpaid(false); unpaidDecision.current?.(true); }}>Volver sin haber recibido pago</button><button className="pos-button pos-secondary" onClick={() => { setConfirmUnpaid(false); unpaidDecision.current?.(false); }}>Continuar cobrando</button></div>
      </PosDialog>}


    </WorkspaceShell>
  );
}
