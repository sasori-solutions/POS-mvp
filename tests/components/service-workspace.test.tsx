// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import ServiceWorkspace from '../../src/features/operations/ServiceWorkspace'
import OrderEditor from '../../src/features/operations/OrderEditor'
import TransferConfirmation from '../../src/components/TransferConfirmation'
import type { BusinessContext } from '../../src/lib/contracts'
import type { DiningTable, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { Product } from '../../src/lib/pos-contracts'

const business: BusinessContext = { id: '00000000-0000-4000-a000-000000000001', name: 'Restaurante sintético', businessType: 'restaurant', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-07T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'], accountsEnabled: true } }
const table: DiningTable = { id: '00000000-0000-4000-a000-000000000002', name: 'Terraza 1', active: true, revision: 3, orderId: null, layout: { zone: 'Terraza', row: 2, column: 3, seats: 4, shape: 'round' } }
const product: Product = { id: '00000000-0000-4000-a000-000000000003', name: 'Café sintético', category: 'Café', priceCents: 4500, version: 1, active: true }
const account: OperationalOrder = { id: '00000000-0000-4000-a000-000000000004', name: 'Visita sintética', tableId: table.id, orderKind: 'service', revision: 2, status: 'open', phase: 'service', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: 'Persona sintética', items: [], discount: null, grossCents: 0, discountCents: 0, totalCents: 0, taxCents: 0, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 0 }
const snapshot: OperationsSnapshot = { enabled: true, shift: null, orders: [], tables: [table], attempts: [] }
function mutation(): OperationalMutation { return { execute: vi.fn().mockResolvedValue(account), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } }
function workspace(changes: Partial<OperationsSnapshot> = {}, override: Partial<BusinessContext> = {}) {
  const props = { business: { ...business, ...override }, snapshot: { ...snapshot, ...changes }, mutation: mutation(), onOrder: vi.fn(), onNew: vi.fn(), onQuickAccount: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) }
  return { ...render(<ServiceWorkspace {...props} />), props }
}
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }; HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') } })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('table service starts without an open cash shift and occupied tables resume the same account', () => {
  const view = workspace()
  fireEvent.click(screen.getByRole('button', { name: /Terraza 1.*Libre/ }))
  expect(view.props.onNew).toHaveBeenCalledExactlyOnceWith(table)
  view.rerender(<ServiceWorkspace {...view.props} snapshot={{ ...snapshot, tables: [{ ...table, orderId: account.id }], orders: [account] }} />)
  fireEvent.click(screen.getByRole('button', { name: /Terraza 1.*Ocupada/ }))
  expect(view.props.onOrder).toHaveBeenCalledExactlyOnceWith(account)
  expect(view.props.onNew).toHaveBeenCalledOnce()
})

test('a table with an unloaded account cannot accidentally open a second account', () => {
  const view = workspace({ tables: [{ ...table, orderId: account.id }] })
  fireEvent.click(screen.getByRole('button', { name: /Terraza 1.*Ocupada/ }))
  expect(screen.getByRole('alert').textContent).toContain('Actualiza antes de continuar')
  expect(view.props.onNew).not.toHaveBeenCalled()
})

test('the first table without a floor position stays usable in cards and plan views', () => {
  const unplaced = { ...table, layout: null }
  const view = workspace({ tables: [] })
  view.rerender(<ServiceWorkspace {...view.props} snapshot={{ ...snapshot, tables: [unplaced] }} />)
  fireEvent.click(screen.getByRole('button', { name: /Terraza 1.*Libre/ }))
  expect(view.props.onNew).toHaveBeenCalledExactlyOnceWith(unplaced)
  fireEvent.click(screen.getByRole('button', { name: 'Plano' }))
  expect(screen.queryByRole('region', { name: /Plano de/ })).toBeNull()
  expect(screen.getByText('Organiza las mesas y guarda su ubicación para ver el plano.')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Terraza 1.*Libre/ })).toBeTruthy()
})

test('a fully paid frozen account awaiting visit release is labelled paid rather than partial', () => {
  workspace({ orders: [{ ...account, tableId: null, frozen: true, paidCents: 3500, balanceCents: 0 }], tables: [] })
  expect(screen.getByRole('button', { name: /Visita sintética.*Pagada · pendiente de cerrar/ })).toBeTruthy()
  expect(screen.queryByText(/Pago parcial/)).toBeNull()
})

