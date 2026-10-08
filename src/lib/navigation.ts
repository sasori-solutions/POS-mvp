import type { BusinessContext } from './contracts'
import { hasPermission } from './business-access'

export type WorkSection = 'Venta' | 'Comandas' | 'Ventas' | 'Productos'

export const workSections: readonly WorkSection[] = ['Venta', 'Comandas', 'Ventas', 'Productos']

export type Destination = WorkSection | 'Inicio' | 'Caja' | 'Reportes' | 'Más'

type NavigationBusiness = Pick<BusinessContext, 'role' | 'permissions'> & Partial<Pick<BusinessContext, 'profile'>>

export function availableDestinations(business: NavigationBusiness): Destination[] {
  return [...(business.role === 'owner' ? ['Inicio' as const] : []), ...businessWorkSections(business),
    ...(hasPermission(business, 'cash.read') ? ['Caja' as const] : []),
    ...(hasPermission(business, 'reports.read') || hasPermission(business, 'reports.read_own') ? ['Reportes' as const] : []),
    ...(business.role === 'owner' ? [] : ['Más' as const])]
}

export function initialDestination(business: NavigationBusiness): Destination {
  return availableDestinations(business)[0]
}

export function primaryDestinations(business: NavigationBusiness, operating: boolean): Destination[] {
  if (business.role === 'owner' && !operating) return ['Inicio', 'Ventas', 'Productos', 'Reportes']
  const allowed = availableDestinations(business)
  const primary: Destination[] = ['Venta', 'Comandas', 'Ventas', ...(business.role === 'owner' ? ['Productos'] : [])].filter((d): d is WorkSection => allowed.includes(d as Destination))
  if (!primary.length && initialDestination(business) !== 'Más') primary.push(initialDestination(business))
  return business.role === 'owner' ? primary : [...primary, 'Más']
}

export function businessWorkSections(business: NavigationBusiness): WorkSection[] {
  return workSections.filter(section => {
    switch (section) {
      case 'Venta': return hasPermission(business, 'catalog.read') && (hasPermission(business, 'sales.create') || business.profile?.accountsEnabled !== false && hasPermission(business, 'orders.manage'))
      case 'Comandas': return hasPermission(business, 'orders.read') || hasPermission(business, 'kitchen.read')
      case 'Ventas': return hasPermission(business, 'sales.read_own') || hasPermission(business, 'sales.read_all')
      case 'Productos': return hasPermission(business, 'catalog.read') || hasPermission(business, 'catalog.manage') || hasPermission(business, 'catalog.availability')
    }
  })
}

/** Desktop and the mobile drawer expose every permitted operational module. */
export function sidebarDestinations(business: NavigationBusiness, operating: boolean): Destination[] {
  if (business.role === 'owner' && !operating) return ['Inicio', 'Ventas', 'Productos', 'Caja', 'Reportes']
  return availableDestinations(business).filter(destination => destination !== 'Inicio' && destination !== 'Más')
}
