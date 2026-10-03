import { describe, expect, it } from 'vitest'
import { hasPermission } from '../../src/lib/business-access'
import { businessWorkSections } from '../../src/lib/navigation'
import { businessPermissions, type BusinessRole } from '../../src/lib/contracts'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

const owner = {businessId:'b568bbbc-e25b-4dd2-9cae-be28cdbf3244',operatorToken:'ab'.repeat(32)}
const creation = {action:'create_employee',...owner,name:'Persona sintética',role:'cashier',pin:null,operationId:'a17c73f3-8f01-4419-bce9-e39536422910'}

describe('employee grant contracts and navigation', () => {
  it('has no employee role fallback and gives the protected owner every known operation', () => {
    for (const role of ['manager','cashier','kitchen'] as BusinessRole[]) {
      for (const permission of businessPermissions) expect(hasPermission({role},permission)).toBe(false)
      expect(businessWorkSections({role})).toEqual([])
    }
    for (const permission of businessPermissions) expect(hasPermission({role:'owner'},permission)).toBe(true)
    expect(businessWorkSections({role:'owner'})).toEqual(['Venta','Comandas','Ventas','Productos'])
    expect(businessWorkSections({role:'cashier',permissions:['kitchen.read']})).toEqual(['Comandas'])
    expect(businessWorkSections({role:'manager',permissions:['catalog.read','sales.create','sales.read_own']})).toEqual(['Venta','Ventas','Productos'])
  })
  it('canonicalizes only exact known keys and rejects duplicate or forged grant payloads', () => {
    expect(parseAccountRequest({...creation,permissions:['sales.create','catalog.read']})).toHaveProperty('permissions',['catalog.read','sales.create'])
    expect(parseAccountRequest({...creation,permissions:[]})).toHaveProperty('permissions',[])
    expect(parseAccountRequest(creation)).not.toHaveProperty('permissions')
    for (const permissions of [null,{},'catalog.read',['owner'],['catalog.read','catalog.read'],['CATALOG.READ'],['catalog.read',null],['catalog.manage'],['sales.discount','sales.create'],['cash.open'],['orders.cancel'],['kitchen.operate']]) expect(() => parseAccountRequest({...creation,permissions})).toThrow()
    expect(() => parseAccountRequest({...creation,role:'owner',permissions:businessPermissions})).toThrow()
    expect(() => parseAccountRequest({action:'create_invitation',...owner,employeeId:owner.businessId,operationId:creation.operationId,permissions:[]})).toThrow()
    const update = {action:'update_employee',...owner,employeeId:owner.businessId,name:creation.name,role:'cashier',active:true,pin:null,permissions:['orders.read']}
    expect(parseAccountRequest(update)).toEqual(update)
  })
})
