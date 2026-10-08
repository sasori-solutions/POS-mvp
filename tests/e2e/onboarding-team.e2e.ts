import { submitPinIfPresent } from './workspace-flow'
import { openOperationalMore, openOwnerTask } from './workspace-flow'
import { expect, test, type Page } from '@playwright/test';
import { businessPermissions } from '../../src/lib/contracts';
import { fixtureAuthKey, fixtureAuthSession, fixtureBusiness, fixtureOperatorToken, fixturePin } from './account-fixture';
import { fixtureCashier, fixtureCashierPin, fixtureDeviceToken, fixtureInvitation, fixtureKitchen, fixturePairingCode, mockOnboarding } from './onboarding-fixture';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
});

test('a new Google account chooses whether to create or join a business', async ({ page }, testInfo) => {
  await mockOnboarding(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tu negocio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear mi negocio', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unirme a un negocio', exact: true })).toBeVisible();
  await expect(page.getByLabel('Nombre del negocio')).not.toBeVisible();
  await capture(page, testInfo.project.name, 'onboarding-choice');
});

test('new business external-card selection stays separate from Point and saves without linking a terminal', async ({ page }) => {
  const { calls } = await mockOnboarding(page);
  await page.goto('/business/new');
  await page.getByLabel('Nombre del negocio', { exact: true }).fill('Café de tarjeta');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  const card = page.getByRole('checkbox', { name: 'Mercado Pago Point', exact: true });
  const external = page.getByRole('checkbox', { name: 'Tarjeta externa', exact: true });
  await expect(card).toBeChecked();
  await expect(external).not.toBeChecked();
  await expect(page.getByRole('checkbox')).toHaveCount(4);
  for (const name of ['Efectivo', 'Tarjeta externa', 'Mercado Pago Point', 'Transferencia']) await expect(page.getByRole('checkbox', { name, exact: true })).toBeVisible();
  await card.uncheck();
  await expect(card).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Efectivo', exact: true })).toBeChecked();
  await external.check();
  await expect(external).toBeChecked();
  await expect(card).not.toBeChecked();
  expect(calls.filter(call => call.action === 'create_business')).toHaveLength(0);

  const tax = page.getByLabel('¿Qué IVA usas en tus precios?', { exact: true });
  await expect(tax).toHaveValue('');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu forma de trabajar', exact: true })).toBeVisible();
  await expect(page.getByTestId('pin-input')).not.toBeVisible();
  expect(calls.filter(call => call.action === 'create_business')).toHaveLength(0);
  await tax.selectOption('vat_16');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await fillAccountPin(page);
  await page.getByRole('button', { name: 'Crear negocio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  const creations = calls.filter(call => call.action === 'create_business');
  expect(creations).toHaveLength(1);
  expect(creations[0].profile.paymentMethods).toEqual(['cash', 'card_external']);
  expect(creations[0].profile.defaultVatTreatment).toBe('vat_16');
  expect(creations[0].operationId).toMatch(/^[0-9a-f-]{36}$/);
  const pointCommands = calls.filter(call => call.action === 'point' || call.action === 'device_point').map(call => call.command);
  expect(pointCommands.filter(command => command !== 'settings')).toEqual([]);
  expect(calls.filter(call => call.action === 'update_business')).toHaveLength(0);
});

test('creation saves branch, register and progressive profile for later editing', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Crear mi negocio', exact: true }).click();
  await page.getByLabel('Nombre del negocio').fill('Café del centro');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByLabel('¿Qué IVA usas en tus precios?', { exact: true }).selectOption('vat_16');
  await page.getByText('Sucursal y contacto', { exact: true }).click();
  await page.getByLabel('Sucursal', { exact: true }).fill('Centro');
  await page.getByLabel('Caja', { exact: true }).fill('Mostrador');
  await page.getByLabel(/^Ciudad/).fill('Guadalajara');
  await page.getByLabel(/^Estado/).fill('Jalisco');
  await page.getByLabel('Transferencia', { exact: true }).check();
  await capture(page, testInfo.project.name, 'onboarding-create');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await fillAccountPin(page);
  await page.getByRole('button', { name: 'Crear negocio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  const create = calls.find((call) => call.action === 'create_business');
  expect(create).toMatchObject({ profile: {
    branchName: 'Centro', registerName: 'Mostrador', city: 'Guadalajara', state: 'Jalisco',
    paymentMethods: ['cash', 'card_integrated', 'transfer'],
    defaultVatTreatment: 'vat_16',
  } });
  await openOwnerTask(page, 'Datos del negocio');
  await page.getByText('Sucursal y contacto', { exact: true }).click();
  await expect(page.getByLabel('Sucursal', { exact: true })).toHaveValue('Centro');
  await expect(page.getByLabel(/^Ciudad/)).toHaveValue('Guadalajara');
  await page.getByLabel(/^Dirección/).fill('Calle de prueba 100');
  await page.getByRole('textbox',{name:'Caja',exact:true}).fill('Barra');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cambios guardados.');
  await expect(page.locator('#pos-section-title')).toHaveText('Configuración');
  await page.reload();
  await unlockOwner(page);
  await openOwnerTask(page, 'Datos del negocio');
  await page.getByText('Sucursal y contacto', { exact: true }).click();
  await expect(page.getByRole('textbox',{name:'Caja',exact:true})).toHaveValue('Barra');
  await expect(page.getByLabel(/^Dirección/)).toHaveValue('Calle de prueba 100');
  await capture(page, testInfo.project.name, 'business-settings');
  expect(calls.filter((call) => call.action === 'update_business')).toHaveLength(1);
  await assertNoOperatorSecrets(page);
});

test('invalid branch, payment methods and phone stay on business details before PIN creation', async ({ page }) => {
  const { calls } = await mockOnboarding(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Crear mi negocio', exact: true }).click();
  await page.getByLabel('Nombre del negocio', { exact: true }).fill('Café de validación');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByLabel('¿Qué IVA usas en tus precios?', { exact: true }).selectOption('vat_16');
  await page.getByText('Sucursal y contacto', { exact: true }).click();
  await page.getByLabel('Sucursal', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/sucursal|caja/i);
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).not.toBeVisible();
  await page.getByLabel('Sucursal', { exact: true }).fill('Principal');
  for (const name of ['Efectivo', 'Tarjeta externa', 'Mercado Pago Point', 'Transferencia']) {
    const method = page.getByRole('checkbox', { name, exact: true });
    await method.uncheck();
    await expect(method).not.toBeChecked();
  }
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/método|pago/i);
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).not.toBeVisible();
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(0);
  await page.getByLabel('Efectivo', { exact: true }).check();
  await page.getByLabel('Teléfono', { exact: true }).fill('abcde');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/teléfono/i);
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).not.toBeVisible();
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(0);
  await page.getByLabel('Teléfono', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(0);
});

