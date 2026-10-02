import { expect, test, type Page } from '@playwright/test';
import { fixtureAuthKey, fixtureAuthSession, fixtureBusiness, fixtureOperatorToken, fixturePin } from './account-fixture';
import { fixtureCashier, fixtureCashierPin, fixtureDeviceToken, fixtureInvitation, fixtureKitchen, fixturePairingCode, fixtureRecoveryCode, mockOnboarding } from './onboarding-fixture';

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
  await expect(page.getByRole('heading', { name: '¿Qué quieres hacer?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear mi negocio', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unirme a un negocio', exact: true })).toBeVisible();
  await expect(page.getByLabel('Nombre del negocio')).not.toBeVisible();
  await capture(page, testInfo.project.name, 'onboarding-choice');
});

test('creation saves branch, register and progressive profile for later editing', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Crear mi negocio', exact: true }).click();
  await page.getByLabel('Nombre del negocio').fill('Café del centro');
  await page.getByLabel('Sucursal', { exact: true }).fill('Centro');
  await page.getByLabel('Caja', { exact: true }).fill('Mostrador');
  await page.getByText('Dirección y contacto (opcional)', { exact: true }).click();
  await page.getByLabel(/^Ciudad/).fill('Guadalajara');
  await page.getByLabel(/^Estado/).fill('Jalisco');
  await page.getByLabel('Transferencia', { exact: true }).check();
  await capture(page, testInfo.project.name, 'onboarding-create');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await fillAccountPin(page);
  await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
  await page.getByRole('button', { name: 'Ya guardé mi código', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cuenta creada' })).toBeVisible();
  const create = calls.find((call) => call.action === 'create_business');
  expect(create).toMatchObject({ profile: {
    branchName: 'Centro', registerName: 'Mostrador', city: 'Guadalajara', state: 'Jalisco',
    paymentMethods: ['cash', 'card_external', 'transfer'],
  } });
  await page.getByRole('button', { name: 'Ir al inicio', exact: true }).click();
  await openMore(page);
  await page.getByRole('button', { name: 'Datos del negocio', exact: true }).click();
  await expect(page.getByLabel('Sucursal', { exact: true })).toHaveValue('Centro');
  await expect(page.getByLabel(/^Ciudad/)).toHaveValue('Guadalajara');
  await page.getByLabel(/^Dirección/).fill('Calle de prueba 100');
  await page.getByLabel('Caja', { exact: true }).fill('Barra');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cambios guardados.');
  await expect(page.getByRole('heading', { name: 'Datos del negocio', exact: true })).toBeVisible();
  await page.reload();
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Datos del negocio', exact: true }).click();
  await expect(page.getByLabel('Caja', { exact: true })).toHaveValue('Barra');
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
  await page.getByLabel('Sucursal', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/sucursal|caja/i);
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).not.toBeVisible();
  await page.getByLabel('Sucursal', { exact: true }).fill('Principal');
  await page.getByLabel('Efectivo', { exact: true }).uncheck();
  await page.getByLabel('Tarjeta en terminal externa', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/método|pago/i);
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).not.toBeVisible();
  await page.getByLabel('Efectivo', { exact: true }).check();
  await page.getByText('Dirección y contacto (opcional)', { exact: true }).click();
  await page.getByLabel('Teléfono público', { exact: true }).fill('abcde');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/teléfono/i);
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).not.toBeVisible();
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(0);
  await page.getByLabel('Teléfono público', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Crea tu PIN', exact: true })).toBeVisible();
});

