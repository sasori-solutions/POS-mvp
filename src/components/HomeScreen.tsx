import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Bell,
  ChevronRight,
  ClipboardList,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  LogOut,
  Menu,
  Package,
  ReceiptText,
  RefreshCw,
  Store,
  Tablet,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { BusinessContext } from "../lib/contracts";
import { businessWorkSections } from "../lib/navigation";
import { hasPermission } from "../lib/business-access";
import type { AccountClientError } from "../lib/account";
import ProductsScreen from "./ProductsScreen";
import SaleScreen from "./SaleScreen";
import SalesScreen from "./SalesScreen";
import { useCatalog } from "./useCatalog";

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
}

const destinations = [
  { name: "Venta", icon: LayoutGrid },
  { name: "Comandas", icon: ClipboardList },
  { name: "Ventas", icon: ReceiptText },
  { name: "Productos", icon: Package },
  { name: "Más", icon: Menu },
] as const;

export type Destination = (typeof destinations)[number]["name"];

const upcoming = {
  Comandas: {
    title: "Comandas, próximamente",
    description: "Aquí podrás consultar las cuentas abiertas de tu negocio.",
    icon: ClipboardList,
  },
} as const;

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
}: HomeScreenProps) {
  const [localDestination, setLocalDestination] = useState<Destination>(
    businessWorkSections(business)[0] ?? "Más",
  );
  const destination = selectedDestination ?? localDestination;
  const access = { businessId: business.id, operatorToken, deviceToken };
  const catalog = useCatalog(
    access,
    hasPermission(business, "catalog.read"),
    onSessionError,
  );
  const more = useRef<HTMLDivElement>(null);
  function setActive(next: Destination) {
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
  const allowedDestinations = destinations.filter(
    ({ name }) => name === "Más" || businessWorkSections(business).includes(name),
  );
  const active = allowedDestinations.some(({ name }) => name === destination)
    ? destination
    : allowedDestinations[0].name;
  const upcomingSection = active === "Comandas" ? upcoming.Comandas : null;
  const SectionIcon = upcomingSection?.icon;

  return (
    <div className="pos-home-shell group/home mx-auto flex min-h-dvh w-full max-w-260 has-[.sale-workspace]:max-w-360 has-[.products-screen]:max-w-360 flex-col px-4 pt-4 pb-[calc(96px+env(safe-area-inset-bottom))] tablet:px-8 tablet:pt-6 tablet:pb-[calc(108px+env(safe-area-inset-bottom))]">
      <header className="pos-header flex min-h-13 items-center gap-4 [&>:nth-child(2)]:ml-auto">
        <p className="pos-business-name min-w-0 text-xl leading-snug font-medium text-ink [overflow-wrap:anywhere]">
          {business.name}
        </p>
        {business.employee && (
          <span className="pos-employee-name ml-auto text-sm text-muted">
            {business.employee.name}
          </span>
        )}
        {business.role === "owner" && onNotifications && (
          <button
            className="pos-icon-button notification-button relative"
            type="button"
            aria-label={`Notificaciones${unreadCount ? `, ${unreadCount} sin leer` : ""}`}
            onClick={onNotifications}
            disabled={busy}
          >
            <Bell size={22} aria-hidden="true" />
            {unreadCount > 0 && (
              <span className="notification-badge absolute -top-px -right-1 h-4.5 min-w-4.5 rounded-full bg-brand px-1 text-[11px] leading-4.5 text-white">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
        )}
        <button
          className="pos-icon-button"
          type="button"
          aria-label="Bloquear"
          title="Bloquear"
          onClick={onLock}
          disabled={busy}
          aria-busy={busy}
        >
          <LockKeyhole size={22} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </header>

      <section
        className="pos-content mt-6 flex min-w-0 flex-1 flex-col tablet:mt-8"
        aria-labelledby="pos-section-title"
      >
        <div className="flex items-center justify-between gap-4">
          <h1
            id="pos-section-title"
            className="pos-section-title text-[26px] leading-tight font-medium tracking-tight"
          >
            {active}
          </h1>
          {(active === "Venta" || active === "Productos") && (
            <button
              className="pos-icon-button"
              type="button"
              aria-label="Actualizar productos"
              title="Actualizar productos"
              onClick={() => void catalog.refresh()}
              disabled={busy || catalog.loading}
              aria-busy={catalog.loading}
            >
              <RefreshCw size={21} strokeWidth={1.6} aria-hidden="true" />
            </button>
          )}
        </div>
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

        {hasPermission(business, "sales.create") && hasPermission(business, "catalog.read") && (
          <div hidden={active !== "Venta"}>
            <SaleScreen
              access={access}
              employeeId={business.employee?.id ?? "owner"}
              catalog={catalog}
              onProducts={() => setActive("Productos")}
              onHistory={() => setActive("Ventas")}
              onSessionError={onSessionError}
              canAvailability={hasPermission(business, 'catalog.availability')}
            />
          </div>
        )}
        {active === "Productos" ? (
          <ProductsScreen
            access={access}
            catalog={catalog}
            canManage={hasPermission(business, "catalog.manage")}
            onSessionError={onSessionError}
          />
        ) : active === "Ventas" ? (
          <SalesScreen
            key={`${business.employee?.id}:${JSON.stringify(business.permissions)}`}
            access={access}
            ownOnly={!hasPermission(business, "sales.read_all")}
            onSessionError={onSessionError}
          />
        ) : active === "Más" ? (
          <div className="pos-more mt-6 w-full max-w-160" ref={more}>
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
        ) : (
          upcomingSection && (
            <div className="pos-empty flex min-h-70 flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center tablet:min-h-90 [&_h2]:text-[22px] [&_p]:max-w-[32ch]">
              {SectionIcon && (
                <SectionIcon
                  className="pos-empty-icon mb-2 text-muted"
                  size={32}
                  strokeWidth={1.4}
                  aria-hidden="true"
                />
              )}
              <h2>{upcomingSection.title}</h2>
              <p>{upcomingSection.description}</p>
            </div>
          )
        )}
      </section>

      <nav
        className="pos-navigation fixed bottom-0 left-1/2 z-40 grid min-h-19 w-full max-w-260 group-has-[.sale-workspace]/home:max-w-360 group-has-[.products-screen]/home:max-w-360 -translate-x-1/2 grid-cols-5 border-t border-line bg-white px-1 pt-1 pb-[calc(4px+env(safe-area-inset-bottom))]"
        aria-label="Navegación principal"
      >
        {allowedDestinations.map(({ name, icon: Icon }) => (
          <button
            className="pos-nav-item flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-lg border-0 bg-transparent py-2 text-xs text-muted hover:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-ink tablet:text-sm max-[22.5rem]:text-[11px]"
            type="button"
            key={name}
            onClick={() => setActive(name)}
            aria-current={active === name ? "page" : undefined}
          >
            <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
            <span>{name}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