test('joining retries invalid invitations and applies assigned permissions without self selection', async ({ page }) => {
  const { calls } = await mockOnboarding(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Unirme a un negocio', exact: true }).click();
  await expect(page.getByLabel('Puesto', { exact: true })).not.toBeVisible();
  await page.getByLabel('Enlace de invitación', { exact: true }).fill(`http://127.0.0.1:5174/#invite=${'ff'.repeat(32)}`);
  await page.getByRole('button', { name: 'Abrir invitación', exact: true }).click();
  await expect(page.getByLabel('Tu nombre', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/invitación/i);
  await expect(page.getByRole('button', { name: 'Unirme', exact: true })).toBeDisabled();
  await expect(page.getByTestId('pin-input')).not.toBeVisible();
  expect(calls.filter((call) => call.action === 'accept_invitation')).toHaveLength(0);
  await page.getByLabel('Enlace de invitación', { exact: true }).fill(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  await page.getByRole('button', { name: 'Abrir invitación', exact: true }).click();
  await page.getByLabel('PIN', { exact: true }).fill(fixturePin);
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill(fixturePin);
  await page.getByRole('button', { name: 'Unirme', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: /Navegación (principal|lateral)/ }).filter({visible:true}).first();
  const mobileNavigation = await navigation.getAttribute('aria-label') === 'Navegación principal';
  await expect(navigation.getByRole('button')).toHaveText(mobileNavigation ? ['Comandas', 'Más'] : ['Comandas']);
  await expect(navigation.getByRole('button', { name: 'Comandas', exact: true })).toBeVisible();
  await openMore(page);
  await expect(page.getByRole('button', { name: 'Datos del negocio', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Empleados', exact: true })).not.toBeVisible();
  const accept = calls.filter((call) => call.action === 'accept_invitation');
  expect(accept).toHaveLength(1);
  expect(accept[0]).toMatchObject({ invitationCode: fixtureInvitation, pin: fixturePin });
  expect(accept[0]).not.toHaveProperty('name');
  expect(accept[0]).not.toHaveProperty('role');
  expect(accept[0]).not.toHaveProperty('permissions');
  await page.reload();
  await unlockOwner(page, fixturePin, 'Comandas');
  await assertNoOperatorSecrets(page);
});

test('an invitation link survives Google redirect and is consumed after joining', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { authenticated: false });
  await page.goto(`/login#invite=${fixtureInvitation}`);
  await page.route('http://127.0.0.1:54321/auth/v1/authorize**', (route) => route.fulfill({ contentType: 'text/plain', body: 'OAuth captured' }));
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtureAuthSession()) }));
  await expect(page.getByRole('heading', { name: 'Acepta tu invitación' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrar como empleado', exact: true })).toHaveCount(0);
  const authorization = page.waitForRequest((request) => request.url().includes('/auth/v1/authorize'));
  await page.getByRole('button', { name: 'Continuar con Google', exact: true }).click();
  await authorization;
  await page.goto('/auth/callback?code=fixture-code');
  await expect(page.getByLabel('PIN', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Código de invitación', { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/fixture-code|#invite=/);
  await expect(page.getByLabel('Tu nombre', { exact: true })).not.toBeVisible();
  await page.getByLabel('PIN', { exact: true }).fill(fixturePin);
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill(fixturePin);
  await page.getByRole('button', { name: 'Unirme', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.action === 'accept_invitation')).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).not.toContain(fixtureInvitation);
  await assertNoOperatorSecrets(page);
});

test('an owner with one business can create another or join from the unlock screen', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await page.getByRole('button', { name: 'Cambiar negocio', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Crear otro negocio', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unirme a un negocio', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Crear otro negocio', exact: true }).click();
  await expect(page.getByLabel('Nombre del negocio')).toBeVisible();
  expect(calls.filter((call) => call.action === 'unlock')).toHaveLength(0);
});

test('a cashier cannot open business settings or employee administration', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true, role: 'cashier' });
  await page.goto('/');
  await unlockOwner(page, fixturePin, 'Venta');
  await openMore(page);
  await expect(page.getByRole('button', { name: 'Datos del negocio', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Empleados', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Cambiar mi PIN', exact: true })).toBeVisible();
  await expect(page.getByText('Margen', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Costos', { exact: true })).not.toBeVisible();
  expect(calls.filter((call) => ['team', 'update_business'].includes(call.action))).toHaveLength(0);
});





test('a refreshed employee context removes the previously active money destination', async ({ page }) => {
  const fixture = await mockOnboarding(page, { existingBusiness: true, role: 'cashier' });
  await page.goto('/');
  await unlockOwner(page, fixturePin, 'Venta');
  await page.getByRole('navigation', { name: /Navegación (principal|lateral)/ }).filter({visible:true}).first().getByRole('button', { name: 'Historial', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Historial', exact: true })).toBeVisible();
  fixture.setEmployee(fixtureKitchen.id);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const navigation = page.getByRole('navigation', { name: /Navegación (principal|lateral)/ }).filter({visible:true}).first();
  const mobileNavigation = await navigation.getAttribute('aria-label') === 'Navegación principal';
  await expect(navigation.getByRole('button')).toHaveText(mobileNavigation ? ['Comandas', 'Más'] : ['Comandas']);
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historial', exact: true })).not.toBeVisible();
});

test('logout during PIN change discards and revokes a late operator response', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  let release: (() => void) | undefined;
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action === 'change_pin') {
      await new Promise<void>((resolve) => { release = resolve; });
    }
    await route.fallback();
  });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Cambiar mi PIN');
  await page.getByLabel('PIN actual', { exact: true }).fill(fixturePin);
  await fillAccountPin(page, '068214');
  await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click();
  try {
    await expect.poll(() => typeof release).toBe('function');
    await broadcastLogout(page);
    await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeEnabled();
    const locked = page.waitForResponse((response) => response.url().includes('/functions/v1/account') && response.request().postDataJSON()?.action === 'lock');
    release?.();
    await locked;
    await nextPaint(page);
    expect(calls.filter((call) => call.action === 'lock')).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recupera tu PIN', exact: true })).not.toBeVisible();
  } finally { release?.(); }
});

test('employee management gives each person one action and separates devices', async ({ page }, testInfo) => {
  await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await expect(page.locator('#pos-section-title')).toHaveText('Empleados');
  await expect(page.getByRole('list', { name: 'Empleados' }).getByText('Persona de prueba', { exact: true })).not.toBeVisible();
  const people = page.getByRole('list', { name: 'Empleados' });
  await expect(people.getByRole('listitem')).toHaveCount(2);
  await expect(people.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Invitaciones', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Vincular caja compartida', exact: true })).not.toBeVisible();
  await capture(page, testInfo.project.name, 'focused-employees');
  await openOwnerTask(page, 'Dispositivos de caja');
  await expect(people).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Vincular caja compartida', exact: true })).toBeVisible();
});

