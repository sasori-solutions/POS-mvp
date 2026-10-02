import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, Bell, ChevronRight, ClipboardList, KeyRound, LayoutGrid, LockKeyhole, LogOut, Menu, Package, ReceiptText, Store, Tablet, Users, type LucideIcon } from 'lucide-react'
import type { BusinessContext } from '../lib/contracts'
import { roleSections } from '../lib/navigation'
import type { AccountClientError } from '../lib/account'
import ProductsScreen from './ProductsScreen'
import SaleScreen from './SaleScreen'
import SalesScreen from './SalesScreen'
import { useCatalog } from './useCatalog'
import './home-screen.css'
import './products-sales.css'

interface HomeScreenProps {
  business: BusinessContext
  operatorToken: string
  deviceToken?: string
  onSessionError?: (error: AccountClientError) => void
  onLock: () => void
  onLogout: () => void
  busy: boolean
  error: string
  notice?: string
  destination?: Destination
  onDestinationChange?: (destination: Destination) => void
  focusOnReturn?: string
  onNotifications?: () => void
  unreadCount?: number
  onSettings?: () => void
  onTeam?: () => void
  onDevices?: () => void
  onSwitchBusiness?: () => void
  onChangePin?: () => void
  onSwitchEmployee?: () => void
  logoutLabel?: string
}

const destinations = [
  { name: 'Venta', icon: LayoutGrid },
  { name: 'Comandas', icon: ClipboardList },
  { name: 'Ventas', icon: ReceiptText },
  { name: 'Productos', icon: Package },
  { name: 'Más', icon: Menu },
] as const

export type Destination = typeof destinations[number]['name']


const upcoming = {
  Comandas: { title: 'Comandas, próximamente', description: 'Aquí podrás consultar las cuentas abiertas de tu negocio.', icon: ClipboardList },
} as const

