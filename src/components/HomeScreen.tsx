import { useState } from 'react'
import { ClipboardList, LayoutGrid, LockKeyhole, LogOut, Menu, Package, ReceiptText } from 'lucide-react'
import type { BusinessContext } from '../lib/contracts'
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
  timezoneLabel: string
  onSettings?: () => void
  onTeam?: () => void
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

type Destination = typeof destinations[number]['name']

const businessTypes = { cafe: 'Cafetería', restaurant: 'Restaurante', other: 'Otro' }

const upcoming = {
  Comandas: { title: 'Comandas, próximamente', description: 'Aquí podrás consultar las cuentas abiertas de tu negocio.', icon: ClipboardList },
} as const

export default function HomeScreen({ business, operatorToken, deviceToken, onSessionError, onLock, onLogout, busy, error, timezoneLabel, onSettings, onTeam, onSwitchBusiness, onChangePin, onRecoveryCode, onSwitchEmployee, logoutLabel = 'Cerrar sesión' }: HomeScreenProps) {
  const [destination, setActive] = useState<Destination>(business.role === 'kitchen' ? 'Comandas' : 'Venta')
  const access = { businessId: business.id, operatorToken, deviceToken }
  const catalog = useCatalog(access, business.role !== 'kitchen', onSessionError)
  const allowedDestinations = destinations.filter(({ name }) => business.role === 'kitchen' ? name === 'Comandas' || name === 'Más' : true)
  const active = allowedDestinations.some(({ name }) => name === destination) ? destination : business.role === 'kitchen' ? 'Comandas' : 'Venta'
  const upcomingSection = active === 'Comandas' ? upcoming.Comandas : null
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
      {error && <p className="pos-error" role="alert">{error}</p>}

      {business.role !== 'kitchen' && <div hidden={active !== 'Venta'}><SaleScreen access={access} employeeId={business.employee?.id ?? 'owner'} catalog={catalog} onProducts={() => setActive('Productos')} onHistory={() => setActive('Ventas')} onSessionError={onSessionError} /></div>}
      {active === 'Productos' ? <ProductsScreen access={access} catalog={catalog} canManage={business.role === 'owner' || business.role === 'manager'} onSessionError={onSessionError} />
        : active === 'Ventas' ? <SalesScreen key={`${business.employee?.id}:${business.role}`} access={access} ownOnly={business.role === 'cashier'} onSessionError={onSessionError} />
        : active === 'Más' ? <div className="pos-more">
        <dl className="pos-business-details">
          <div><dt>Tipo de negocio</dt><dd>{businessTypes[business.businessType]}</dd></div>
          <div><dt>Zona horaria</dt><dd>{timezoneLabel}</dd></div>
          <div><dt>Moneda</dt><dd>{business.currency}</dd></div>
        </dl>
        {business.role === 'owner' && <div className="pos-security-actions">
          {onSettings && <button className="pos-button pos-secondary" disabled={busy} onClick={onSettings}>Configurar negocio</button>}
          {onTeam && <button className="pos-button pos-secondary" disabled={busy} onClick={onTeam}>Equipo y dispositivos</button>}
        </div>}
        {(onChangePin || (business.role === 'owner' && onRecoveryCode)) && <div className="pos-security-actions">
          {onChangePin && <button className="pos-button pos-secondary" disabled={busy} onClick={onChangePin}>Cambiar PIN</button>}
          {business.role === 'owner' && onRecoveryCode && <button className="pos-button pos-secondary" disabled={busy} onClick={onRecoveryCode}>Recuperación de mi PIN</button>}
        </div>}
        <div className="pos-security-actions">
          {onSwitchBusiness && <button className="pos-button pos-secondary" disabled={busy} onClick={onSwitchBusiness}>Cambiar negocio</button>}
          {onSwitchEmployee && <button className="pos-button pos-secondary" disabled={busy} onClick={onSwitchEmployee}>Cambiar empleado</button>}
          <button className="pos-button pos-secondary" type="button" onClick={onLock} disabled={busy} aria-busy={busy}>
            <LockKeyhole size={20} strokeWidth={1.6} aria-hidden="true" />Bloquear app
          </button>
          <button className="pos-button pos-secondary" type="button" onClick={onLogout} disabled={busy} aria-busy={busy}>
            <LogOut size={20} strokeWidth={1.6} aria-hidden="true" />{logoutLabel}
          </button>
        </div>
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
