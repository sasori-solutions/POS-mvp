import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, ChevronRight, ClipboardList, KeyRound, LayoutGrid, LockKeyhole, LogOut, Menu, Package, ReceiptText, ShieldCheck, Store, Tablet, Users, type LucideIcon } from 'lucide-react'
import type { BusinessContext } from '../lib/contracts'
import './home-screen.css'

interface HomeScreenProps {
  business: BusinessContext
  onLock: () => void
  onLogout: () => void
  busy: boolean
  error: string
  notice?: string
  destination?: Destination
  onDestinationChange?: (destination: Destination) => void
  focusOnReturn?: string
  onSettings?: () => void
  onTeam?: () => void
  onDevices?: () => void
  onSwitchBusiness?: () => void
  onChangePin?: () => void
  onRecoveryCode?: () => void
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
  Ventas: { title: 'Ventas, próximamente', description: 'Aquí podrás consultar tus ventas registradas.', icon: ReceiptText },
  Productos: { title: 'Tu catálogo, próximamente', description: 'Aquí podrás agregar y organizar los productos de tu negocio.', icon: Package },
} as const

export default function HomeScreen({ business, onLock, onLogout, busy, error, notice, destination: selectedDestination, onDestinationChange, focusOnReturn, onSettings, onTeam, onDevices, onSwitchBusiness, onChangePin, onRecoveryCode, onSwitchEmployee, logoutLabel = 'Cerrar sesión' }: HomeScreenProps) {
  const [localDestination, setLocalDestination] = useState<Destination>(business.role === 'kitchen' ? 'Comandas' : 'Venta')
  const destination = selectedDestination ?? localDestination
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
  const allowedDestinations = destinations.filter(({ name }) => business.role === 'kitchen' ? name === 'Comandas' || name === 'Más' : business.role === 'cashier' ? name !== 'Ventas' : true)
  const active = allowedDestinations.some(({ name }) => name === destination) ? destination : business.role === 'kitchen' ? 'Comandas' : 'Venta'
  const upcomingSection = active === 'Comandas' || active === 'Ventas' || active === 'Productos' ? upcoming[active] : null
  const SectionIcon = upcomingSection?.icon

  return <div className="pos-home-shell">
    <header className="pos-header">
      <p className="pos-business-name">{business.name}</p>
      {business.employee && <span className="pos-employee-name">{business.employee.name}</span>}
      <button className="pos-icon-button" type="button" aria-label="Bloquear" title="Bloquear" onClick={onLock} disabled={busy} aria-busy={busy}>
        <LockKeyhole size={22} strokeWidth={1.6} aria-hidden="true" />
      </button>
    </header>

    <section className="pos-content" aria-labelledby="pos-section-title">
      <h1 id="pos-section-title" className="pos-section-title">{active}</h1>
      {notice && <p className="pos-notice" role="status">{notice}</p>}
      {error && <p className="pos-error" role="alert">{error}</p>}

      {active === 'Venta' ? <>
        <div className="pos-categories" aria-label="Categorías">
          <span className="pos-category">Todo</span>
        </div>
        <div className="pos-empty">
          <Package className="pos-empty-icon" size={32} strokeWidth={1.4} aria-hidden="true" />
          <h2>Aún no hay productos</h2>
          <p>La venta estará disponible próximamente.</p>
        </div>
        <div className="pos-sale-action">
          <button className="pos-button pos-primary" type="button" onClick={() => setActive('Productos')}>Ver productos</button>
        </div>
      </> : active === 'Más' ? <div className="pos-more" ref={more}>
        {business.role === 'owner' && <section className="pos-menu-group" aria-labelledby="more-business-title">
          <h2 id="more-business-title">Negocio</h2>
          {onSettings && row('settings', 'Datos del negocio', Store, onSettings, 'Nombre, dirección y formas de pago')}
          {onTeam && row('employees', 'Empleados', Users, onTeam, 'Agregar personas y administrar su acceso')}
          {onDevices && row('devices', 'Dispositivos de caja', Tablet, onDevices, 'Tablets y computadoras donde trabaja tu equipo')}
        </section>}
        {(onChangePin || (business.role === 'owner' && onRecoveryCode)) && <section className="pos-menu-group" aria-labelledby="more-access-title">
          <h2 id="more-access-title">Mi acceso</h2>
          {onChangePin && row('pin', 'Cambiar mi PIN', KeyRound, onChangePin)}
          {business.role === 'owner' && onRecoveryCode && row('recovery', 'Código de recuperación', ShieldCheck, onRecoveryCode, 'Guarda un código por si olvidas tu PIN')}
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
