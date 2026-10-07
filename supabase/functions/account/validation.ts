import { businessPermissions, permissionPrerequisites, type AccountRequest, type BusinessPermission, type BusinessProfile, type BusinessType, type EmployeeRole, type PaymentMethod } from '../../../src/lib/contracts.ts'
import { parsePosCommand } from './pos-validation.ts'
import { parsePointCommand } from './point-validation.ts'
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
function pin(input: Record<string, unknown>, key = 'pin') { if (typeof input[key] !== 'string' || !pinPattern.test(input[key])) invalid(); return input[key] as string }
function token(input: Record<string, unknown>, key: string) { if (typeof input[key] !== 'string' || !tokenPattern.test(input[key])) invalid(); return input[key] as string }
function name(value: unknown, min = 2, max = 100) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid()
  const result = value.trim().replace(/\s+/g, ' ')
  if (Array.from(result).length < min || Array.from(result).length > max) invalid()
  return result
}
function role(input: Record<string, unknown>): EmployeeRole { if (!['manager', 'cashier', 'kitchen'].includes(input.role as string)) invalid(); return input.role as EmployeeRole }
function permissions(input: Record<string, unknown>): { permissions?: BusinessPermission[] } {
  if (!Object.hasOwn(input, 'permissions')) return {}
  const values = input.permissions
  if (!Array.isArray(values) || values.length > businessPermissions.length || new Set(values).size !== values.length || values.some(value => !businessPermissions.includes(value))) invalid()
  if (values.some(value => permissionPrerequisites[value as BusinessPermission] && !values.includes(permissionPrerequisites[value as BusinessPermission]))) invalid()
  return { permissions: businessPermissions.filter(value => values.includes(value)) }
}
function businessDetails(input: Record<string, unknown>) {
  if (!['cafe', 'restaurant', 'other'].includes(input.businessType as string)) invalid()
  if (typeof input.timezone !== 'string' || input.timezone.length > 100 || !/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(input.timezone)) invalid()
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format() } catch { invalid() }
  return { name: name(input.name), businessType: input.businessType as BusinessType, timezone: input.timezone }
}
function profile(value: unknown): BusinessProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  exactKeys(input, ['branchName', 'registerName', 'address', 'city', 'state', 'contactPhone', 'paymentMethods'], ['accountsEnabled', 'defaultVatTreatment', 'logoImageId', 'transferAccount'])
  if (!Array.isArray(input.paymentMethods) || input.paymentMethods.length < 1 || input.paymentMethods.length > 4 || new Set(input.paymentMethods).size !== input.paymentMethods.length || input.paymentMethods.some((value) => !['cash', 'card_external', 'transfer', 'card_integrated'].includes(value))) invalid()
  const contactPhone = name(input.contactPhone, 0, 30)
  if (contactPhone && !/^[+0-9() -]{5,30}$/.test(contactPhone)) invalid()
  if (Object.hasOwn(input, 'accountsEnabled') && typeof input.accountsEnabled !== 'boolean') invalid()
  if (Object.hasOwn(input, 'defaultVatTreatment') && !['vat_16', 'vat_0', 'exempt', 'border_8', 'unconfigured'].includes(input.defaultVatTreatment as string)) invalid()
  if (Object.hasOwn(input, 'logoImageId') && input.logoImageId !== null && !isUuid(input.logoImageId)) invalid()
  let transferAccount: BusinessProfile['transferAccount']
  if (Object.hasOwn(input, 'transferAccount')) {
    if (input.transferAccount === null) transferAccount = null
    else {
      if (!input.transferAccount || typeof input.transferAccount !== 'object' || Array.isArray(input.transferAccount)) invalid()
      const account = input.transferAccount as Record<string, unknown>
      exactKeys(account, ['beneficiary', 'bank', 'clabe'])
      if (typeof account.clabe !== 'string' || !/^[0-9]{18}$/.test(account.clabe)) invalid()
      const sum = Array.from(account.clabe.slice(0, 17)).reduce((total, digit, index) => total + (Number(digit) * [3, 7, 1][index % 3]) % 10, 0)
      if ((10 - sum % 10) % 10 !== Number(account.clabe[17])) invalid()
      transferAccount = { beneficiary: name(account.beneficiary, 1), bank: name(account.bank, 1), clabe: account.clabe }
    }
  }
  return { ...(Object.hasOwn(input, 'accountsEnabled') ? { accountsEnabled: input.accountsEnabled as boolean } : {}),
    ...(Object.hasOwn(input, 'defaultVatTreatment') ? { defaultVatTreatment: input.defaultVatTreatment as BusinessProfile['defaultVatTreatment'] } : {}),
    ...(Object.hasOwn(input, 'logoImageId') ? { logoImageId: input.logoImageId as string | null } : {}),
    ...(Object.hasOwn(input, 'transferAccount') ? { transferAccount } : {}),
    branchName: name(input.branchName, 1), registerName: name(input.registerName, 1), address: name(input.address, 0, 300), city: name(input.city, 0), state: name(input.state, 0), contactPhone, paymentMethods: input.paymentMethods as PaymentMethod[] }
}
export function parseAccountRequest(value: unknown): AccountRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  const owner = ['action', 'businessId', 'operatorToken']
  const ownerArgs = () => ({ businessId: uuid(input, 'businessId'), operatorToken: token(input, 'operatorToken') })
  switch (input.action) {
    case 'point':
      return { action: 'point', ...ownerArgs(), ...parsePointCommand(input, owner) }
    case 'device_point':
      return { action: 'device_point', deviceToken: token(input, 'deviceToken'), operatorToken: token(input, 'operatorToken'),
        ...parsePointCommand(input, ['action', 'deviceToken', 'operatorToken']) }
    case 'pos':
      return { action: 'pos', ...ownerArgs(), ...parsePosCommand(input, owner) }
    case 'device_pos':
      return { action: 'device_pos', deviceToken: token(input, 'deviceToken'), operatorToken: token(input, 'operatorToken'),
        ...parsePosCommand(input, ['action', 'deviceToken', 'operatorToken']) }
    case 'status': case 'revoke_sessions': exactKeys(input, ['action']); return { action: input.action }
    case 'create_business':
      exactKeys(input, ['action', 'name', 'businessType', 'timezone', 'operationId', 'pin'], ['profile'])
      return { action: input.action, ...businessDetails(input), operationId: uuid(input, 'operationId'), pin: pin(input), ...(Object.hasOwn(input, 'profile') ? { profile: profile(input.profile) } : {}) }
    case 'upload_profile_image': {
      exactKeys(input, [...owner, 'subject', 'imageId', 'operationId', 'part', 'parts', 'data'])
      if (input.subject !== 'business' && input.subject !== 'account') invalid()
      if (!Number.isSafeInteger(input.part) || !Number.isSafeInteger(input.parts) || (input.parts as number) < 1 || (input.parts as number) > 60 || (input.part as number) < 0 || (input.part as number) >= (input.parts as number)) invalid()
      if (typeof input.data !== 'string' || input.data.length < 4 || input.data.length > 4096 || input.data.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)
        || ((input.part as number) < (input.parts as number) - 1 && (input.data.length !== 4096 || input.data.includes('=')))) invalid()
      return { action: input.action, ...ownerArgs(), subject: input.subject, imageId: uuid(input, 'imageId'), operationId: uuid(input, 'operationId'), part: input.part as number, parts: input.parts as number, data: input.data }
    }
    case 'remove_profile_image':
      exactKeys(input, [...owner, 'subject', 'operationId']); if (input.subject !== 'business' && input.subject !== 'account') invalid()
      return { action: input.action, ...ownerArgs(), subject: input.subject, operationId: uuid(input, 'operationId') }
    case 'update_business':
      exactKeys(input, [...owner, 'name', 'businessType', 'timezone', 'profile']); return { action: input.action, ...ownerArgs(), ...businessDetails(input), profile: profile(input.profile) }
    case 'unlock':
      exactKeys(input, ['action', 'businessId', 'pin'], ['deviceName']); return { action: input.action, businessId: uuid(input, 'businessId'), pin: pin(input), ...(Object.hasOwn(input, 'deviceName') ? { deviceName: name(input.deviceName) } : {}) }
    case 'context': case 'lock': case 'team': case 'notifications':
      exactKeys(input, owner); return { action: input.action, ...ownerArgs() }
    case 'mark_notification_read':
      exactKeys(input, [...owner, 'notificationId']); return { action: input.action, ...ownerArgs(), notificationId: uuid(input, 'notificationId') }
    case 'review_employee_device':
      exactKeys(input, [...owner, 'notificationId', 'decision']); if (input.decision !== 'approve' && input.decision !== 'reject') invalid(); return { action: input.action, ...ownerArgs(), notificationId: uuid(input, 'notificationId'), decision: input.decision }
    case 'create_employee':
      exactKeys(input, [...owner, 'name', 'role', 'pin', 'operationId'], ['inviteWithGoogle', 'permissions'])
      if (Object.hasOwn(input, 'inviteWithGoogle') && typeof input.inviteWithGoogle !== 'boolean') invalid()
      if (input.pin !== null) invalid()
      return { action: input.action, ...ownerArgs(), name: name(input.name), role: role(input), ...permissions(input), pin: null, operationId: uuid(input, 'operationId'), ...(Object.hasOwn(input, 'inviteWithGoogle') ? { inviteWithGoogle: input.inviteWithGoogle as boolean } : {}) }
    case 'update_employee':
      exactKeys(input, [...owner, 'employeeId', 'name', 'role', 'active', 'pin'], ['permissions']); if (typeof input.active !== 'boolean' || input.pin !== null) invalid()
      return { action: input.action, ...ownerArgs(), employeeId: uuid(input, 'employeeId'), name: name(input.name), role: role(input), ...permissions(input), active: input.active, pin: null }
    case 'create_pin_setup':
      exactKeys(input, [...owner, 'employeeId', 'operationId']); return { action: input.action, ...ownerArgs(), employeeId: uuid(input, 'employeeId'), operationId: uuid(input, 'operationId') }
    case 'employee_pin_setup_details':
      exactKeys(input, ['action', 'setupCode']); return { action: input.action, setupCode: token(input, 'setupCode') }
    case 'set_employee_pin':
      exactKeys(input, ['action', 'setupCode', 'pin', 'operationId']); return { action: input.action, setupCode: token(input, 'setupCode'), pin: pin(input), operationId: uuid(input, 'operationId') }
    case 'delete_employee':
      exactKeys(input, [...owner, 'employeeId', 'operationId']); return { action: input.action, ...ownerArgs(), employeeId: uuid(input, 'employeeId'), operationId: uuid(input, 'operationId') }
    case 'create_invitation':
      if (Object.hasOwn(input, 'employeeId')) {
        exactKeys(input, [...owner, 'employeeId', 'operationId'])
        return { action: input.action, ...ownerArgs(), employeeId: uuid(input, 'employeeId'), operationId: uuid(input, 'operationId') }
      }
      exactKeys(input, [...owner, 'name', 'role', 'operationId'], ['permissions']); return { action: input.action, ...ownerArgs(), name: name(input.name), role: role(input), ...permissions(input), operationId: uuid(input, 'operationId') }
    case 'revoke_invitation':
      exactKeys(input, [...owner, 'invitationId']); return { action: input.action, ...ownerArgs(), invitationId: uuid(input, 'invitationId') }
    case 'accept_invitation':
      exactKeys(input, ['action', 'invitationCode', 'pin', 'operationId'], ['name', 'deviceName']); return { action: input.action, invitationCode: token(input, 'invitationCode'), ...(Object.hasOwn(input, 'deviceName') ? { deviceName: name(input.deviceName) } : {}), ...(Object.hasOwn(input, 'name') ? { name: name(input.name) } : {}), pin: pin(input), operationId: uuid(input, 'operationId') }
    case 'invitation_details':
      exactKeys(input, ['action', 'invitationCode']); return { action: input.action, invitationCode: token(input, 'invitationCode') }
    case 'device_request_pin_email':
      exactKeys(input, ['action', 'deviceToken', 'employeeId']); return { action: input.action, deviceToken: token(input, 'deviceToken'), employeeId: uuid(input, 'employeeId') }
    case 'request_pin_email':
      exactKeys(input, ['action', 'businessId']); return { action: input.action, businessId: uuid(input, 'businessId') }
    case 'pin_email_details':
      exactKeys(input, ['action', 'recoveryToken']); return { action: input.action, recoveryToken: token(input, 'recoveryToken') }
    case 'confirm_pin_email':
      exactKeys(input, ['action', 'recoveryToken', 'pin', 'operationId']); return { action: input.action, recoveryToken: token(input, 'recoveryToken'), pin: pin(input), operationId: uuid(input, 'operationId') }
    case 'change_pin':
      exactKeys(input, [...owner, 'currentPin', 'pin', 'operationId']); return { action: input.action, ...ownerArgs(), currentPin: pin(input, 'currentPin'), pin: pin(input), operationId: uuid(input, 'operationId') }
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
    case 'device_pin_setup_details':
      exactKeys(input, ['action', 'deviceToken', 'setupCode']); return { action: input.action, deviceToken: token(input, 'deviceToken'), setupCode: token(input, 'setupCode') }
    case 'device_set_employee_pin':
      exactKeys(input, ['action', 'deviceToken', 'setupCode', 'pin', 'operationId']); return { action: input.action, deviceToken: token(input, 'deviceToken'), setupCode: token(input, 'setupCode'), pin: pin(input), operationId: uuid(input, 'operationId') }
    case 'device_context': case 'device_lock':
      exactKeys(input, ['action', 'deviceToken', 'operatorToken']); return { action: input.action, deviceToken: token(input, 'deviceToken'), operatorToken: token(input, 'operatorToken') }
    default: return invalid()
  }
}
