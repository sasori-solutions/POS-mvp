// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import BusinessSettings from '../../src/components/BusinessSettings'
import { accountRequest } from '../../src/lib/account'
import type { BusinessContext } from '../../src/lib/contracts'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn() }))
vi.mock('../../src/components/usePoint', () => ({
  usePoint: () => ({ settings: null, loading: false, error: '', refresh: vi.fn(), setSettings: vi.fn() }),
}))

const operatorToken = 'a'.repeat(64)
const business: BusinessContext = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Café sintético', businessType: 'cafe', role: 'owner',
  timezone: 'America/Mexico_City', currency: 'MXN', createdAt: '2026-10-05T12:00:00Z',
  profile: {
    branchName: 'Sucursal', registerName: 'Caja', address: '', city: '', state: '', contactPhone: '',
    paymentMethods: ['cash'], accountsEnabled: false, defaultVatTreatment: 'vat_16',
  },
}

beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)

test.each([
  { enabled: true, selected: /^Cuentas abiertas/, other: /^Cobro directo/ },
  { enabled: false, selected: /^Cobro directo/, other: /^Cuentas abiertas/ },
])('settings persist and reload accountsEnabled=$enabled only after saving', async ({ enabled, selected, other }) => {
  const initial = { ...business, profile: { ...business.profile, accountsEnabled: !enabled } }
  const saved = vi.fn()
  vi.mocked(accountRequest).mockImplementation(async request => {
    const parsed = parseAccountRequest(request)
    if (parsed.action !== 'update_business') throw new Error('Unexpected request')
    return { ...initial, profile: parsed.profile } as never
  })
  const view = render(<BusinessSettings business={initial} operatorToken={operatorToken} onSaved={saved} onBack={vi.fn()} />)

  expect((screen.getByRole('radio', { name: other }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText('Cobra primero; el pago genera la comanda.')).toBeTruthy()
  expect(screen.getByText('Guarda y modifica la cuenta, envía comandas y cobra al final.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Guardar cambios' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: selected }))
  expect(accountRequest).not.toHaveBeenCalled()
  expect(saved).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(accountRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    action: 'update_business', businessId: business.id, operatorToken,
    profile: expect.objectContaining({ accountsEnabled: enabled }),
  }))
  const persisted = saved.mock.calls[0][0] as BusinessContext
  expect(persisted.profile.accountsEnabled).toBe(enabled)
  expect(screen.getByRole('status').textContent).toBe('Cambios guardados.')

  view.unmount()
  render(<BusinessSettings business={persisted} operatorToken={operatorToken} onSaved={saved} onBack={vi.fn()} />)
  expect((screen.getByRole('radio', { name: selected }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('radio', { name: other }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('button', { name: 'Guardar cambios' }) as HTMLButtonElement).disabled).toBe(true)
  expect(accountRequest).toHaveBeenCalledOnce()
})
