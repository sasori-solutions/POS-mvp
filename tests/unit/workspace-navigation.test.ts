import { expect, test } from 'vitest'
import { availableDestinations, initialDestination, primaryDestinations } from '../../src/lib/navigation'
import type { BusinessContext } from '../../src/lib/contracts'

test('the protected owner enters management and can use the same operational workspace', () => {
  expect(initialDestination({ role: 'owner' })).toBe('Inicio')
  expect(primaryDestinations({ role: 'owner' }, false)).toEqual(['Inicio', 'Ventas', 'Productos', 'Reportes', 'Más'])
  expect(primaryDestinations({ role: 'owner' }, true)).toEqual(['Venta', 'Comandas', 'Ventas', 'Más'])
})

test.each([
  [['catalog.read', 'sales.create', 'sales.read_own'], 'Venta', ['Venta', 'Ventas', 'Más']],
  [['kitchen.read', 'kitchen.operate'], 'Comandas', ['Comandas', 'Más']],
  [['kitchen.read'], 'Comandas', ['Comandas', 'Más']],
  [['catalog.read'], 'Productos', ['Productos', 'Más']],
  [['cash.read'], 'Caja', ['Caja', 'Más']],
  [['reports.read'], 'Reportes', ['Reportes', 'Más']],
  [[], 'Más', ['Más']],
] as const)('employee grants %j choose %s without management access', (permissions, first, primary) => {
  const employee = { role: 'cashier', permissions: [...permissions] } as Pick<BusinessContext, 'role' | 'permissions'>
  expect(initialDestination(employee)).toBe(first)
  expect(primaryDestinations(employee, true)).toEqual(primary)
  expect(availableDestinations(employee)).not.toContain('Inicio')
})

test('role titles never grant access and previously granted special modules remain reachable', () => {
  expect(initialDestination({ role: 'manager' })).toBe('Más')
  expect(availableDestinations({ role: 'cashier', permissions: ['catalog.read', 'sales.create', 'cash.read', 'reports.read'] })).toEqual(['Venta', 'Productos', 'Caja', 'Reportes', 'Más'])
})