test('employee forms focus on one person and keep their PIN private', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await expect(page.getByRole('list', { name: 'Empleados' })).not.toBeVisible();
  await expect(page.getByRole('tab', { name: 'Dispositivos', exact: true })).not.toBeVisible();
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Crear código para restablecer PIN', exact: true })).toBeVisible();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Caja actualizada');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Cambios guardados\.$/ })).toBeVisible();
  expect(calls.find((call) => call.action === 'update_employee')).toMatchObject({ name: 'Caja actualizada', pin: null });
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Empleados' })).not.toBeVisible();
  await capture(page, testInfo.project.name, 'focused-employee-form');
});

test('employee deletion permanently removes business access without a restore action', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 640 });
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar empleado', exact: true }).click();
  await expect(page.getByRole('heading', { name: `¿Eliminar a ${fixtureCashier.name}?`, exact: true })).toBeVisible();
  await expect(page.getByText('Se eliminarán su acceso a este negocio, su PIN y su dispositivo vinculado. Sus sesiones e invitaciones dejarán de funcionar.', { exact: true })).toBeVisible();
  await expect(page.getByText('Esta acción no se puede deshacer. Si vuelve al equipo, necesitará una nueva invitación y elegirá un nuevo PIN.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/pos-permanent-employee-delete-${info.project.name}.png`, fullPage: true });
  expect(calls.filter((call) => call.action === 'delete_employee')).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancelar eliminación', exact: true }).click();
  await expect(page.getByRole('heading', { name: `¿Eliminar a ${fixtureCashier.name}?`, exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Eliminar empleado', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await expect(page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true })).not.toBeVisible();
  await expect(page.getByRole('list', { name: 'Empleados' }).getByRole('listitem')).toHaveCount(1);
  expect(calls.find((call) => call.action === 'delete_employee')).toMatchObject({ employeeId: fixtureCashier.id });
  await expect(page.getByText('Empleados eliminados', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Restaurar / })).toHaveCount(0);
});

for (const entry of [
  { status: 'accepted', revokeReason: null, acceptedAt: '2026-10-01T15:00:00.000Z', revokedAt: null, expected: 'Invitación aceptada' },
  { status: 'revoked', revokeReason: 'user_cancelled', acceptedAt: null, revokedAt: '2026-10-01T15:00:00.000Z', expected: 'Invitación cancelada' },
  { status: 'expired', revokeReason: null, acceptedAt: null, revokedAt: null, expected: 'Invitación vencida' },
  { status: 'revoked', revokeReason: 'replaced', acceptedAt: null, revokedAt: '2026-10-01T15:00:00.000Z', expected: 'Invitación reemplazada' },
] as const) {
  test(`invitation details report ${entry.status}/${entry.revokeReason ?? 'none'} as a specific result`, async ({ page }) => {
    await mockOnboarding(page, { existingBusiness: true, invitations: [{
      id: '89b9ec5a-ad1e-4dde-9564-38a3bc0ee1a4', employeeId: fixtureCashier.id,
      name: fixtureCashier.name, role: 'cashier', active: false, expiresAt: '2026-10-01T13:00:00.000Z', ...entry,
    }] });
    await page.goto('/');
    await unlockOwner(page);
    await openOwnerTask(page, 'Empleados');
    await page.getByRole('button', { name: /(?:Administrar|Editar) Caja de prueba/ }).click();
    await expect(page.getByText(entry.expected, { exact: true })).toBeVisible();
    await expect(page.getByText(/revocada o utilizada/)).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invitaciones', exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancelar invitación', exact: true })).not.toBeVisible();
  });
}

