import { businessPermissions, type BusinessContext, type BusinessPermission, type BusinessRole, type BusinessSummary } from './contracts'

export const employeeEntryKey = 'pos-mexico-employee-entry'
export const roleLabels: Record<BusinessRole, string> = {
  owner: 'Dueño', manager: 'Empleado', cashier: 'Empleado', kitchen: 'Empleado',
}

/** Legacy staff roles describe identities; they never substitute for live grants. */
export function hasPermission(business: Pick<BusinessContext, 'role' | 'permissions'>, permission: BusinessPermission) {
  return businessPermissions.includes(permission) && (business.role === 'owner' || business.permissions?.includes(permission) === true)
}

// A remembered ID selects a PIN screen only after live membership validation.
export function rememberBusiness(userId: string, businessId: string) {
  try { localStorage.setItem(`pos-mexico-last-business:${userId}`, businessId) }
  catch { /* Business selection remains usable without browser storage. */ }
}

export function preferredBusiness(businesses: BusinessSummary[], userId: string, employeeEntry: boolean) {
  let remembered: string | null = null
  try { remembered = localStorage.getItem(`pos-mexico-last-business:${userId}`) }
  catch { /* Use the current membership list. */ }
  const eligible = employeeEntry
    ? businesses.filter(business => business.role && business.role !== 'owner')
    : businesses
  const previous = eligible.find(business => business.id === remembered)
  return previous ?? (eligible.length === 1 ? eligible[0] : null)
}

export function invitationFromLink(value: string, origin = window.location.origin) {
  try {
    const url = new URL(value.trim())
    const code = new URLSearchParams(url.hash.slice(1)).get('invite')
    return url.origin === origin && code && /^[a-f0-9]{64}$/i.test(code) ? code : null
  } catch { return null }
}
