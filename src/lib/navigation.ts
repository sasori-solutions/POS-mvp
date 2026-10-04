import type { BusinessContext } from './contracts'
import { hasPermission } from './business-access'

export type WorkSection = 'Venta' | 'Comandas' | 'Ventas' | 'Productos'

export const workSections: readonly WorkSection[] = ['Venta', 'Comandas', 'Ventas', 'Productos']

export type Destination = WorkSection | 'Inicio' | 'Caja' | 'Reportes' | 'Más'

export function availableDestinations(business: Pick<BusinessContext, 'role' | 'permissions'>): Destination[] {
  return [...(business.role === 'owner' ? ['Inicio' as const] : []), ...businessWorkSections(business),
    ...(hasPermission(business, 'cash.read') ? ['Caja' as const] : []),
    ...(hasPermission(business, 'reports.read') ? ['Reportes' as const] : []),
    ...(business.role === 'owner' ? [] : ['Más' as const])]
}

export function initialDestination(business: Pick<BusinessContext, 'role' | 'permissions'>): Destination {
  return availableDestinations(business)[0]
}

export function primaryDestinations(business: Pick<BusinessContext, 'role' | 'permissions'>, operating: boolean): Destination[] {
  if (business.role === 'owner' && !operating) return ['Inicio', 'Ventas', 'Productos', 'Reportes']
  const allowed = availableDestinations(business)
  const primary: Destination[] = ['Venta', 'Comandas', 'Ventas', ...(business.role === 'owner' ? ['Productos'] : [])].filter((d): d is WorkSection => allowed.includes(d as Destination))
  if (!primary.length && initialDestination(business) !== 'Más') primary.push(initialDestination(business))
  return business.role === 'owner' ? primary : [...primary, 'Más']
}

export function businessWorkSections(business: Pick<BusinessContext, 'role' | 'permissions'>): WorkSection[] {
  return workSections.filter(section => {
    switch (section) {
      case 'Venta': return hasPermission(business, 'sales.create') && hasPermission(business, 'catalog.read')
      case 'Comandas': return hasPermission(business, 'orders.read') || hasPermission(business, 'kitchen.read')
      case 'Ventas': return hasPermission(business, 'sales.read_own') || hasPermission(business, 'sales.read_all')
      case 'Productos': return hasPermission(business, 'catalog.read') || hasPermission(business, 'catalog.manage') || hasPermission(business, 'catalog.availability')
    }
  })
}