test('joining retries invalid invitations and applies the invited role without self selection', async ({ page }) => {
  const { calls } = await mockOnboarding(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Unirme a un negocio', exact: true }).click();
  await expect(page.getByLabel('Puesto', { exact: true })).not.toBeVisible();
  await page.getByLabel('Código de invitación', { exact: true }).fill('ff'.repeat(32));
  await expect(page.getByLabel('Tu nombre', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/invitación/i);
  await expect(page.getByRole('button', { name: 'Unirme', exact: true })).toBeDisabled();
  await expect(page.getByTestId('pin-input')).not.toBeVisible();
  expect(calls.filter((call) => call.action === 'accept_invitation')).toHaveLength(0);
  await page.getByLabel('Código de invitación', { exact: true }).fill(fixtureInvitation);
  await page.getByLabel('PIN', { exact: true }).fill(fixturePin);
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill(fixturePin);
  await page.getByRole('button', { name: 'Unirme', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Navegación principal' });
  await expect(navigation.getByRole('button')).toHaveCount(2);
  await expect(navigation.getByRole('button', { name: 'Comandas', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Más', exact: true })).toBeVisible();
  await openMore(page);
  await expect(page.getByRole('button', { name: 'Datos del negocio', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Empleados', exact: true })).not.toBeVisible();
  const accept = calls.filter((call) => call.action === 'accept_invitation');
  expect(accept).toHaveLength(1);
  expect(accept[0]).toMatchObject({ invitationCode: fixtureInvitation, pin: fixturePin });
  expect(accept[0]).not.toHaveProperty('name');
  expect(accept[0]).not.toHaveProperty('role');
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
  await unlockOwner(page);
  await openMore(page);
  await expect(page.getByRole('button', { name: 'Datos del negocio', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Empleados', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Cambiar mi PIN', exact: true })).toBeVisible();
  await expect(page.getByText('Margen', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Costos', { exact: true })).not.toBeVisible();
  expect(calls.filter((call) => ['team', 'update_business'].includes(call.action))).toHaveLength(0);
});

test('forgotten PIN recovery requires a fresh Google identity and saves the confirmed replacement', async ({ page }) => {
  const { calls, authorizations } = await mockOnboarding(page, { existingBusiness: true, requirePinReauth: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Olvidé mi PIN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recupera tu PIN' })).toBeVisible();
  expect(calls.filter((call) => call.action === 'reset_pin')).toHaveLength(0);
  const freshSession = fixtureAuthSession({}, 'ee3124de-c35c-464b-b77a-19bd3f18fc89');
  await page.route('http://127.0.0.1:54321/auth/v1/authorize**', (route) => route.fulfill({ contentType: 'text/plain', body: 'Fresh OAuth captured' }));
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(freshSession) }));
  const authorization = page.waitForRequest((request) => request.url().includes('/auth/v1/authorize'));
  await page.getByRole('button', { name: 'Volver a verificar con Google', exact: true }).click();
  await authorization;
  await page.goto('/auth/callback?code=fresh-fixture-code');
  await expect(page.getByRole('heading', { name: 'Crea un nuevo PIN' })).toBeVisible();
  await page.getByLabel('Código de recuperación', { exact: true }).fill(fixtureRecoveryCode);
  const replacementPin = '068214';
  await page.getByTestId('pin-input').fill(replacementPin);
  await page.getByTestId('pin-confirm-input').fill('999999');
  await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(calls.filter((call) => call.action === 'reset_pin')).toHaveLength(0);
  await page.getByTestId('pin-confirm-input').fill(replacementPin);
  await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click();
  await page.getByRole('button', { name: 'Ya guardé mi código', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible();
  expect(authorizations.find((call) => call.action === 'reset_pin')?.authorization).toBe(`Bearer ${freshSession.access_token}`);
  expect(calls.find((call) => call.action === 'reset_pin')).toMatchObject({ businessId: fixtureBusiness.id, pin: replacementPin });
  await page.reload();
  await unlockOwner(page, replacementPin);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(replacementPin);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).not.toContain(replacementPin);
});

test('logout cancels Google reverification while old identity revocation is pending', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true });
  const googleAuthorizations: string[] = [];
  await page.route('http://127.0.0.1:54321/auth/v1/authorize**', async (route) => {
    googleAuthorizations.push(route.request().url());
    await route.fulfill({ contentType: 'text/plain', body: 'Unexpected Google redirect after logout' });
  });
  let release: (() => void) | undefined;
  await page.route('http://127.0.0.1:54321/auth/v1/logout**', async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Olvidé mi PIN', exact: true }).click();
  await page.getByRole('button', { name: 'Volver a verificar con Google', exact: true }).click();
  try {
    await expect.poll(() => typeof release).toBe('function');
    await broadcastLogout(page);
    await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeVisible();
    const revoked = page.waitForResponse((response) => response.url().includes('/auth/v1/logout'));
    release?.();
    await revoked;
    await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeEnabled();
    await nextPaint(page);
    expect(googleAuthorizations).toEqual([]);
    await expect(page.getByRole('button', { name: 'Continuar con Google', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Crea un nuevo PIN', exact: true })).not.toBeVisible();
  } finally { release?.(); }
});

test('a context role change removes the previously active money destination', async ({ page }) => {
  const fixture = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('button', { name: 'Ventas', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ventas', exact: true })).toBeVisible();
  fixture.setRole('kitchen');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ventas', exact: true })).not.toBeVisible();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Cambiar mi PIN', exact: true }).click();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Empleados', exact: true })).toBeVisible();
  await expect(page.getByText('Persona de prueba', { exact: true })).not.toBeVisible();
  const people = page.getByRole('list', { name: 'Empleados' });
  await expect(people.getByRole('listitem')).toHaveCount(2);
  await expect(people.getByRole('button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Invitaciones', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Vincular dispositivo', exact: true })).not.toBeVisible();
  await capture(page, testInfo.project.name, 'focused-employees');
  await page.getByRole('button', { name: 'Volver a Más', exact: true }).click();
  await page.getByRole('button', { name: 'Dispositivos de caja', exact: true }).click();
  await expect(people).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Vincular dispositivo', exact: true })).toBeVisible();
});

test('employee forms focus on one person and keep their PIN private', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await expect(page.getByRole('list', { name: 'Empleados' })).not.toBeVisible();
  await expect(page.getByRole('tab', { name: 'Dispositivos', exact: true })).not.toBeVisible();
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Crear código para restablecer PIN', exact: true })).toBeVisible();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Caja actualizada');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect(calls.find((call) => call.action === 'update_employee')).toMatchObject({ name: 'Caja actualizada', pin: null });
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Empleados' })).not.toBeVisible();
  await capture(page, testInfo.project.name, 'focused-employee-form');
});

test('employee deletion requires a scoped confirmation and removes the person from the main list', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Eliminar empleado', exact: true }).click();
  await expect(page.getByRole('heading', { name: `¿Eliminar a ${fixtureCashier.name}?`, exact: true })).toBeVisible();
  expect(calls.filter((call) => call.action === 'delete_employee')).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancelar eliminación', exact: true }).click();
  await expect(page.getByRole('heading', { name: `¿Eliminar a ${fixtureCashier.name}?`, exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Eliminar empleado', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await expect(page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true })).not.toBeVisible();
  await expect(page.getByRole('list', { name: 'Empleados' }).getByRole('listitem')).toHaveCount(1);
  expect(calls.find((call) => call.action === 'delete_employee')).toMatchObject({ employeeId: fixtureCashier.id });
  await page.getByText('Empleados eliminados', { exact: true }).click();
  await page.getByRole('button', { name: `Restaurar ${fixtureCashier.name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true })).toBeVisible();
  expect(calls.find((call) => call.action === 'restore_employee')).toMatchObject({ employeeId: fixtureCashier.id });
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
    await openMore(page);
    await page.getByRole('button', { name: 'Empleados', exact: true }).click();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  await expect(page.getByText('Pendiente de aceptar', { exact: true })).toBeVisible();
  await page.clock.runFor(31_000);
  await expect(page.getByText('Invitación vencida', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar invitación', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Renovar invitación', exact: true })).toBeVisible();
});

test('Más entries work by keyboard and return focus to the previous task', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  for (const name of ['Empleados', 'Dispositivos de caja', 'Datos del negocio', 'Cambiar mi PIN', 'Código de recuperación']) {
    const entry = page.getByRole('button', { name, exact: true });
    await entry.focus();
    await entry.press('Enter');
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Volver a Más', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Más', exact: true })).toBeVisible();
    await expect(entry).toBeFocused();
  }
});

test('a person removed elsewhere cannot remain in an editable employee detail', async ({ page }) => {
  const fixture = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true }).click();
  fixture.deleteEmployeeElsewhere(fixtureCashier.id);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('list', { name: 'Empleados' })).toBeVisible();
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: `Administrar ${fixtureCashier.name}`, exact: true })).not.toBeVisible();
  await page.getByText('Empleados eliminados', { exact: true }).click();
  await expect(page.getByRole('button', { name: `Restaurar ${fixtureCashier.name}`, exact: true })).toBeVisible();
});

test('employee creation has one invitation method and keeps PIN entry with the employee', async ({ page }) => {
  await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(page.getByRole('radio', { name: 'Cajero', exact: true })).toBeChecked();
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  await expect(page.getByText('Recibirás un enlace para compartir. El empleado entrará con Google y creará su PIN.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear invitación', exact: true })).toHaveCount(1);
});

test('Google employee creation saves one pending person without requesting their PIN', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Cocina invitada');
  await page.getByRole('radio', { name: 'Cocina', exact: true }).check();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  await expect(page.getByText('Pendiente de aceptar', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Compartir invitación' })).toContainText('Cocina invitada');
  await expect(page.getByLabel('Nombre del empleado', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Empleados' })).not.toBeVisible();
  expect(calls.filter((call) => call.action === 'create_employee')).toHaveLength(1);
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Cocina invitada', role: 'kitchen', pin: null, inviteWithGoogle: true });
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
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
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
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
  expect(calls.filter((call) => call.action === 'create_invitation')).toHaveLength(0);
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Administrar Empleado con reintento', exact: true })).toHaveCount(1);
});

test('all role choices keep the same invitation method and employee-owned PIN', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Empleado sin PIN oculto');
  await page.getByRole('radio', { name: 'Cocina', exact: true }).check();
  await page.getByRole('radio', { name: 'Encargado', exact: true }).check();
  await capture(page, testInfo.project.name, 'unified-google-form');
  await expect(page.locator('.management-shell input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel('Confirmar PIN del empleado', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ pin: null, inviteWithGoogle: true });
  await assertNoOperatorSecrets(page);
});

test('the owner creates employee access and invitations with assigned roles', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Empleados', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Empleados' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'team-management');
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Nueva cajera');
  await page.getByRole('radio', { name: 'Cajero', exact: true }).check();
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
  await page.getByRole('radio', { name: 'Encargado', exact: true }).check();
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Administrar Cajera actualizada', exact: true })).toBeVisible();
  await expect(page.getByText('Encargado. Invitación pendiente', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Nueva cocina');
  await page.getByRole('radio', { name: 'Cocina', exact: true }).check();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await expect(page.getByLabel('Enlace de invitación', { exact: true })).toHaveValue(`http://127.0.0.1:5174/#invite=${fixtureInvitation}`);
  await page.getByRole('button', { name: 'Administrar empleado', exact: true }).click();
  await page.getByRole('button', { name: 'Cancelar invitación', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelar invitación', exact: true })).not.toBeVisible();
  await expect(page.getByText('Invitación cancelada', { exact: true })).toBeVisible();
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Nueva cajera', role: 'cashier', pin: null });
  expect(calls.find((call) => call.action === 'update_employee')).toMatchObject({ name: 'Cajera actualizada', role: 'manager', active: true, pin: null });
  expect(calls.filter((call) => call.action === 'create_employee')[1]).toMatchObject({ name: 'Nueva cocina', role: 'kitchen', pin: null, inviteWithGoogle: true });
  expect(calls.filter((call) => call.action === 'create_invitation')).toHaveLength(0);
  await page.getByRole('button', { name: 'Volver a empleados', exact: true }).click();
  await page.getByRole('button', { name: 'Volver a Más', exact: true }).click();
  await page.getByRole('button', { name: 'Dispositivos de caja', exact: true }).click();
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByLabel('Código para vincular dispositivo', { exact: true })).toHaveValue(fixturePairingCode);
  await assertNoOperatorSecrets(page);
});

test('employee pairing, PIN switch and reload keep only the restricted device credential', async ({ page }, testInfo) => {
  const fixture = await mockOnboarding(page, { authenticated: false });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Entrar como empleado', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar como empleado', exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'employee-pairing');
  await page.getByLabel('Código para vincular dispositivo', { exact: true }).fill('ff'.repeat(32));
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Tablet mostrador');
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/código/i);
  await page.getByLabel('Código para vincular dispositivo', { exact: true }).fill(fixturePairingCode);
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  await capture(page, testInfo.project.name, 'employee-roster');
  await page.getByRole('button', { name: fixtureCashier.name, exact: true }).click();
  await expect(page.getByLabel('PIN del empleado', { exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'employee-pin');
  await page.getByLabel('PIN del empleado', { exact: true }).fill('999999');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/PIN/i);
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible();
  await expect(page.getByText(fixtureBusiness.name, { exact: true }).first()).toBeVisible();
  const priorOperator = fixture.deviceOperator();
  await openMore(page);
  await page.getByRole('button', { name: 'Cambiar empleado', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  expect(fixture.calls.find((call) => call.action === 'device_lock')).toMatchObject({ operatorToken: priorOperator });
  await page.getByRole('button', { name: fixtureKitchen.name, exact: true }).click();
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixturePin);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Comandas', exact: true })).toBeVisible();
  expect(fixture.deviceOperator()).not.toBe(priorOperator);
  const nextOperator = fixture.deviceOperator();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).not.toBeVisible();
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
  await page.goto('/employee');
  await page.getByLabel('Código para vincular dispositivo', { exact: true }).fill(fixturePairingCode);
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Tablet revocable');
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Elige tu nombre' })).toBeVisible();
  fixture.revokeDevice();
  await page.getByRole('button', { name: fixtureCashier.name, exact: true }).click();
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar como empleado', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText(/revocado|vincular/i);
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).not.toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(fixtureDeviceToken);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Entrar como empleado', exact: true })).toBeVisible();
});

async function fillAccountPin(page: Page, pin = fixturePin) {
  await page.getByTestId('pin-input').fill(pin);
  await page.getByTestId('pin-confirm-input').fill(pin);
}

async function unlockOwner(page: Page, pin = fixturePin, destination = 'Venta') {
  await page.getByTestId('pin-input').fill(pin);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: destination, exact: true })).toBeVisible();
}

async function openMore(page: Page) {
  await page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('button', { name: 'Más', exact: true }).click();
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