export default function HomeScreen({ business, operatorToken, deviceToken, onSessionError, onLock, onLogout, busy, error, notice, destination: selectedDestination, onDestinationChange, focusOnReturn, onSettings, onTeam, onDevices, onSwitchBusiness, onChangePin, onSwitchEmployee, onNotifications, unreadCount = 0, logoutLabel = 'Cerrar sesión' }: HomeScreenProps) {
  const [localDestination, setLocalDestination] = useState<Destination>(business.role === 'kitchen' ? 'Comandas' : 'Venta')
  const destination = selectedDestination ?? localDestination
  const access = { businessId: business.id, operatorToken, deviceToken }
  const catalog = useCatalog(access, business.role !== 'kitchen', onSessionError)
  const more = useRef<HTMLDivElement>(null)
  function setActive(next: Destination) {
    setLocalDestination(next)
    onDestinationChange?.(next)
  }
  useEffect(() => {
    if (focusOnReturn) more.current?.querySelector<HTMLButtonElement>(`[data-more-item="${focusOnReturn}"]`)?.focus()
  }, [focusOnReturn])
  function row(id: string, label: string, Icon: LucideIcon, action: () => void, description?: string, navigates = true) {
    return <button type="button" className="pos-menu-row" data-more-item={id} aria-label={label} aria-describedby={description ? `more-${id}-help` : undefined} disabled={busy} onClick={action}>
      <Icon size={21} strokeWidth={1.6} aria-hidden="true" />
      <span className="pos-menu-copy"><span>{label}</span>{description && <small id={`more-${id}-help`}>{description}</small>}</span>
      {navigates && <ChevronRight size={18} strokeWidth={1.6} aria-hidden="true" />}
    </button>
  }
  const allowedDestinations = destinations.filter(({ name }) => name === 'Más' || roleSections[business.role].includes(name))
  const active = allowedDestinations.some(({ name }) => name === destination) ? destination : business.role === 'kitchen' ? 'Comandas' : 'Venta'
  const upcomingSection = active === 'Comandas' ? upcoming.Comandas : null
  const SectionIcon = upcomingSection?.icon

  return <div className="pos-home-shell">
    <header className="pos-header">
      <p className="pos-business-name">{business.name}</p>
      {business.employee && <span className="pos-employee-name">{business.employee.name}</span>}
      {business.role === 'owner' && onNotifications && <button className="pos-icon-button notification-button" type="button" aria-label={`Notificaciones${unreadCount ? `, ${unreadCount} sin leer` : ''}`} onClick={onNotifications} disabled={busy}><Bell size={22} aria-hidden="true" />{unreadCount > 0 && <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}</button>}
      <button className="pos-icon-button" type="button" aria-label="Bloquear" title="Bloquear" onClick={onLock} disabled={busy} aria-busy={busy}>
        <LockKeyhole size={22} strokeWidth={1.6} aria-hidden="true" />
      </button>
    </header>

    <section className="pos-content" aria-labelledby="pos-section-title">
      <h1 id="pos-section-title" className="pos-section-title">{active}</h1>
      {notice && <p className="pos-notice" role="status">{notice}</p>}
      {error && <p className="pos-error" role="alert">{error}</p>}

      {business.role !== 'kitchen' && <div hidden={active !== 'Venta'}><SaleScreen access={access} employeeId={business.employee?.id ?? 'owner'} catalog={catalog} onProducts={() => setActive('Productos')} onHistory={() => setActive('Ventas')} onSessionError={onSessionError} /></div>}
      {active === 'Productos' ? <ProductsScreen access={access} catalog={catalog} canManage={business.role === 'owner' || business.role === 'manager'} onSessionError={onSessionError} />
        : active === 'Ventas' ? <SalesScreen key={`${business.employee?.id}:${business.role}`} access={access} ownOnly={business.role === 'cashier'} onSessionError={onSessionError} />
        : active === 'Más' ? <div className="pos-more" ref={more}>
        {business.role === 'owner' && <section className="pos-menu-group" aria-labelledby="more-business-title">
          <h2 id="more-business-title">Negocio</h2>
          {onNotifications && row('notifications', 'Notificaciones', Bell, onNotifications, 'Solicitudes de cambio de dispositivo')}
          {onSettings && row('settings', 'Datos del negocio', Store, onSettings, 'Nombre, dirección y formas de pago')}
          {onTeam && row('employees', 'Empleados', Users, onTeam, 'Agregar personas y administrar su acceso')}
          {onDevices && row('devices', 'Dispositivos de caja', Tablet, onDevices, 'Tablets y computadoras donde trabaja tu equipo')}
        </section>}
        {onChangePin && <section className="pos-menu-group" aria-labelledby="more-access-title">
          <h2 id="more-access-title">Mi acceso</h2>
          {onChangePin && row('pin', 'Cambiar mi PIN', KeyRound, onChangePin)}
        </section>}
        <section className="pos-menu-group" aria-labelledby="more-session-title">
          <h2 id="more-session-title">Sesión</h2>
          {onSwitchBusiness && row('business', 'Cambiar negocio', ArrowLeftRight, onSwitchBusiness)}
          {onSwitchEmployee && row('employee', 'Cambiar empleado', Users, onSwitchEmployee, 'Volver a la lista de empleados', false)}
          {!onSwitchEmployee && row('lock', 'Bloquear app', LockKeyhole, onLock, 'Pedir PIN para volver a entrar', false)}
          {!onSwitchEmployee && row('logout', logoutLabel, LogOut, onLogout, 'Volver a entrar con Google y PIN', false)}
        </section>
      </div> : upcomingSection && <div className="pos-empty">
        {SectionIcon && <SectionIcon className="pos-empty-icon" size={32} strokeWidth={1.4} aria-hidden="true" />}
        <h2>{upcomingSection.title}</h2>
        <p>{upcomingSection.description}</p>
      </div>}
    </section>

    <nav className="pos-navigation" aria-label="Navegación principal">
      {allowedDestinations.map(({ name, icon: Icon }) => <button
        className="pos-nav-item"
        type="button"
        key={name}
        onClick={() => setActive(name)}
        aria-current={active === name ? 'page' : undefined}
      >
        <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
        <span>{name}</span>
      </button>)}
    </nav>
  </div>
}