test('read access exposes occupied accounts without allowing new accounts or table changes', () => {
  const view = workspace({ tables: [{ ...table, orderId: account.id }], orders: [account] }, { role: 'cashier', permissions: ['orders.read'] })
  expect(screen.queryByRole('button', { name: 'Cuenta sin mesa' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Organizar mesas' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Terraza 1.*Ocupada/ }))
  expect(view.props.onOrder).toHaveBeenCalledExactlyOnceWith(account)
})

test('joined visit tables do not claim the paid representative resolves another account or show its balance as the visit total', () => {
  const visitId = '00000000-0000-4000-a000-000000000020'
  const paidLine = { lineId: '00000000-0000-4000-a000-000000000021', productId: product.id, version: product.version, name: product.name, kitchenName: product.name, category: product.category, selectionLabel: '', note: '', quantity: 1, paidQuantity: 1, sentQuantity: 1, unitPriceCents: 3500, grossCents: 3500, discountCents: 0, totalCents: 3500, taxCents: 483, taxBps: 1600, taxTreatment: 'vat_16' as const }
  const paid: OperationalOrder = { ...account, tableId: null, status: 'paid', frozen: true, items: [paidLine], grossCents: 3500, totalCents: 3500, taxCents: 483, paidCents: 3500 }
  const due: OperationalOrder = { ...account, id: '00000000-0000-4000-a000-000000000022', tableId: null, name: 'Consumo adicional', items: [{ ...paidLine, lineId: '00000000-0000-4000-a000-000000000023', paidQuantity: 0, unitPriceCents: 3600, grossCents: 3600, totalCents: 3600, taxCents: 497 }], grossCents: 3600, totalCents: 3600, taxCents: 497, balanceCents: 3600 }
  const joined = [{ ...table, orderId: paid.id, visitId }, { ...table, id: '00000000-0000-4000-a000-000000000024', name: 'Mesa apoyo', orderId: paid.id, visitId, layout: null }]
  const view = workspace({ tables: joined, orders: [due, paid] }, { role: 'cashier', permissions: ['orders.read'] })
  expect(screen.getByText('2 ocupadas · 0 libres')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Cuentas por nombre' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Cuentas sin mesa' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Organizar mesas' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cuenta sin mesa' })).toBeNull()
  for (const item of joined) {
    const card = screen.getByRole('button', { name: `${item.name}, Ocupada, Ver visita` })
    expect(card.getAttribute('aria-label')).not.toContain('saldo')
    expect(within(card).queryByText('$0.00')).toBeNull()
    expect(within(card).queryByText(/Pagada|Resuelta|cerrar/)).toBeNull()
    expect(within(card).getByText('Ver visita')).toBeTruthy()
    fireEvent.click(card)
  }
  expect(view.props.onOrder).toHaveBeenCalledTimes(2)
  expect(view.props.onOrder).toHaveBeenLastCalledWith(paid)
  expect(view.props.onNew).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Plano' }))
  const planCard = within(screen.getByRole('region', { name: 'Plano de Terraza' })).getByRole('button', { name: `${table.name}, Ocupada, Ver visita` })
  expect(within(planCard).queryByText('$0.00')).toBeNull()
  expect(within(planCard).queryByText(/Pagada|Resuelta|cerrar/)).toBeNull()
})

test.each([undefined, null])('legacy table occupancy keeps its single-account state and balance when visitId is %s', visitId => {
  const paid = { ...account, status: 'paid' as const, frozen: true }
  const view = workspace({ tables: [{ ...table, orderId: paid.id, visitId }], orders: [paid] })
  const card = screen.getByRole('button', { name: `${table.name}, Pagada · cerrar, saldo $0.00` })
  expect(within(card).getByText('$0.00')).toBeTruthy()
  expect(within(card).queryByText('Ver visita')).toBeNull()
  fireEvent.click(card)
  expect(view.props.onOrder).toHaveBeenCalledExactlyOnceWith(paid)
})

test('a visit with an unloaded representative remains occupied and cannot open another account or deactivate its table', () => {
  const view = workspace({ tables: [{ ...table, orderId: null, visitId: '00000000-0000-4000-a000-000000000020' }] })
  expect(screen.getByText('1 ocupadas · 0 libres')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: `${table.name}, Ocupada, Ver visita` }))
  expect(screen.getByRole('alert').textContent).toContain('Actualiza antes de continuar')
  expect(view.props.onNew).not.toHaveBeenCalled()
  expect(view.props.onOrder).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Organizar mesas' }))
  fireEvent.click(screen.getByRole('button', { name: `${table.name}, Ocupada` }))
  const editor = within(screen.getByRole('dialog', { name: 'Editar mesa' }))
  expect((editor.getByRole('checkbox', { name: 'Mesa activa' }) as HTMLInputElement).disabled).toBe(true)
  expect(editor.getByText('Finaliza la visita antes de desactivar esta mesa.')).toBeTruthy()
})