test('a pending invited employee keeps one setup path without a second PIN flow', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true, employees: [{ ...fixtureCashier, pinReady: false }], invitations: [{
    id: '89b9ec5a-ad1e-4dde-9564-38a3bc0ee1a4', employeeId: fixtureCashier.id, name: fixtureCashier.name, role: 'cashier',
    active: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'pending', acceptedAt: null, revokedAt: null, revokeReason: null,
  }] });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Crear código para PIN', exact: true })).toHaveCount(0);
  await expect(page.getByText('Lo creará al aceptar la invitación.')).toBeVisible();
  await page.getByRole('button', { name: 'Renovar invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación')).toBeVisible();
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  expect(calls.filter((call) => call.action === 'create_pin_setup')).toHaveLength(0);
  expect(calls.find((call) => call.action === 'create_invitation')).toMatchObject({ employeeId: fixtureCashier.id });
  expect(calls.filter((call) => call.action === 'update_employee')).toHaveLength(0);
  expect(calls.filter((call) => call.action === 'create_employee')).toHaveLength(0);
});

test('opening employee details does not offer to save unchanged data', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeDisabled();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill(`  ${fixtureCashier.name}  `);
  await expect(page.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeDisabled();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Cambio real');
  await expect(page.getByRole('button', { name: 'Guardar cambios', exact: true })).toBeEnabled();
  expect(calls.filter((call) => call.action === 'update_employee')).toHaveLength(0);
});

