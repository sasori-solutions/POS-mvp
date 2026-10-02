import type { BusinessRole } from './contracts'

export type WorkSection = 'Venta' | 'Comandas' | 'Ventas' | 'Productos'

export const workSections: readonly WorkSection[] = ['Venta', 'Comandas', 'Ventas', 'Productos']

export const roleSections: Record<BusinessRole, readonly WorkSection[]> = {
  owner: workSections,
  manager: workSections,
  cashier: ['Venta', 'Comandas', 'Ventas', 'Productos'],
  kitchen: ['Comandas'],
}
