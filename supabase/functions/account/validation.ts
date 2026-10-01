import type { AccountRequest, BusinessProfile, BusinessType, EmployeeRole, PaymentMethod } from '../../../src/lib/contracts.ts'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const pinPattern = /^[0-9]{6}$/
const tokenPattern = /^[0-9a-f]{64}$/
export class RequestValidationError extends Error {
  constructor() { super('The request is invalid.'); this.name = 'RequestValidationError' }
}
function invalid(): never { throw new RequestValidationError() }
export function isUuid(value: unknown): value is string { return typeof value === 'string' && uuidPattern.test(value) }
function exactKeys(input: Record<string, unknown>, keys: string[], optional: string[] = []) {
  if (keys.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !keys.includes(key) && !optional.includes(key))) invalid()
}
function uuid(input: Record<string, unknown>, key: string) { if (!isUuid(input[key])) invalid(); return input[key] as string }
function pin(input: Record<string, unknown>) { if (typeof input.pin !== 'string' || !pinPattern.test(input.pin)) invalid(); return input.pin }
function token(input: Record<string, unknown>, key: string) { if (typeof input[key] !== 'string' || !tokenPattern.test(input[key])) invalid(); return input[key] as string }
function name(value: unknown, min = 2, max = 100) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid()
  const result = value.trim().replace(/\s+/g, ' ')
  if (Array.from(result).length < min || Array.from(result).length > max) invalid()
  return result
}
function role(input: Record<string, unknown>): EmployeeRole { if (!['manager', 'cashier', 'kitchen'].includes(input.role as string)) invalid(); return input.role as EmployeeRole }
function businessDetails(input: Record<string, unknown>) {
  if (!['cafe', 'restaurant', 'other'].includes(input.businessType as string)) invalid()
  if (typeof input.timezone !== 'string' || input.timezone.length > 100 || !/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(input.timezone)) invalid()
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format() } catch { invalid() }
  return { name: name(input.name), businessType: input.businessType as BusinessType, timezone: input.timezone }
}
function profile(value: unknown): BusinessProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  exactKeys(input, ['branchName', 'registerName', 'address', 'city', 'state', 'contactPhone', 'paymentMethods'])
  if (!Array.isArray(input.paymentMethods) || input.paymentMethods.length < 1 || input.paymentMethods.length > 3 || new Set(input.paymentMethods).size !== input.paymentMethods.length || input.paymentMethods.some((value) => !['cash', 'card_external', 'transfer'].includes(value))) invalid()
  const contactPhone = name(input.contactPhone, 0, 30)
  if (contactPhone && !/^[+0-9() -]{5,30}$/.test(contactPhone)) invalid()
  return { branchName: name(input.branchName, 1), registerName: name(input.registerName, 1), address: name(input.address, 0, 300), city: name(input.city, 0), state: name(input.state, 0), contactPhone, paymentMethods: input.paymentMethods as PaymentMethod[] }
}
export function parseAccountRequest(value: unknown): AccountRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  const owner = ['action', 'businessId', 'operatorToken']
  const ownerArgs = () => ({ businessId: uuid(input, 'businessId'), operatorToken: token(input, 'operatorToken') })
  switch (input.action) {
    case 'status': case 'revoke_sessions': exactKeys(input, ['action']); return { action: input.action }
    case 'create_business':
      exactKeys(input, ['action', 'name', 'businessType', 'timezone', 'operationId', 'pin'], ['profile'])
      return { action: input.action, ...businessDetails(input), operationId: uuid(input, 'operationId'), pin: pin(input), ...(Object.hasOwn(input, 'profile') ? { profile: profile(input.profile) } : {}) }
    case 'update_business':
      exactKeys(input, [...owner, 'name', 'businessType', 'timezone', 'profile']); return { action: input.action, ...ownerArgs(), ...businessDetails(input), profile: profile(input.profile) }
    case 'unlock': case 'reset_pin':
      exactKeys(input, ['action', 'businessId', 'pin']); return { action: input.action, businessId: uuid(input, 'businessId'), pin: pin(input) }
    case 'context': case 'lock': case 'team':
      exactKeys(input, owner); return { action: input.action, ...ownerArgs() }
    case 'create_employee':
      exactKeys(input, [...owner, 'name', 'role', 'pin', 'operationId'], ['inviteWithGoogle'])
      if (Object.hasOwn(input, 'inviteWithGoogle') && typeof input.inviteWithGoogle !== 'boolean') invalid()
      if (input.inviteWithGoogle === true && input.pin !== null) invalid()
      return { action: input.action, ...ownerArgs(), name: name(input.name), role: role(input), pin: input.inviteWithGoogle === true ? null : pin(input), operationId: uuid(input, 'operationId'), ...(Object.hasOwn(input, 'inviteWithGoogle') ? { inviteWithGoogle: input.inviteWithGoogle as boolean } : {}) }
    case 'update_employee':
      exactKeys(input, [...owner, 'employeeId', 'name', 'role', 'active', 'pin']); if (typeof input.active !== 'boolean') invalid()
      return { action: input.action, ...ownerArgs(), employeeId: uuid(input, 'employeeId'), name: name(input.name), role: role(input), active: input.active, pin: input.pin === null ? null : pin(input) }
    case 'delete_employee': case 'restore_employee':
      exactKeys(input, [...owner, 'employeeId', 'operationId']); return { action: input.action, ...ownerArgs(), employeeId: uuid(input, 'employeeId'), operationId: uuid(input, 'operationId') }
    case 'create_invitation':
      if (Object.hasOwn(input, 'employeeId')) {
        exactKeys(input, [...owner, 'employeeId', 'operationId'])
        return { action: input.action, ...ownerArgs(), employeeId: uuid(input, 'employeeId'), operationId: uuid(input, 'operationId') }
      }
      exactKeys(input, [...owner, 'name', 'role', 'operationId']); return { action: input.action, ...ownerArgs(), name: name(input.name), role: role(input), operationId: uuid(input, 'operationId') }
    case 'revoke_invitation':
      exactKeys(input, [...owner, 'invitationId']); return { action: input.action, ...ownerArgs(), invitationId: uuid(input, 'invitationId') }
    case 'accept_invitation':
      exactKeys(input, ['action', 'invitationCode', 'pin', 'operationId'], ['name']); return { action: input.action, invitationCode: token(input, 'invitationCode'), ...(Object.hasOwn(input, 'name') ? { name: name(input.name) } : {}), pin: pin(input), operationId: uuid(input, 'operationId') }
    case 'create_pairing_code':
      exactKeys(input, [...owner, 'operationId']); return { action: input.action, ...ownerArgs(), operationId: uuid(input, 'operationId') }
    case 'revoke_device':
      exactKeys(input, [...owner, 'deviceId']); return { action: input.action, ...ownerArgs(), deviceId: uuid(input, 'deviceId') }
    case 'device_pair':
      exactKeys(input, ['action', 'pairingCode', 'deviceName', 'operationId']); return { action: input.action, pairingCode: token(input, 'pairingCode'), deviceName: name(input.deviceName), operationId: uuid(input, 'operationId') }
    case 'device_status': case 'device_forget':
      exactKeys(input, ['action', 'deviceToken']); return { action: input.action, deviceToken: token(input, 'deviceToken') }
    case 'device_unlock':
      exactKeys(input, ['action', 'deviceToken', 'employeeId', 'pin']); return { action: input.action, deviceToken: token(input, 'deviceToken'), employeeId: uuid(input, 'employeeId'), pin: pin(input) }
    case 'device_context': case 'device_lock':
      exactKeys(input, ['action', 'deviceToken', 'operatorToken']); return { action: input.action, deviceToken: token(input, 'deviceToken'), operatorToken: token(input, 'operatorToken') }
    default: return invalid()
  }
}