test('floor positioning saves the real table version and location through the persisted mutation', async () => {
  const view = workspace()
  fireEvent.click(screen.getByRole('button', { name: 'Organizar mesas' }))
  fireEvent.click(screen.getByRole('button', { name: 'Plano' }))
  const region = within(screen.getByRole('region', { name: 'Plano de Terraza' }))
  fireEvent.click(region.getByRole('button', { name: /Terraza 1/ }))
  const dialog = within(screen.getByRole('dialog', { name: 'Ubicación de Terraza 1' }))
  fireEvent.change(dialog.getByLabelText('Columna'), { target: { value: '4' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Guardar ubicación' }))
  await waitFor(() => expect(view.props.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'set_table_layout', tableId: table.id, expectedRevision: table.revision, layout: { ...table.layout, column: 4 } })))
  await waitFor(() => expect(view.props.refresh).toHaveBeenCalledOnce())
})

test('a created table can reopen for editing while its previous accepted save stays in the mutation state', async () => {
  const view = workspace({ tables: [] })
  fireEvent.click(screen.getByRole('button', { name: 'Organizar mesas' }))
  fireEvent.click(screen.getByRole('button', { name: 'Añadir mesa' }))
  const create = within(screen.getByRole('dialog', { name: 'Añadir mesa' }))
  fireEvent.change(create.getByLabelText('Nombre de la mesa'), { target: { value: 'Mesa apoyo sintética' } })
  fireEvent.click(create.getByRole('button', { name: 'Guardar mesa' }))
  await waitFor(() => expect(view.props.mutation.execute).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Añadir mesa' })).toBeNull())
  const request = vi.mocked(view.props.mutation.execute).mock.calls[0][0]
  expect(request).toMatchObject({ command: 'save_table', expectedRevision: null, name: 'Mesa apoyo sintética', active: true })
  if (request.command !== 'save_table') throw new Error('Expected the table creation request')
  const saved: DiningTable = { id: request.tableId, name: request.name, active: true, revision: 1, orderId: null, layout: null }
  view.rerender(<ServiceWorkspace {...view.props} snapshot={{ ...snapshot, tables: [saved] }} mutation={{ ...view.props.mutation, lastResult: { command: 'save_table', result: saved } }} />)
  fireEvent.click(screen.getByRole('button', { name: /Mesa apoyo sintética.*Libre/ }))
  const edit = within(screen.getByRole('dialog', { name: 'Editar mesa' }))
  expect((edit.getByLabelText('Nombre de la mesa') as HTMLInputElement).value).toBe(saved.name)
  fireEvent.change(edit.getByLabelText('Nombre de la mesa'), { target: { value: 'Mesa apoyo actualizada' } })
  fireEvent.click(edit.getByRole('button', { name: 'Guardar mesa' }))
  await waitFor(() => expect(view.props.mutation.execute).toHaveBeenCalledTimes(2))
  const update = vi.mocked(view.props.mutation.execute).mock.calls[1][0]
  expect(update).toMatchObject({ command: 'save_table', tableId: saved.id, expectedRevision: saved.revision, name: 'Mesa apoyo actualizada', active: true })
  expect(update.operationId).not.toBe(request.operationId)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar mesa' })).toBeNull())
})

test('a saved table location can reopen in the plan and submit a fresh change at the current revision', async () => {
  const view = workspace()
  fireEvent.click(screen.getByRole('button', { name: 'Organizar mesas' }))
  fireEvent.click(screen.getByRole('button', { name: 'Plano' }))
  fireEvent.click(within(screen.getByRole('region', { name: 'Plano de Terraza' })).getByRole('button', { name: /Terraza 1/ }))
  const first = within(screen.getByRole('dialog', { name: 'Ubicación de Terraza 1' }))
  fireEvent.change(first.getByLabelText('Columna'), { target: { value: '4' } })
  fireEvent.click(first.getByRole('button', { name: 'Guardar ubicación' }))
  await waitFor(() => expect(view.props.mutation.execute).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ubicación de Terraza 1' })).toBeNull())
  const saved: DiningTable = { ...table, revision: table.revision + 1, layout: { ...table.layout!, column: 4 } }
  view.rerender(<ServiceWorkspace {...view.props} snapshot={{ ...snapshot, tables: [saved] }} mutation={{ ...view.props.mutation, lastResult: { command: 'set_table_layout', result: saved } }} />)
  fireEvent.click(within(screen.getByRole('region', { name: 'Plano de Terraza' })).getByRole('button', { name: /Terraza 1/ }))
  const reopened = within(screen.getByRole('dialog', { name: 'Ubicación de Terraza 1' }))
  expect((reopened.getByLabelText('Columna') as HTMLInputElement).value).toBe('4')
  fireEvent.change(reopened.getByLabelText('Columna'), { target: { value: '5' } })
  fireEvent.click(reopened.getByRole('button', { name: 'Guardar ubicación' }))
  await waitFor(() => expect(view.props.mutation.execute).toHaveBeenCalledTimes(2))
  const [firstRequest, secondRequest] = vi.mocked(view.props.mutation.execute).mock.calls.map(call => call[0])
  expect(secondRequest).toMatchObject({ command: 'set_table_layout', tableId: saved.id, expectedRevision: saved.revision, layout: { ...saved.layout, column: 5 } })
  expect(secondRequest.operationId).not.toBe(firstRequest.operationId)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ubicación de Terraza 1' })).toBeNull())
})

test('a fresh accepted retry closes its matching table form while an unrelated result leaves it open', () => {
  const view = workspace()
  fireEvent.click(screen.getByRole('button', { name: 'Organizar mesas' }))
  fireEvent.click(screen.getByRole('button', { name: /Terraza 1.*Libre/ }))
  const pending = { command: 'save_table' as const, operationId: crypto.randomUUID(), tableId: table.id, expectedRevision: table.revision, name: 'Terraza actualizada', active: true }
  view.rerender(<ServiceWorkspace {...view.props} mutation={{ ...view.props.mutation, pending, error: 'No pudimos confirmar la solicitud.' }} />)
  expect((screen.getByRole('button', { name: 'Guardar mesa' }) as HTMLButtonElement).disabled).toBe(true)
  expect(view.props.mutation.execute).not.toHaveBeenCalled()
  view.rerender(<ServiceWorkspace {...view.props} mutation={{ ...view.props.mutation, lastResult: { command: 'save_table', result: { ...table, id: crypto.randomUUID() } } }} />)
  expect(screen.getByRole('dialog', { name: 'Editar mesa' })).toBeTruthy()
  view.rerender(<ServiceWorkspace {...view.props} mutation={{ ...view.props.mutation, lastResult: { command: 'save_table', result: { ...table, name: pending.name, revision: table.revision + 1 } } }} />)
  expect(screen.queryByRole('dialog', { name: 'Editar mesa' })).toBeNull()
})

test('new table accounts carry the table identity and a service order kind before any payment', async () => {
  const request = mutation()
  render(<OrderEditor products={[product]} initialTable={table} tables={[table]} mutation={request} onSaved={vi.fn()} onCancel={vi.fn()} />)
  expect((screen.getByLabelText('Nombre de la cuenta') as HTMLInputElement).value).toBe(table.name)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café sintético, $45.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'save_order', tableId: table.id, orderKind: 'service', name: table.name }), 'service'))
})

test('transfer instructions display configured private data and require an explicit received acknowledgement', async () => {
  const onChange = vi.fn(), copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  render(<TransferConfirmation account={{ beneficiary: 'Comercio sintético', bank: 'Banco sintético', clabe: '002010077777777771' }} checked={false} onChange={onChange} disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copiar CLABE' }))
  await waitFor(() => expect(copy).toHaveBeenCalledWith('002010077777777771'))
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que el comercio recibió esta transferencia.' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
})
