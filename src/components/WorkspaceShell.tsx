import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Home, LayoutGrid, ClipboardList, ReceiptText, Package, Menu, Wallet, ChartNoAxesCombined, Users, Settings, Tablet, KeyRound, ArrowRight, ArrowLeftRight, ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, X, LockKeyhole, Bell, LogOut } from 'lucide-react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import type { BusinessContext } from '../lib/contracts'
import { primaryDestinations, type Destination } from '../lib/navigation'

gsap.registerPlugin(useGSAP)
const icons = { Inicio: Home, Venta: LayoutGrid, Comandas: ClipboardList, Ventas: ReceiptText, Productos: Package, Más: Menu, Caja: Wallet, Reportes: ChartNoAxesCombined }

function AccountSwitcher({ name, busy, onChangePin, onLogout, logoutLabel }: {
  name: string; busy: boolean; onChangePin?: () => void; onLogout: () => void; logoutLabel: string
}) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const initials = name.includes('@')
    ? name.slice(0, 1).toUpperCase()
    : name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()

  useEffect(() => {
    if (!expanded) return
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setExpanded(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [expanded])

  return <div className="workspace-account" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false) }}
    onKeyDown={event => {
      if (event.key === 'Escape' && expanded) {
        event.preventDefault()
        event.stopPropagation()
        setExpanded(false)
        trigger.current?.focus()
      }
    }}>
    <button type="button" ref={trigger} className="workspace-account-trigger" disabled={busy}
      aria-label={`Opciones de cuenta: ${name}`} aria-expanded={expanded} aria-controls={expanded ? id : undefined} data-workspace-action="account"
      onClick={() => setExpanded(value => !value)}>
      <span className="workspace-avatar" aria-hidden="true">{initials}</span>
      <span className="workspace-account-name">{name}</span>
      <ChevronRight size={19} aria-hidden="true" className={expanded ? 'workspace-account-chevron expanded' : 'workspace-account-chevron'}/>
    </button>
    {expanded && <div className="workspace-account-options" id={id} role="group" aria-label="Opciones de cuenta">
      {onChangePin && <button type="button" className="workspace-nav-item" disabled={busy} onClick={() => { setExpanded(false); onChangePin() }}><KeyRound size={21} aria-hidden="true"/><span>Cambiar mi PIN</span></button>}
      <button type="button" className="workspace-nav-item" disabled={busy} onClick={onLogout}><ArrowLeftRight size={21} aria-hidden="true"/><span>Cambiar cuenta</span></button>
      <button type="button" className="workspace-nav-item" disabled={busy} onClick={onLogout}><LogOut size={21} aria-hidden="true"/><span>{logoutLabel}</span></button>
    </div>}
  </div>
}

