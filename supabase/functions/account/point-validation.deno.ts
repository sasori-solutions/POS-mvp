import { parseAccountRequest, RequestValidationError } from './validation.ts'
const access = { action: 'point', businessId: '00000000-0000-4000-8000-000000000001', operatorToken: 'a'.repeat(64) }
Deno.test('Point commands reject injected identity, credentials, remote facts and unbounded report dates', () => {
  for (const input of [
    { ...access, command: 'settings', userId: access.businessId },
    { ...access, command: 'settings', refreshToken: 'secret' },
    { ...access, command: 'approve', confirmed: true },
    { ...access, command: 'merchant_report', from: '2026-02-30', to: '2026-03-01' },
  ]) {
    let rejected = false
    try { parseAccountRequest(input) } catch (error) { rejected = error instanceof RequestValidationError }
    if (!rejected) throw new Error('Trust boundary accepted invalid input')
  }
  if (parseAccountRequest({ ...access, command: 'recover' }).action !== 'point') throw new Error('Valid recovery rejected')
})