test('returning to employee details refreshes an invitation accepted elsewhere', async ({ page }) => {
  const fixture = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByText('Pendiente de aceptar', { exact: true })).toBeVisible();
  fixture.acceptLatestInvitation(fixtureCashier.id);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Invitación aceptada', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear invitación', exact: true })).not.toBeVisible();
});

test('a created invitation remains shareable when refreshing the employee list fails', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true });
  let teamLoads = 0;
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action !== 'team') return route.fallback();
    teamLoads += 1;
    if (teamLoads > 1) return route.abort('failed');
    return route.fallback();
  });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Enlace conservado');
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  await expect(page.getByRole('button', { name: 'Copiar enlace', exact: true })).toBeEnabled();
});

test('an invitation expiring in open details stops offering the old link', async ({ page }) => {
  await page.clock.install();
  await mockOnboarding(page, { existingBusiness: true, invitations: [{
    id: '89b9ec5a-ad1e-4dde-9564-38a3bc0ee1a4', employeeId: fixtureCashier.id, name: fixtureCashier.name, role: 'cashier',
    active: true, expiresAt: new Date(Date.now() + 30_000).toISOString(), status: 'pending', acceptedAt: null, revokedAt: null, revokeReason: null,
  }] });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await expect(page.getByText('Pendiente de aceptar', { exact: true })).toBeVisible();
  await page.clock.runFor(31_000);
  await expect(page.getByText('Invitación vencida', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar invitación', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Renovar invitación', exact: true })).toBeVisible();
});