export default function WorkspaceShell({ business, accountName, active, operating, title, busy, onSelect, onLock, onLogout, logoutLabel, onSwitchBusiness, onTeam, onDevices, onSettings, onChangePin, onNotifications, unreadCount, pendingCount, managementKey, headingAside, children }: {
  business: BusinessContext; accountName?: string; active: Destination; operating: boolean; title: string; busy: boolean
  onSelect: (destination: Destination) => void; onLock: () => void; onLogout: () => void; logoutLabel: string
  onSwitchBusiness?: () => void; onTeam?: () => void; onDevices?: () => void; onSettings?: () => void; onChangePin?: () => void; onNotifications?: () => void; unreadCount: number; pendingCount: number
  managementKey?: string; headingAside?: ReactNode; children: ReactNode
}) {
  const owner = business.role === 'owner'
  const ownerDashboard = owner && !operating
  const root = useRef<HTMLDivElement>(null)
  const drawer = useRef<HTMLDialogElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [navigationCollapsed, setNavigationCollapsed] = useState(false)
  const drawerId = useId()
  const sidebarId = useId()

  useGSAP(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const heading = root.current?.querySelector('.workspace-page-heading')
    if (heading) gsap.fromTo(heading, { y: 4, opacity: 0.75 }, { y: 0, opacity: 1, duration: 0.16, clearProps: 'transform,opacity' })
  }, { scope: root, dependencies: [title], revertOnUpdate: true })

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 64rem)')
    const closeOnDesktop = () => { if (desktop.matches) setNavigationOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  useEffect(() => {
    if (!navigationOpen || !ownerDashboard) {
      drawer.current?.close()
      return
    }
    const panel = drawer.current
    if (!panel) return
    panel.showModal()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const animation = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? undefined
      : gsap.fromTo(panel, { x: -24, opacity: 0.8 }, { x: 0, opacity: 1, duration: 0.2, ease: 'expo.out', clearProps: 'transform,opacity' })
    return () => {
      animation?.revert()
      panel.close()
      document.body.style.overflow = previousOverflow
    }
  }, [navigationOpen, ownerDashboard])

  const primary = primaryDestinations(business, operating)
  const sidebar: Destination[] = ownerDashboard ? ['Inicio', 'Ventas', 'Productos', 'Caja', 'Reportes'] : primary
  const label = (d: Destination) => d === 'Ventas' && (!owner || operating) ? 'Historial' : d
  function select(action: () => void) {
    setNavigationOpen(false)
    action()
  }
  function item(d: Destination, mobile = false) {
    const Icon = icons[d]
    const selected = managementKey ? mobile && d === 'Más' : active === d || d === 'Más' && !primary.includes(active) && mobile
    return <button type="button" key={d} disabled={busy} className={mobile ? 'workspace-mobile-item' : 'workspace-nav-item'} aria-current={selected ? 'page' : undefined} title={ownerDashboard && navigationCollapsed ? label(d) : undefined} onClick={() => select(() => onSelect(d))}>
      <span className="workspace-icon"><Icon size={21} strokeWidth={1.7} aria-hidden="true"/>{d === 'Comandas' && pendingCount > 0 && <span className="workspace-badge">{pendingCount > 99 ? '99+' : pendingCount}</span>}</span><span>{label(d)}</span>
    </button>
  }
  function ownerPanel(mobile = false) {
    const PanelToggle = navigationCollapsed ? PanelLeftOpen : PanelLeftClose
    return <div className="workspace-owner-panel">
      <div className="workspace-panel-top">
        <button type="button" className="workspace-business-switch" disabled={busy || !onSwitchBusiness} aria-label={`Cambiar negocio: ${business.name}`} data-workspace-action="business" onClick={() => { if (onSwitchBusiness) select(onSwitchBusiness) }}>
          <span className="workspace-business-mark" aria-hidden="true">{business.name.slice(0, 1).toUpperCase()}</span>
          <span className="workspace-business-name">{business.name}</span>
          <ChevronDown size={19} aria-hidden="true"/>
        </button>
        {mobile
          ? <button type="button" className="workspace-panel-toggle workspace-drawer-toggle" aria-label="Cerrar menú" onClick={() => setNavigationOpen(false)}><X size={21} aria-hidden="true"/></button>
          : <button type="button" className="workspace-panel-toggle workspace-sidebar-toggle" aria-label={navigationCollapsed ? 'Expandir panel de navegación' : 'Contraer panel de navegación'} aria-expanded={!navigationCollapsed} aria-controls={sidebarId} title={navigationCollapsed ? 'Expandir panel' : 'Contraer panel'} onClick={() => setNavigationCollapsed(value => !value)}><PanelToggle size={21} aria-hidden="true"/></button>}
      </div>
      <nav aria-label="Navegación del dueño" className="workspace-owner-navigation">
        {sidebar.map(d => item(d))}
        {onTeam && <button type="button" className="workspace-nav-item" disabled={busy} aria-label="Empleados" title={navigationCollapsed ? 'Empleados' : undefined} aria-current={managementKey === 'team' ? 'page' : undefined} data-workspace-action="employees" onClick={() => select(onTeam)}><Users size={21} aria-hidden="true"/><span>Empleados</span></button>}
        {onDevices && <button type="button" className="workspace-nav-item" disabled={busy} aria-label="Dispositivos" title={navigationCollapsed ? 'Dispositivos' : undefined} aria-current={managementKey === 'devices' ? 'page' : undefined} data-workspace-action="devices" onClick={() => select(onDevices)}><Tablet size={21} aria-hidden="true"/><span>Dispositivos</span></button>}
        {onSettings && <button type="button" className="workspace-nav-item" disabled={busy} aria-label="Configuración" title={navigationCollapsed ? 'Configuración' : undefined} aria-current={managementKey === 'settings' ? 'page' : undefined} data-workspace-action="settings" onClick={() => select(onSettings)}><Settings size={21} aria-hidden="true"/><span>Configuración</span></button>}
      </nav>
      <div className="workspace-sidebar-bottom">
        <button type="button" className="workspace-nav-item workspace-mode" disabled={busy} title={navigationCollapsed ? 'Punto de Venta' : undefined} aria-label="Punto de Venta" onClick={() => select(() => onSelect('Venta'))}><LayoutGrid size={21}/><span>Punto de Venta</span><ArrowRight className="workspace-mode-arrow" size={18}/></button>
        <AccountSwitcher name={accountName || 'Mi cuenta'} busy={busy} onChangePin={onChangePin ? () => select(onChangePin) : undefined} onLogout={() => select(onLogout)} logoutLabel={logoutLabel}/>
      </div>
    </div>
  }

  return <div ref={root} className={`workspace-shell ${ownerDashboard ? `workspace-owner${navigationCollapsed ? ' workspace-owner-collapsed' : ''}` : 'workspace-operator'}`}>
    <aside id={sidebarId} className="workspace-sidebar" aria-label="Menú del negocio">
      {ownerDashboard ? ownerPanel() : <>
        <div className="workspace-brand"><span className="workspace-business-mark">{business.name.slice(0, 1).toUpperCase()}</span><span>{business.name}{!owner && <small>{business.employee?.name ?? 'Punto de venta'}</small>}</span></div>
        <nav aria-label="Navegación lateral">{sidebar.map(d => item(d))}</nav>
        <div className="workspace-sidebar-bottom">
          {owner && <button type="button" className="workspace-nav-item workspace-mode" disabled={busy} onClick={() => onSelect('Inicio')}><Home size={21}/><span>Dashboard</span></button>}
          <button type="button" className="workspace-nav-item" disabled={busy} onClick={onLogout}><LogOut size={21}/><span>{logoutLabel}</span></button>
        </div>
      </>}
    </aside>
    {ownerDashboard && <dialog ref={drawer} id={drawerId} className="workspace-drawer" aria-label="Menú del negocio"
      onCancel={() => setNavigationOpen(false)} onClose={() => { setNavigationOpen(false); menuTrigger.current?.focus() }}
      onClick={event => { if (event.target === event.currentTarget) setNavigationOpen(false) }}>
      {navigationOpen && ownerPanel(true)}
    </dialog>}
    <div className="workspace-main">
      <header className="workspace-header">
        {ownerDashboard && <button type="button" ref={menuTrigger} className="pos-icon-button workspace-menu-toggle" aria-label="Abrir menú" aria-expanded={navigationOpen} aria-controls={drawerId} data-workspace-action="menu" onClick={() => setNavigationOpen(true)}><Menu size={23} aria-hidden="true"/></button>}
        <span className="workspace-mobile-business">{business.name}</span>
        {owner && !operating && <button type="button" className="workspace-mobile-mode" disabled={busy} onClick={() => onSelect('Venta')}>Punto de Venta<ArrowRight size={17}/></button>}
        <div className="workspace-header-actions">
          {owner && operating && <button type="button" className="workspace-mobile-mode workspace-mobile-mode-icon" aria-label="Dashboard" title="Dashboard" disabled={busy} onClick={() => onSelect('Inicio')}><Home size={21} aria-hidden="true"/></button>}
          {owner && onNotifications && <button type="button" className="pos-icon-button" aria-label={`Notificaciones${unreadCount ? `, ${unreadCount} sin leer` : ''}`} disabled={busy} data-workspace-action="notifications" onClick={onNotifications}><span className="workspace-icon"><Bell size={21} aria-hidden="true"/>{unreadCount > 0 && <span className="workspace-badge workspace-notification-badge" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>}</span></button>}
          <button type="button" className="pos-icon-button" aria-label="Bloquear" disabled={busy} onClick={onLock}><LockKeyhole size={21}/></button>
        </div>
      </header>
      <div className="workspace-page-heading"><h1 id="pos-section-title">{title}</h1>{(!owner && business.employee || headingAside) && <div className="workspace-heading-meta">{!owner && business.employee && <span>{business.employee.name}</span>}{headingAside}</div>}</div>
      {children}
    </div>
    {!ownerDashboard && <nav className="workspace-mobile-nav" aria-label="Navegación principal" style={{ gridTemplateColumns: `repeat(${primary.length}, minmax(0,1fr))` }}>{primary.map(d => item(d, true))}</nav>}
  </div>
}
