import type { AccountRequest, BusinessType } from '../../../src/lib/contracts.ts'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const pinPattern = /^[0-9]{6}$/
const tokenPattern = /^[0-9a-f]{64}$/

export class RequestValidationError extends Error {
  constructor() {
    super('The request is invalid.')
    this.name = 'RequestValidationError'
  }
}

function invalid(): never {
  throw new RequestValidationError()
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

function exactKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) invalid()
}

function businessId(input: Record<string, unknown>): string {
  if (!isUuid(input.businessId)) invalid()
  return input.businessId
}

function pin(input: Record<string, unknown>): string {
  if (typeof input.pin !== 'string' || !pinPattern.test(input.pin)) invalid()
  return input.pin
}

function operatorToken(input: Record<string, unknown>): string {
  if (typeof input.operatorToken !== 'string' || !tokenPattern.test(input.operatorToken)) invalid()
  return input.operatorToken
}

export function parseAccountRequest(value: unknown): AccountRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const input = value as Record<string, unknown>
  switch (input.action) {
    case 'status':
    case 'revoke_sessions':
      exactKeys(input, ['action'])
      return { action: input.action }
    case 'create_business': {
      exactKeys(input, ['action', 'name', 'businessType', 'timezone', 'operationId', 'pin'])
      if (typeof input.name !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.name)) invalid()
      const name = input.name.trim().replace(/\s+/g, ' ')
      if (Array.from(name).length < 2 || Array.from(name).length > 100) invalid()
      if (!['cafe', 'restaurant', 'other'].includes(input.businessType as string)) invalid()
      if (!isUuid(input.operationId)) invalid()
      if (typeof input.timezone !== 'string' || input.timezone.length > 100 || !/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(input.timezone)) invalid()
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format()
      } catch {
        invalid()
      }
      return {
        action: 'create_business', name,
        businessType: input.businessType as BusinessType,
        timezone: input.timezone, operationId: input.operationId, pin: pin(input),
      }
    }
    case 'unlock':
      exactKeys(input, ['action', 'businessId', 'pin'])
      return { action: 'unlock', businessId: businessId(input), pin: pin(input) }
    case 'context':
    case 'lock':
      exactKeys(input, ['action', 'businessId', 'operatorToken'])
      return { action: input.action, businessId: businessId(input), operatorToken: operatorToken(input) }
    default:
      return invalid()
  }
}