test('owner management tasks work by keyboard and preserve focus in nested controls', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  for (const name of ['Empleados', 'Dispositivos', 'Configuración']) {
    const menu = page.getByRole('button', { name: 'Abrir menú', exact: true });
    if (await menu.isVisible()) await menu.click();
    const navigation = page.getByRole('navigation', { name: 'Navegación del dueño' }).filter({ visible: true }).first();
    const entry = navigation.getByRole('button', { name, exact: true });
    await entry.focus();
    await entry.press('Enter');
    await expect(page.locator('#pos-section-title')).toHaveText(name);
    if (await menu.isVisible()) {
      await menu.click();
      await expect(navigation.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
    } else {
      await expect(entry).toHaveAttribute('aria-current', 'page');
    }
  }
  await openOwnerTask(page, 'Empleados');
  const add = page.getByRole('button', { name: 'Agregar empleado', exact: true });
  await add.focus();
  await add.press('Enter');
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  const menu = page.getByRole('button', { name: 'Abrir menú', exact: true });
  if (await menu.isVisible()) await menu.click();
  const account = page.getByRole('button', { name: /^Opciones de cuenta:/ }).filter({ visible: true }).first();
  await account.focus();
  await account.press('Enter');
  await page.keyboard.press('Escape');
  await expect(account).toBeFocused();
  await account.press('Enter');
  const changePin = page.getByRole('button', { name: 'Cambiar mi PIN', exact: true }).filter({ visible: true });
  await changePin.focus();
  await changePin.press('Enter');
  await expect(page.locator('#pos-section-title')).toHaveText('Mi acceso');
  await expect(page.getByLabel('PIN actual', { exact: true })).toBeVisible();
});

test('a person removed elsewhere cannot remain in an editable employee detail', async ({ page }) => {
  const fixture = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  fixture.deleteEmployeeElsewhere(fixtureCashier.id);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('list', { name: 'Empleados' })).toBeVisible();
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true })).not.toBeVisible();
  await expect(page.getByText('Empleados eliminados', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Restaurar / })).toHaveCount(0);
});

test('employee creation has one invitation method and keeps PIN entry with the employee', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  const permissions = page.getByRole('group', { name: 'Permisos', exact: true });
  await expect(permissions.getByRole('checkbox')).toHaveCount(businessPermissions.length);
  await expect(permissions.locator('input:checked')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  await expect(page.getByText('Comparte la invitación. El empleado elige su PIN y vincula su dispositivo.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear invitación', exact: true })).toHaveCount(1);
});

test('Google employee creation saves one pending person without requesting their PIN', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Cocina invitada');
  await page.getByRole('checkbox', { name: 'Actualizar preparación', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Consultar comandas', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  await expect(page.getByText('Pendiente de aceptar', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Compartir invitación' })).toContainText('Cocina invitada');
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Empleados' })).not.toBeVisible();
  expect(calls.filter((call) => call.action === 'create_employee')).toHaveLength(1);
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Cocina invitada', role: 'cashier', permissions: ['kitchen.read', 'kitchen.operate'], pin: null, inviteWithGoogle: true });
  expect(calls.filter((call) => call.action === 'create_invitation')).toHaveLength(0);
  await capture(page, testInfo.project.name, 'unified-google-employee');
  await assertNoOperatorSecrets(page);
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Administrar Cocina invitada', exact: true })).toHaveCount(1);
});

