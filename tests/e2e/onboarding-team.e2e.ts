import { expect, test, type Page } from '@playwright/test';
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
  await expect(page.getByRole('heading', { name: 'Cuenta creada' })).toBeVisible();
  const create = calls.find((call) => call.action === 'create_business');
  expect(create).toMatchObject({ profile: {
    branchName: 'Centro', registerName: 'Mostrador', city: 'Guadalajara', state: 'Jalisco',
    paymentMethods: ['cash', 'card_external', 'transfer'],
  } });
  await page.getByRole('button', { name: 'Ir al inicio', exact: true }).click();
  await openMore(page);
  await page.getByRole('button', { name: 'Configurar negocio', exact: true }).click();
  await expect(page.getByLabel('Sucursal', { exact: true })).toHaveValue('Centro');
  await expect(page.getByLabel(/^Ciudad/)).toHaveValue('Guadalajara');
  await page.getByLabel(/^Dirección/).fill('Calle de prueba 100');
  await page.getByLabel('Caja', { exact: true }).fill('Barra');
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Venta', exact: true })).toBeVisible();
  await page.reload();
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Configurar negocio', exact: true }).click();
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
  await expect(page.getByLabel('Rol', { exact: true })).not.toBeVisible();
  await page.getByLabel('Código de invitación', { exact: true }).fill('ff'.repeat(32));
  await page.getByLabel('Tu nombre', { exact: true }).fill('Ana de prueba');
  await page.getByLabel('PIN', { exact: true }).fill(fixturePin);
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill('111111');
  await page.getByRole('button', { name: 'Unirme', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(calls.filter((call) => call.action === 'accept_invitation')).toHaveLength(0);
  await page.getByLabel('Confirma tu PIN', { exact: true }).fill(fixturePin);
  await page.getByRole('button', { name: 'Unirme', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/invitación/i);
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).not.toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Configurar negocio', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Equipo y dispositivos', exact: true })).not.toBeVisible();
  const accept = calls.filter((call) => call.action === 'accept_invitation');
  expect(accept).toHaveLength(2);
  expect(accept[1]).toMatchObject({ invitationCode: fixtureInvitation, name: 'Ana de prueba', pin: fixturePin });
  expect(accept[1]).not.toHaveProperty('role');
  await page.reload();
  await unlockOwner(page, fixturePin, 'Comandas');
  await assertNoOperatorSecrets(page);
});

test('an invitation link survives Google redirect and is consumed after joining', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { authenticated: false });
  await page.goto(`/login#invite=${fixtureInvitation}`);
  await page.route('http://127.0.0.1:54321/auth/v1/authorize**', (route) => route.fulfill({ contentType: 'text/plain', body: 'OAuth captured' }));
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtureAuthSession()) }));
  const authorization = page.waitForRequest((request) => request.url().includes('/auth/v1/authorize'));
  await page.getByRole('button', { name: 'Continuar con Google', exact: true }).click();
  await authorization;
  await page.goto('/auth/callback?code=fixture-code');
  await expect(page.getByLabel('Código de invitación', { exact: true })).toHaveValue(fixtureInvitation);
  await expect(page).not.toHaveURL(/fixture-code|#invite=/);
  await page.getByLabel('Tu nombre', { exact: true }).fill('Ana invitada');
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
  await expect(page.getByRole('button', { name: 'Configurar negocio', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Equipo y dispositivos', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Cambiar PIN', exact: true })).not.toBeVisible();
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
  const replacementPin = '068214';
  await page.getByTestId('pin-input').fill(replacementPin);
  await page.getByTestId('pin-confirm-input').fill('999999');
  await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(calls.filter((call) => call.action === 'reset_pin')).toHaveLength(0);
  await page.getByTestId('pin-confirm-input').fill(replacementPin);
  await page.getByRole('button', { name: 'Guardar nuevo PIN', exact: true }).click();
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

test('logout while changing the owner PIN cannot reopen the recovery screen after lock completes', async ({ page }) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  let release: (() => void) | undefined;
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action === 'lock') {
      await new Promise<void>((resolve) => { release = resolve; });
    }
    await route.fallback();
  });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Cambiar PIN', exact: true }).click();
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

