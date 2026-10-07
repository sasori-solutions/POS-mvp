import { expect, test, type Page } from '@playwright/test'
import { fixturePin } from './account-fixture'
import { mockPos } from './pos-fixture'
import { enterOperations, submitPinIfPresent } from './workspace-flow'
import type { DiningTable } from '../../src/lib/operations-contracts'
import type { ServiceDay } from '../../src/lib/service-contracts'

// The device clock deliberately differs from the business's Mexico City clock.
test.use({ timezoneId: 'America/New_York' })

async function openAgenda(page: Page, date: string) {
  await enterOperations(page)
  await page.getByRole('button', { name: 'Volver a mesas y cuentas', exact: true }).click()
  await page.getByRole('group', { name: 'Vista de servicio', exact: true }).getByRole('button', { name: 'Reservaciones', exact: true }).click()
  const agenda = page.getByRole('region', { name: 'Reservaciones', exact: true })
  await agenda.getByLabel('Fecha', { exact: true }).fill(date)
  await expect(agenda.getByRole('button', { name: 'Añadir reservación', exact: true })).toBeEnabled()
  return agenda
}

test('reservation start and end survive native input, table selection, editing and reload in the business timezone', async ({ page }) => {
  const backend = await mockPos(page, { empty: true, accountsEnabled: true })
  const date = '2026-10-07', name = 'Reserva de horario sintética'
  try {
    const table = await backend.execute<DiningTable>({ command: 'save_table', operationId: crypto.randomUUID(), tableId: crypto.randomUUID(), expectedRevision: null, name: 'Mesa de horario sintética', active: true })
    // PostgreSQL serializes timestamptz in the request's business timezone.
    // Compare the exact instant independently of its equivalent offset spelling.
    const persisted = async () => (await backend.execute<ServiceDay>({ command: 'service_day', date })).reservations.map(reservation => ({
      ...reservation, startsAt: new Date(reservation.startsAt).toISOString(), endsAt: new Date(reservation.endsAt).toISOString(),
    }))
    await page.goto('/')
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page)
    let agenda = await openAgenda(page, date)
    await agenda.getByRole('button', { name: 'Añadir reservación', exact: true }).click()
    const creating = page.getByRole('dialog', { name: 'Añadir reservación', exact: true })
    await creating.getByLabel('Nombre', { exact: true }).fill(name)
    const start = creating.getByLabel('Inicio · horario del negocio', { exact: true })
    const end = creating.getByLabel('Fin · horario del negocio', { exact: true })
    await start.fill(`${date}T12:00`)
    await expect(start).toHaveValue(`${date}T12:00`)
    await end.fill(`${date}T13:00`)
    await expect(start).toHaveValue(`${date}T12:00`)
    await expect(end).toHaveValue(`${date}T13:00`)
    await creating.getByRole('checkbox', { name: table.name, exact: true }).check()
    await expect(start).toHaveValue(`${date}T12:00`)
    await expect(end).toHaveValue(`${date}T13:00`)
    await creating.getByRole('button', { name: 'Guardar reservación', exact: true }).click()
    await expect(creating).not.toBeVisible()
    await expect.poll(persisted).toEqual([expect.objectContaining({ name, revision: 1, startsAt: `${date}T18:00:00.000Z`, endsAt: `${date}T19:00:00.000Z`, tableIds: [table.id], status: 'confirmed' })])
    expect(backend.calls.filter(command => command.command === 'save_service_reservation')).toEqual([expect.objectContaining({ expectedRevision: null, startsAt: `${date}T18:00:00.000Z`, endsAt: `${date}T19:00:00.000Z`, tableIds: [table.id] })])

    const record = agenda.getByRole('listitem').filter({ hasText: name })
    await record.getByRole('button', { name: 'Editar', exact: true }).click()
    const editing = page.getByRole('dialog', { name: 'Editar reservación', exact: true })
    const editedStart = editing.getByLabel('Inicio · horario del negocio', { exact: true })
    const editedEnd = editing.getByLabel('Fin · horario del negocio', { exact: true })
    await expect(editedStart).toHaveValue(`${date}T12:00`)
    await expect(editedEnd).toHaveValue(`${date}T13:00`)
    await editedStart.fill(`${date}T12:15`)
    await editedEnd.fill(`${date}T13:45`)
    await expect(editedStart).toHaveValue(`${date}T12:15`)
    await expect(editedEnd).toHaveValue(`${date}T13:45`)
    await editing.getByRole('checkbox', { name: table.name, exact: true }).uncheck()
    await editing.getByRole('checkbox', { name: table.name, exact: true }).check()
    await expect(editedStart).toHaveValue(`${date}T12:15`)
    await expect(editedEnd).toHaveValue(`${date}T13:45`)
    await editing.getByRole('button', { name: 'Guardar reservación', exact: true }).click()
    await expect(editing).not.toBeVisible()
    await expect.poll(persisted).toEqual([expect.objectContaining({ name, revision: 2, startsAt: `${date}T18:15:00.000Z`, endsAt: `${date}T19:45:00.000Z`, tableIds: [table.id] })])
    expect(backend.calls.filter(command => command.command === 'save_service_reservation')).toHaveLength(2)
    expect(backend.calls.filter(command => command.command === 'save_service_reservation').at(-1)).toMatchObject({ expectedRevision: 1, startsAt: `${date}T18:15:00.000Z`, endsAt: `${date}T19:45:00.000Z`, tableIds: [table.id] })

    await page.reload()
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page)
    agenda = await openAgenda(page, date)
    await agenda.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Editar', exact: true }).click()
    const restored = page.getByRole('dialog', { name: 'Editar reservación', exact: true })
    await expect(restored.getByLabel('Inicio · horario del negocio', { exact: true })).toHaveValue(`${date}T12:15`)
    await expect(restored.getByLabel('Fin · horario del negocio', { exact: true })).toHaveValue(`${date}T13:45`)
    await expect(restored.getByRole('checkbox', { name: table.name, exact: true })).toBeChecked()
    expect(backend.calls.filter(command => command.command === 'save_service_reservation')).toHaveLength(2)
  } finally { await backend.db.close() }
})
