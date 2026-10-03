import { useRef, type ReactNode } from 'react'
import { Home, LayoutGrid, ClipboardList, ReceiptText, Package, Menu, Wallet, ChartNoAxesCombined, Users, Settings, ArrowRight, ArrowLeft, LockKeyhole, Bell, LogOut } from 'lucide-react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import type { BusinessContext } from '../lib/contracts'
import { primaryDestinations, type Destination } from '../lib/navigation'
gsap.registerPlugin(useGSAP)
const icons = { Inicio: Home, Venta: LayoutGrid, Comandas: ClipboardList, Ventas: ReceiptText, Productos: Package, Más: Menu, Caja: Wallet, Reportes: ChartNoAxesCombined }

export default function WorkspaceShell({ business, active, operating, title, busy, onSelect, onLock, onLogout, logoutLabel, onTeam, onSettings, onNotifications, unreadCount, pendingCount, managementKey, children }: {
  business: BusinessContext; active: Destination; operating: boolean; title: string; busy: boolean
  onSelect: (destination: Destination) => void; onLock: () => void; onLogout: () => void; logoutLabel: string
  onTeam?: () => void; onSettings?: () => void; onNotifications?: () => void; unreadCount: number; pendingCount: number
  managementKey?: string; children: ReactNode
}) {
  const owner = business.role === 'owner'
  const root = useRef<HTMLDivElement>(null)
  useGSAP(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const heading=root.current?.querySelector('.workspace-page-heading')
    if (heading) gsap.fromTo(heading,{y:4,opacity:0.75},{y:0,opacity:1,duration:0.16,clearProps:'transform,opacity'})
  },{scope:root,dependencies:[title],revertOnUpdate:true})
  const primary=primaryDestinations(business,operating)
  const sidebar=owner&&!operating?['Inicio','Ventas','Productos','Caja','Reportes'] as Destination[]:primary
  const label=(d:Destination)=>d==='Ventas' && (!owner||operating)?'Historial':d
  function item(d:Destination,mobile=false) {
    const Icon=icons[d], selected=managementKey ? mobile && d==='Más' : active===d || d==='Más'&&!primary.includes(active)&&mobile
    return <button type="button" key={d} disabled={busy} className={mobile?'workspace-mobile-item':'workspace-nav-item'} aria-current={selected?'page':undefined} onClick={()=>onSelect(d)}>
      <span className="workspace-icon"><Icon size={21} strokeWidth={1.7}/>{d==='Comandas'&&pendingCount>0&&<span className="workspace-badge">{pendingCount>99?'99+':pendingCount}</span>}</span><span>{label(d)}</span>
    </button>
  }
  return <div ref={root} className={`workspace-shell ${owner&&!operating?'workspace-owner':'workspace-operator'}`}>
    <aside className="workspace-sidebar" aria-label="Menú del negocio">
      <div className="workspace-brand"><span className="workspace-business-mark">{business.name.slice(0,1).toUpperCase()}</span><span>{business.name}<small>{owner&&!operating?'Gestión del negocio':business.employee?.name??'Punto de venta'}</small></span></div>
      <nav aria-label="Navegación lateral">{sidebar.map(d=>item(d))}{owner&&!operating&&<>
        {onTeam&&<button className="workspace-nav-item" disabled={busy} aria-current={managementKey==='team'?'page':undefined} onClick={onTeam}><Users size={21}/><span>Empleados</span></button>}
        {onSettings&&<button className="workspace-nav-item" disabled={busy} aria-current={managementKey==='settings'?'page':undefined} onClick={onSettings}><Settings size={21}/><span>Configuración</span></button>}
        {item('Más')}
      </>}</nav>
      <div className="workspace-sidebar-bottom">
        {owner&&<button className="workspace-nav-item workspace-mode" disabled={busy} onClick={()=>onSelect(operating?'Inicio':'Venta')}>{operating?<Home size={21}/>:<LayoutGrid size={21}/>}<span>{operating?'Inicio del negocio':'Ir a venta'}</span></button>}
        <button className="workspace-nav-item" disabled={busy} onClick={onLogout}><LogOut size={21}/><span>{logoutLabel}</span></button>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-header">
        <span className="workspace-mobile-business">{business.name}</span>
        {owner&&<button className="workspace-mobile-mode" disabled={busy} onClick={()=>onSelect(operating?'Inicio':'Venta')}>{operating?<ArrowLeft size={17}/>:null}{operating?'Inicio':'Ir a venta'}{!operating&&<ArrowRight size={17}/>}</button>}
        <div className="workspace-header-actions">{owner&&onNotifications&&<button className="pos-icon-button workspace-icon" aria-label={`Notificaciones${unreadCount?`, ${unreadCount} sin leer`:''}`} disabled={busy} onClick={onNotifications}><Bell size={21}/>{unreadCount>0&&<span className="workspace-badge">{unreadCount>99?'99+':unreadCount}</span>}</button>}<button className="pos-icon-button" aria-label="Bloquear" disabled={busy} onClick={onLock}><LockKeyhole size={21}/></button></div>
      </header>
      <div className="workspace-page-heading"><h1 id="pos-section-title">{title}</h1>{business.employee&&<span>{business.employee.name}</span>}</div>
      {children}
    </div>
    <nav className="workspace-mobile-nav" aria-label="Navegación principal" style={{gridTemplateColumns:`repeat(${primary.length}, minmax(0,1fr))`}}>{primary.map(d=>item(d,true))}</nav>
  </div>
}