test('the owner creates employee access and invitations with assigned roles', async ({ page }, testInfo) => {
  const { calls } = await mockOnboarding(page, { existingBusiness: true });
  await page.goto('/');
  await unlockOwner(page);
  await openMore(page);
  await page.getByRole('button', { name: 'Equipo y dispositivos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal y dispositivos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agregar empleado', exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'team-management');
  await page.getByRole('button', { name: 'Agregar empleado', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Nueva cajera');
  await page.getByLabel('Rol', { exact: true }).selectOption('cashier');
  await expect(page.getByLabel('Rol', { exact: true }).getByRole('option', { name: /dueño/i })).toHaveCount(0);
  await page.getByLabel('PIN del empleado', { exact: true }).fill(fixtureCashierPin);
  await page.getByLabel('Confirmar PIN del empleado', { exact: true }).fill('999999');
  await page.getByRole('button', { name: 'Guardar empleado', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(calls.filter((call) => call.action === 'create_employee')).toHaveLength(0);
  await page.getByLabel('Confirmar PIN del empleado', { exact: true }).fill(fixtureCashierPin);
  await page.getByRole('button', { name: 'Guardar empleado', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Editar Nueva cajera', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Editar Nueva cajera', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Cajera desactivada');
  await page.getByLabel('Empleado activo', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Editar Cajera desactivada', exact: true })).toBeVisible();
  await expect(page.getByText('Cajero (inactivo)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Crear invitación', exact: true }).click();
  await page.getByLabel('Nombre del empleado', { exact: true }).fill('Nueva cocina');
  await page.getByLabel('Rol', { exact: true }).selectOption('kitchen');
  await page.getByRole('button', { name: 'Generar invitación', exact: true }).click();
  await expect(page.getByLabel('Código de invitación', { exact: true })).toHaveValue(fixtureInvitation);
  await page.getByRole('button', { name: 'Revocar invitación de Nueva cocina', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Revocar invitación de Nueva cocina', exact: true })).not.toBeVisible();
  expect(calls.find((call) => call.action === 'create_employee')).toMatchObject({ name: 'Nueva cajera', role: 'cashier', pin: fixtureCashierPin });
  expect(calls.find((call) => call.action === 'update_employee')).toMatchObject({ name: 'Cajera desactivada', active: false, pin: null });
  expect(calls.find((call) => call.action === 'create_invitation')).toMatchObject({ name: 'Nueva cocina', role: 'kitchen' });
  await page.getByRole('button', { name: 'Emparejar dispositivo', exact: true }).click();
  await expect(page.getByLabel('Código de emparejamiento', { exact: true })).toHaveValue(fixturePairingCode);
  await assertNoOperatorSecrets(page);
});

test('employee pairing, PIN switch and reload keep only the restricted device credential', async ({ page }, testInfo) => {
  const fixture = await mockOnboarding(page, { authenticated: false });
  await page.goto('/login');
  await page.getByRole('button', { name: 'Entrar como empleado', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar como empleado', exact: true })).toBeVisible();
  await capture(page, testInfo.project.name, 'employee-pairing');
  await page.getByLabel('Código de emparejamiento', { exact: true }).fill('ff'.repeat(32));
  await page.getByLabel('Nombre del dispositivo', { exact: true }).fill('Tablet mostrador');
  await page.getByRole('button', { name: 'Vincular dispositivo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/código/i);
  await page.getByLabel('Código de emparejamiento', { exact: true }).fill(fixturePairingCode);
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
  await page.getByLabel('Código de emparejamiento', { exact: true }).fill(fixturePairingCode);
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