test('Google linking targets the existing employee and retries a lost response without a new person', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  const attempts: Record<string, unknown>[] = [];
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action !== 'create_invitation') return route.fallback();
    attempts.push(body);
    if (attempts.length === 1) return route.abort('failed');
    return route.fallback();
  });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).toHaveValue(fixtureCashier.name);
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId);
  expect(attempts[1]).toMatchObject({ employeeId: fixtureCashier.id });
  expect(attempts[1]).not.toHaveProperty('name');
  expect(attempts[1]).not.toHaveProperty('role');
  expect(calls.filter((call) => call.action === 'create_employee')).toHaveLength(0);
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await expect(page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true })).toHaveCount(1);
});

test('a lost Google employee response retries the same atomic creation without a duplicate', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true, createEmployeeResponseLosses: 1 });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Empleado con reintento');
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  await expect(page.getByRole('region', { name: 'Compartir invitación' })).toContainText('Empleado con reintento');
  const attempts = calls.filter((call) => call.action === 'create_employee');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId);
  expect(attempts.every((call) => call.pin === null && call.inviteWithGoogle === true)).toBe(true);
  expect(attempts.every((call) => JSON.stringify(call.permissions) === '[]')).toBe(true);
  expect(calls.filter((call) => call.action === 'create_invitation')).toHaveLength(0);
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Administrar Empleado con reintento', exact: true })).toHaveCount(1);
});

test('permission choices keep the same invitation method and employee-owned PIN', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Empleado sin PIN oculto');
  await page.getByRole('checkbox', { name: 'Actualizar preparación', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Crear y editar productos', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Consultar comandas', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Actualizar preparación', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Consultar productos', exact: true })).toBeChecked();
  await capture(page, testInfo.project.name, 'unified-google-form');
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel('Confirmar PIN del empleado', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ permissions: ['catalog.read', 'catalog.manage'], pin: null, inviteWithGoogle: true });
  await assertNoOperatorSecrets(page);
});

