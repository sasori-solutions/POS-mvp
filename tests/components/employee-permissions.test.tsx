// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import EmployeeRoleFields from '../../src/components/EmployeeRoleFields'
import type { BusinessPermission } from '../../src/lib/contracts'

afterEach(cleanup)
function Permissions({disabled=false}:{disabled?:boolean}) {
  const [permissions,setPermissions] = useState<BusinessPermission[]>([])
  return <EmployeeRoleFields permissions={permissions} onChange={setPermissions} disabled={disabled}/>
}

test('offers grouped action checkboxes and keeps required reading permissions in sync', () => {
  render(<Permissions />)
  expect(screen.queryAllByRole('radio')).toHaveLength(0)
  expect(screen.getAllByRole('checkbox')).toHaveLength(18)
  const manage = screen.getByRole('checkbox',{name:'Crear y editar productos'}) as HTMLInputElement
  const read = screen.getByRole('checkbox',{name:'Consultar productos'}) as HTMLInputElement
  fireEvent.click(manage)
  expect(manage.checked).toBe(true)
  expect(read.checked).toBe(true)
  fireEvent.click(read)
  expect(read.checked).toBe(false)
  expect(manage.checked).toBe(false)
  fireEvent.click(screen.getByRole('checkbox',{name:'Aplicar descuentos'}))
  expect((screen.getByRole('checkbox',{name:'Cobrar ventas'}) as HTMLInputElement).checked).toBe(true)
  expect(read.checked).toBe(true)
  fireEvent.click(read)
  expect((screen.getByRole('checkbox',{name:'Aplicar descuentos'}) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('checkbox',{name:'Cobrar ventas'}) as HTMLInputElement).checked).toBe(false)
})
