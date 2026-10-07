import { test, expect, type Page } from '@playwright/test'
import type { KitchenBatch, OperationalOrder } from '../../src/lib/operations-contracts'
import { fixturePin } from './account-fixture'
import { mockPos } from './pos-fixture'
import { enterOperations, submitPinIfPresent } from './workspace-flow'

async function unlock(page: Page) {
  await page.goto('/')
  await page.getByTestId('pin-input').fill(fixturePin)
  await submitPinIfPresent(page)
  await enterOperations(page)
}

test('accounts mode sends editable service orders before payment and only sends added quantities', async ({ page }) => {
  const backend = await mockPos(page, { accountsEnabled: true })
  const name = 'Mesa sintética 7'
  const kitchen = () => backend.execute<{ batches: KitchenBatch[] }>({ command: 'kitchen' })
  try {
    await unlock(page)
    await page.getByRole('button', { name: /^Agregar Latte,/ }).click()
    const showAccount = page.getByRole('button', { name: /^Ver cuenta/ })
    if (await showAccount.isVisible()) await showAccount.click()
    await page.getByLabel('Nombre de la cuenta', { exact: true }).fill(name)
    await expect(page.getByRole('button', { name: 'Cobrar', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Abrir cuenta', exact: true }).click()

    const account = page.getByRole('dialog', { name, exact: true })
    await expect(account).toBeVisible()
    const created = backend.calls.find(command => command.command === 'save_order')!
    expect(created).toMatchObject({ orderKind: 'service', name })
    if (created.command !== 'save_order') throw new Error('Expected the saved service order')
    const orderId = created.orderId
    const order = () => backend.execute<OperationalOrder>({ command: 'order', orderId })
    expect(await order()).toMatchObject({ orderKind: 'service', status: 'open', phase: 'service', paidCents: 0, balanceCents: 5800 })
    expect((await kitchen()).batches).toHaveLength(0)
    expect(backend.calls.some(command => command.command === 'prepare_checkout')).toBe(false)

    await account.getByRole('button', { name: 'Enviar a cocina', exact: true }).click()
    await expect.poll(async () => (await kitchen()).batches.length).toBe(1)
    const firstBatch = (await kitchen()).batches[0]
    expect(firstBatch.items.map(item => ({ name: item.name, quantity: item.quantity }))).toEqual([{ name: 'Latte', quantity: 1 }])
    expect((await backend.sales()).sales).toHaveLength(0)
    await expect(account.getByText('1 enviados · 0 pagados')).toBeVisible()
    await expect(account.getByRole('button', { name: 'Enviar a cocina', exact: true })).toHaveCount(0)

    await account.getByRole('button', { name: 'Editar artículos', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Editar cuenta', exact: true })
    await editor.getByRole('button', { name: 'Añadir Latte', exact: true }).click()
    await editor.getByRole('region', { name: 'Añadir productos' }).getByRole('button', { name: /^Agregar Croissant,/ }).click()
    await editor.getByRole('button', { name: 'Guardar cuenta', exact: true }).click()
    await expect(account).toBeVisible()
    await expect(account.getByText('2 × Latte')).toBeVisible()
    await expect(account.getByText('1 × Croissant')).toBeVisible()
    await account.getByRole('button', { name: 'Enviar a cocina', exact: true }).click()
    await expect.poll(async () => (await kitchen()).batches.length).toBe(2)
    const beforePayment = (await kitchen()).batches
    const added = beforePayment.find(batch => batch.id !== firstBatch.id)!
    expect(added.items.map(item => ({ name: item.name, quantity: item.quantity })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Croissant', quantity: 1 }, { name: 'Latte', quantity: 1 },
    ])
    expect(await order()).toMatchObject({ balanceCents: 16400, paidCents: 0 })
    expect((await backend.sales()).sales).toHaveLength(0)
    expect(backend.calls.filter(command => command.command === 'prepare_checkout')).toHaveLength(0)

    // A fresh unlock must recover the persisted service account through Comandas,
    // without turning it into a direct sale in the Venta draft.
    await page.reload()
    await page.getByTestId('pin-input').fill(fixturePin)
    await submitPinIfPresent(page)
    await enterOperations(page)
    await page.getByRole('navigation').getByRole('button', { name: /^(?:\d+ )?Comandas$/ }).filter({ visible: true }).first().click()
    await page.getByRole('button', { name: 'Cuentas', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
    await expect(account).toBeVisible()
    await expect(account.getByText('2 enviados · 0 pagados')).toBeVisible()
    await expect(account.getByRole('button', { name: 'Enviar a cocina', exact: true })).toHaveCount(0)
    await account.getByRole('button', { name: 'Cobrar $164.00', exact: true }).click()
    const checkout = page.getByRole('dialog', { name: 'Cobrar', exact: true })
    await expect(checkout).toBeVisible()
    await expect(checkout.locator('.checkout-amount')).toContainText('$164.00')
    await expect(checkout.getByRole('button', { name: 'Registrar pago', exact: true })).toBeEnabled()
    await checkout.getByRole('button', { name: 'Registrar pago', exact: true }).click()
    await expect.poll(async () => (await backend.sales()).sales.length).toBe(1)
    await expect(checkout).not.toBeVisible()
    expect((await backend.sales()).sales[0]).toMatchObject({ totalCents: 16400, paymentMethod: 'cash' })
    expect(await order()).toMatchObject({ status: 'closed', balanceCents: 0, paidCents: 16400 })
    expect((await kitchen()).batches).toEqual(beforePayment)
    expect(backend.calls.filter(command => command.command === 'send_order')).toHaveLength(2)
    expect(backend.calls.filter(command => command.command === 'record_checkout')).toHaveLength(1)
  } finally { await backend.db.close() }
})