test('the owner creates employee access and invitations with explicit permissions', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openOwnerTask(page, 'Empleados');
  await expect(page.locator('#pos-section-title')).toHaveText('Empleados');
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'team-management');
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Nueva cajera');
  await page.getByRole('checkbox', { name: 'Cobrar ventas', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Consultar productos', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: /dueño/i })).toHaveCount(0);
  await page.getByLabel('Nombre del empleado', { exact: true }).fill(' ');
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(calls.filter((call) => call.action === 'create_employee')).toHaveLength(0);
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Nueva cajera');
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await page.getByRole('button', { name: 'Administrar empleado', exact: true }).click();
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).toHaveValue('Nueva cajera');
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Cajera actualizada');
  await page.getByRole('checkbox', { name: 'Crear y editar productos', exact: true }).check();
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Administrar Cajera actualizada', exact: true })).toBeVisible();
  await expect(page.getByText('3 permisos · Invitación pendiente', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Nueva cocina');
  await page.getByRole('checkbox', { name: 'Actualizar preparación', exact: true }).check();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  await page.getByRole('button', { name: 'Administrar empleado', exact: true }).click();
  await page.getByRole('button', { name: 'Cancelar invitación', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelar invitación', exact: true })).not.toBeVisible();
  await expect(page.getByText('Invitación cancelada', { exact: true })).toBeVisible();
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Nueva cajera', role: 'cashier', permissions: ['catalog.read', 'sales.create'], pin: null });
  expect(calls.find((call) => call.action === 'update_employee')).toMatchObject({ name: 'Cajera actualizada', role: 'cashier', permissions: ['catalog.read', 'catalog.manage', 'sales.create'], active: true, pin: null });
  expect(calls.filter((call) => call.action === 'create_employee')[1]).toMatchObject({ name: 'Nueva cocina', role: 'cashier', permissions: ['kitchen.read', 'kitchen.operate'], pin: null, inviteWithGoogle: true });
  expect(calls.filter((call) => call.action === 'create_invitation')).toHaveLength(0);
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await openOwnerTask(page, 'Dispositivos de caja');
  await page.getByRole('button', { name: 'Vincular caja compartida', exact: true }).click();
  await expect(page.getByLabel('Código para vincular dispositivo', { exact: true })).toHaveValue(fixturePairingCode);
  await assertNoOperatorSecrets(page);
});

test('employee pairing, PIN switch and reload keep only the restricted device credential', async ({ page }, testInfo) => {
  const fixture = await mockOnboarding(page, { authenticated: false });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Abrir caja compartida', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vincular caja compartida', exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'employee-pairing');
  await page.getByLabel('Código de vinculación', { exact: true }).fill('ff'.repeat(32));
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Tablet mostrador');
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/código/i);
  await page.getByLabel('Código de vinculación', { exact: true }).fill(fixturePairingCode);
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  await capture(page, testInfo.project.name, 'employee-roster');
  await page.getByRole('button', { name: fixtureCashier.name, exact: true }).click();
  await expect(page.getByLabel('PIN del empleado', { exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'employee-pin');
  await page.getByLabel('PIN del empleado', { exact: true }).fill('999999');
  await submitPinIfPresent(page);
  await expect(page.getByRole('alert')).toContainText(/PIN/i);
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible();
  const businessName = page.locator('.workspace-mobile-business, .workspace-brand > span:last-child').filter({ visible: true }).first();
  await expect(businessName).toBeVisible();
  await expect(businessName).toContainText(fixtureBusiness.name);
  const priorOperator = fixture.deviceOperator();
  await openMore(page);
  await page.getByRole('button', { name: 'Cambiar empleado', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  expect(fixture.calls.find((call) => call.action === 'device_lock')).toMatchObject({ operatorToken: priorOperator });
  await page.getByRole('button', { name: fixtureKitchen.name, exact: true }).click();
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixturePin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible();
  expect(fixture.deviceOperator()).not.toBe(priorOperator);
  const nextOperator = fixture.deviceOperator();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: /Navegación (principal|lateral)/ }).filter({visible:true}).first()).not.toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(stored).toContain(fixtureDeviceToken);
  expect(stored).not.toContain(fixtureCashierPin);
  expect(stored).not.toContain(priorOperator);
  expect(stored).not.toContain(nextOperator);
  expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
  expect(fixture.authorizations.filter((call) => call.action.startsWith('device_')).every((call) => !call.authorization)).toBe(true);
});

test('a revoked shared device loses access and cannot resume an employee session', async ({ page }) => {
  const fixture = await mockOnboarding(page, { authenticated: false });
  await page.goto('/register');
  await page.getByLabel('Código de vinculación', { exact: true }).fill(fixturePairingCode);
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Tablet revocable');
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  fixture.revokeDevice();
  await page.getByRole('button', { name: fixtureCashier.name, exact: true }).click();
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Vincular caja compartida', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/revocado|vincular/i);
  await expect(page.getByRole('navigation', { name: /Navegación (principal|lateral)/ }).filter({visible:true}).first()).not.toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(fixtureDeviceToken);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Vincular caja compartida', exact: true })).toBeVisible();
});

async function fillAccountPin(page: Page, pin = fixturePin) {
  await page.getByTestId('pin-input').fill(pin);
  await page.getByTestId('pin-confirm-input').fill(pin);
}

async function unlockOwner(page: Page, pin = fixturePin, destination = 'Inicio') {
  await page.getByTestId('pin-input').fill(pin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible();
}

async function openMore(page: Page) {
  await openOperationalMore(page);
}

async function assertNoOperatorSecrets(page: Page) {
  const stored = await page.evaluate(() => ({ local: JSON.stringify(Object.entries(localStorage)), session: JSON.stringify(Object.entries(sessionStorage)) }));
  for (const storage of Object.values(stored)) {
    expect(storage).not.toContain(fixturePin);
    expect(storage).not.toContain(fixtureCashierPin);
    expect(storage).not.toContain(fixtureOperatorToken);
  }
}

async function capture(page: Page, project: string, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/pos-mexico-${project}-${name}.png`, fullPage: true });
}

async function broadcastLogout(page: Page) {
  await page.evaluate(() => {
    const channel = new BroadcastChannel('pos-mexico-session');
    channel.postMessage('logout');
    setTimeout(() => channel.close(), 50);
  });
}

async function nextPaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}
