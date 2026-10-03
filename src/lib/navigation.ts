import type { BusinessContext } from './contracts'
import { hasPermission } from './business-access'

export type WorkSection = 'Venta' | 'Comandas' | 'Ventas' | 'Productos'

export const workSections: readonly WorkSection[] = ['Venta', 'Comandas', 'Ventas', 'Productos']

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
