import { submitPinIfPresent } from './workspace-flow'
import { ownerAccountMenu } from './workspace-flow'
import { expect, test } from '@playwright/test';
import { fixtureAuthKey, fixtureAuthSession, fixtureBusiness, fixtureOperatorToken, fixturePin, mockAccount, type FixtureAuthLogoutState } from './account-fixture';

test.beforeEach(async ({ page }) => {
  await allowOnlyLoopbackRequests(page);
});

test('login offers Google OAuth and starts the Google authorization flow', async ({ page }, testInfo) => {
  await page.goto('/login');
  const google = page.getByRole('button', { name: 'Continuar con Google' });
  await expect(google).toBeVisible();
  await page.screenshot({ path: `/tmp/pos-mexico-${testInfo.project.name}-login.png`, fullPage: true });
  const navigation = page.waitForRequest((request) =>
    request.url().includes('/auth/v1/authorize') && new URL(request.url()).searchParams.get('provider') === 'google');
  await page.route('http://127.0.0.1:54321/auth/v1/authorize**', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'OAuth destination captured by test' }));
  await google.click();
  const request = await navigation;
  expect(new URL(request.url()).searchParams.get('redirect_to')).toContain('http://127.0.0.1:5174');
});

test('development login route stays disabled without the local authentication flag', async ({ page }) => {
  await page.goto('/dev-login');
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Acceso de desarrollo' })).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Entrar en desarrollo' })).not.toBeVisible();
});

test('business creation, PIN confirmation, lock, unlock and logout', async ({ page }, testInfo) => {
  const { calls } = await mockAccount(page);
  await page.goto('/business/new');
  await page.getByLabel('Nombre del negocio').fill(fixtureBusiness.name);
  await page.getByLabel('Tipo de negocio').selectOption('cafe');
  await page.getByLabel('Zona horaria').selectOption('America/Mexico_City');
  await page.screenshot({ path: `/tmp/pos-mexico-${testInfo.project.name}-business.png`, fullPage: true });
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  const pin = page.getByTestId('pin-input');
  const confirmation = page.getByTestId('pin-confirm-input');
  await expect(pin).toHaveAttribute('type', 'password');
  await pin.fill(fixturePin);
  await page.screenshot({ path: `/tmp/pos-mexico-${testInfo.project.name}-pin.png`, fullPage: true });
  await confirmation.fill('111111');
  await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(0);
  await confirmation.fill(fixturePin);
  await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cuenta creada' })).toBeVisible();
  await expect(page).toHaveURL(/\/business\/ready$/);
  await page.screenshot({ path: `/tmp/pos-mexico-${testInfo.project.name}-ready.png`, fullPage: true });
  const create = calls.find((call) => call.action === 'create_business');
  expect(create).toMatchObject({
    name: fixtureBusiness.name,
    businessType: 'cafe',
    timezone: 'America/Mexico_City',
    pin: fixturePin,
  });
  expect(create?.operationId).toMatch(/^[0-9a-f-]{36}$/);
  await assertNoPersistedOperatorSecrets(page);
  await expect(page.getByRole('button', { name: 'Ir al inicio', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ir al inicio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:5174/');
  await expect(page.getByRole('heading', { name: 'Cuenta creada' })).not.toBeVisible();
  await expect(page.getByText(fixtureBusiness.name, { exact: true }).first()).toBeVisible();
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(1);
  await page.screenshot({ path: `/tmp/pos-mexico-${testInfo.project.name}-home.png`, fullPage: true });
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await expect.poll(() => calls.some((call) => call.action === 'lock')).toBe(true);
  await page.getByTestId('pin-input').fill('111111');
  await submitPinIfPresent(page);
  await expect(page.getByRole('alert')).toContainText(/PIN/i);
  await page.getByTestId('pin-input').fill(fixturePin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ir al inicio', exact: true })).not.toBeVisible();
  await logoutFromHome(page);
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
  await assertNoPersistedOperatorSecrets(page);
});

test('refresh requires the PIN again while the Google account stays signed in', async ({ page }) => {
  await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await page.getByTestId('pin-input').fill(fixturePin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).not.toBeVisible();
  await assertNoPersistedOperatorSecrets(page);
});

test('a lost business-creation response can be retried with the same operation id', async ({ page }) => {
  const { calls } = await mockAccount(page, { createResponseLosses: 1 });
  await page.goto('/business/new');
  await page.getByLabel('Nombre del negocio').fill(fixtureBusiness.name);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByTestId('pin-input').fill(fixturePin);
  await page.getByTestId('pin-confirm-input').fill(fixturePin);
  await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cuenta creada' })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Ir al inicio', exact: true })).not.toBeVisible();
  await page.getByTestId('pin-input').fill(fixturePin);
  await page.getByTestId('pin-confirm-input').fill(fixturePin);
  await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cuenta creada' })).toBeVisible();
  const attempts = calls.filter((call) => call.action === 'create_business');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId);
  await page.getByRole('button', { name: 'Ir al inicio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(2);
});

test('business creation exposes the home transition only after the API succeeds', async ({ page }) => {
  const { calls } = await mockAccount(page);
  let release: (() => void) | undefined;
  let markSeen: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => { markSeen = resolve; });
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action === 'create_business') {
      markSeen?.();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    await route.fallback();
  });
  await page.goto('/business/new');
  await page.getByLabel('Nombre del negocio').fill(fixtureBusiness.name);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByTestId('pin-input').fill(fixturePin);
  await page.getByTestId('pin-confirm-input').fill(fixturePin);
  try {
    await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
    await seen;
    await expect(page.getByRole('heading', { name: 'Cuenta creada' })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Ir al inicio', exact: true })).not.toBeVisible();
    release?.();
  await expect(page.getByRole('heading', { name: 'Cuenta creada' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).not.toBeVisible();
    const home = page.getByRole('button', { name: 'Ir al inicio', exact: true });
    await home.focus();
    await expect(home).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
    await expect(page.getByText(fixtureBusiness.name, { exact: true }).first()).toBeVisible();
    expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(1);
    expect(calls.filter((call) => call.action === 'unlock')).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await assertNoPersistedOperatorSecrets(page);
    await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    await expect.poll(() => calls.find((call) => call.action === 'lock')).toMatchObject({
      businessId: fixtureBusiness.id, operatorToken: fixtureOperatorToken,
    });
  } finally {
    release?.();
  }
});

test('PIN lockout reports the wait and prevents further immediate attempts', async ({ page }) => {
  const { calls } = await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByTestId('pin-input').fill('111111');
    await submitPinIfPresent(page);
    await expect(page.getByRole(attempt < 4 ? 'alert' : 'timer')).toBeVisible();
    await expect.poll(() => calls.filter((call) => call.action === 'unlock').length).toBe(attempt + 1);
  }
  await expect(page.getByRole('timer')).toContainText('15:00');
  await expect(page.getByTestId('pin-input')).toBeDisabled();
});

test('private entry URLs keep signed-out users on the keyboard-accessible login screen', async ({ page }) => {
  for (const path of ['/', '/business/ready']) {
    await page.goto(path);
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cuenta creada' })).not.toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).not.toBeVisible();
  }
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ir al contenido' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('home navigation is keyboard-accessible and preserves the unlocked business', async ({ page }, testInfo) => {
  const { calls } = await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  await page.getByTestId('pin-input').fill(fixturePin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ir al inicio', exact: true })).not.toBeVisible();
  const menu = page.getByRole('button', {name:'Abrir menú'}); if (await menu.isVisible()) await menu.click();
  const navigation = page.getByRole('navigation', { name: 'Navegación del dueño' }).filter({visible:true}).first();
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Inicio', exact: true })).toHaveAttribute('aria-current', 'page');
  await navigation.getByRole('button', { name: 'Productos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Productos', exact: true })).toBeVisible();
  for (const label of ['Ventas', 'Productos', 'Caja', 'Reportes']) {
    if (await menu.isVisible()) await menu.click();
    const target = navigation.getByRole('button', { name: label, exact: true });
    await target.focus();
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    await expect(target).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText(fixtureBusiness.name, { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.screenshot({ path: `/tmp/pos-mexico-${testInfo.project.name}-home-more.png`, fullPage: true });
  expect(calls.filter((call) => call.action === 'unlock')).toHaveLength(1);
  expect(calls.filter((call) => call.action === 'create_business')).toHaveLength(0);
  await assertNoPersistedOperatorSecrets(page);
  if (await menu.isVisible()) await page.getByRole('button',{name:'Cerrar menú'}).click();
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await expect(navigation).not.toBeVisible();
  await expect.poll(() => calls.find((call) => call.action === 'lock')).toMatchObject({
    businessId: fixtureBusiness.id, operatorToken: fixtureOperatorToken,
  });
});

test('locking and signing out also closes unlocked views in another tab', async ({ page }) => {
  await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  const otherTab = await page.context().newPage();
  await allowOnlyLoopbackRequests(otherTab);
  await mockAccount(otherTab, { existingBusiness: true, authenticated: false });
  await otherTab.goto('/');
  for (const tab of [page, otherTab]) {
    await expect(tab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    await tab.getByTestId('pin-input').fill(fixturePin);
    await submitPinIfPresent(tab);
    await expect(tab.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await expect(otherTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await otherTab.getByTestId('pin-input').fill(fixturePin);
  await submitPinIfPresent(otherTab);
  await expect(otherTab.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  await expect(otherTab.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  await assertNoPersistedOperatorSecrets(otherTab);
  await otherTab.close();
});

test('lock and logout close the local screen before delayed server revocation completes', async ({ page }) => {
  await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  await page.getByTestId('pin-input').fill(fixturePin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  let heldAction = 'lock';
  let release: (() => void) | undefined;
  let markSeen: (() => void) | undefined;
  let seen = new Promise<void>((resolve) => { markSeen = resolve; });
  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().postDataJSON()?.action === heldAction) {
      markSeen?.();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    await route.fallback();
  });
  try {
    await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
    await seen;
    await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible({ timeout: 1_000 });
    release?.();
    await expect(page.getByTestId('pin-input')).toBeEnabled();
    await page.getByTestId('pin-input').fill(fixturePin);
    await submitPinIfPresent(page);
    await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
    heldAction = 'revoke_sessions';
    seen = new Promise<void>((resolve) => { markSeen = resolve; });
    await logoutFromHome(page);
    await seen;
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible({ timeout: 1_000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
    release?.();
  } finally {
    release?.();
  }
});

test('a Google callback cancelled by logout cannot sign the app back in', async ({ page }) => {
  const { authCalls } = await mockAccount(page, { authenticated: false });
  const returnedSession = fixtureAuthSession();
  let releaseExchange: (() => void) | undefined;
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', async (route) => {
    await new Promise<void>((resolve) => { releaseExchange = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(returnedSession) });
  });
  await startGoogleCallback(page);
  try {
    await expect.poll(() => typeof releaseExchange).toBe('function');
    await page.evaluate(() => {
      const channel = new BroadcastChannel('pos-mexico-session');
      channel.postMessage('logout');
      setTimeout(() => channel.close(), 50);
    });
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
    releaseExchange?.();
    await expect.poll(() => authCalls.some((request) =>
      request.url.includes('/logout') && request.authorization === `Bearer ${returnedSession.access_token}`)).toBe(true);
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
    await expect(page.getByLabel('Nombre del negocio')).not.toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
    const verifiers = await page.evaluate((key) => Object.keys(localStorage)
      .filter((storedKey) => storedKey.startsWith(key) && storedKey.endsWith('-code-verifier')), fixtureAuthKey);
    expect(verifiers).toEqual([]);
  } finally {
    releaseExchange?.();
  }
});

test('Google provider tokens are omitted from persisted OAuth sessions', async ({ page }) => {
  await mockAccount(page, { authenticated: false });
  const returnedSession = fixtureAuthSession({
    provider_token: 'fixture-google-provider-token',
    provider_refresh_token: 'fixture-google-provider-refresh',
  });
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(returnedSession) }));
  await startGoogleCallback(page);
  await expect(page.getByRole('heading', { name: '¿Qué quieres hacer?' })).toBeVisible();
  await assertNoPersistedGoogleProviderTokens(page);
});

test('previously stored Google provider tokens are removed when a session is recovered', async ({ page }) => {
  await mockAccount(page, { existingBusiness: true, sessionOverrides: {
    provider_token: 'fixture-google-provider-token',
    provider_refresh_token: 'fixture-google-provider-refresh',
  } });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await assertNoPersistedGoogleProviderTokens(page);
});

test('a completed authentication logout is successful when operator revocation races with it', async ({ page }) => {
  const { authCalls } = await mockAccount(page, { existingBusiness: true, revokeSessionAuthRequired: true });
  await page.goto('/');
  await page.getByTestId('pin-input').fill(fixturePin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  await logoutFromHome(page);
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  await expect.poll(() => authCalls.some((request) => request.url.includes('/logout'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
  await expect(page.getByRole('alert')).not.toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
});

test('a rejected authentication logout clears locally and reports unconfirmed server closure', async ({ page }) => {
  const { authCalls } = await mockAccount(page, { existingBusiness: true, authLogoutFailureStatus: 403 });
  await page.goto('/');
  await page.getByTestId('pin-input').fill(fixturePin);
  await submitPinIfPresent(page);
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).toBeVisible();
  await logoutFromHome(page);
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
  await expect.poll(() => authCalls.some((request) => request.url.includes('/logout'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('No pudimos confirmar el cierre en el servidor');
  await expect(page.getByRole('heading', { name: 'Inicio', exact: true })).not.toBeVisible();
  await assertNoPersistedOperatorSecrets(page);
});

test('two tabs can log out the same identity without warning when its session is already revoked', async ({ page }) => {
  const state: FixtureAuthLogoutState = { revokedTokens: new Set(), responses: [] };
  await deferLogoutBroadcasts(page);
  await mockAccount(page, { existingBusiness: true, authLogoutState: state });
  await page.goto('/');
  const otherTab = await page.context().newPage();
  await allowOnlyLoopbackRequests(otherTab);
  await deferLogoutBroadcasts(otherTab);
  await mockAccount(otherTab, { existingBusiness: true, authenticated: false, authLogoutState: state });
  await otherTab.goto('/');
  try {
    for (const tab of [page, otherTab]) {
      await expect(tab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    }
    await otherTab.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await expect.poll(() => state.responses.length).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await expect.poll(() => state.responses.length).toBeGreaterThanOrEqual(2);
    expect(state.responses.slice(0, 2).map((response) => response.status)).toEqual([204, 403]);
    expect(state.responses[1]?.errorCode).toBe('session_not_found');
    expect(state.responses[0]?.authorization).toBe(state.responses[1]?.authorization);
    for (const tab of [page, otherTab]) {
      await expect(tab.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
      await expect(tab.getByRole('alert')).not.toBeVisible();
      expect(await tab.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
      await assertNoPersistedOperatorSecrets(tab);
    }
  } finally {
    for (const tab of [page, otherTab]) await tab.evaluate(() => window.dispatchEvent(new Event('release-test-broadcasts')));
    await otherTab.close();
  }
});

test('an old logged-out tab preserves a fresh Google login from another tab', async ({ page }) => {
  const { authCalls } = await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
  await page.evaluate((key) => {
    const observed: string[] = [];
    Object.defineProperty(window, 'testObservedSignIns', { value: observed });
    const observer = new BroadcastChannel(key);
    observer.onmessage = (event: MessageEvent<{ event?: string; session?: { access_token?: string } }>) => {
      if (event.data.event === 'SIGNED_IN' && event.data.session?.access_token) observed.push(event.data.session.access_token);
    };
  }, fixtureAuthKey);
  const freshTab = await page.context().newPage();
  await allowOnlyLoopbackRequests(freshTab);
  await mockAccount(freshTab, { existingBusiness: true, authenticated: false });
  const freshSession = fixtureAuthSession({}, 'b52751b2-dba9-4f91-a6c4-b26042f4a8ae');
  await freshTab.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(freshSession) }));
  try {
    await startGoogleCallback(freshTab);
    await expect.poll(() => page.evaluate((token) =>
      (window as unknown as { testObservedSignIns: string[] }).testObservedSignIns.includes(token), freshSession.access_token)).toBe(true);
    expect(authCalls.filter((request) => request.url.includes('/logout') &&
      request.authorization === `Bearer ${freshSession.access_token}`)).toEqual([]);
    await expect.poll(() => freshTab.evaluate((key) => {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored).access_token : null;
    }, fixtureAuthKey)).toBe(freshSession.access_token);
    await expect(freshTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    await freshTab.reload();
    await expect(freshTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    expect(authCalls.filter((request) => request.url.includes('/logout') &&
      request.authorization === `Bearer ${freshSession.access_token}`)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
    await assertNoPersistedOperatorSecrets(freshTab);
  } finally {
    await freshTab.close();
  }
});

test('a cancelled late Google callback preserves another tab fresh session while revoking its own identity', async ({ page }) => {
  const { authCalls } = await mockAccount(page, { authenticated: false });
  const lateSession = fixtureAuthSession();
  let releaseExchange: (() => void) | undefined;
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', async (route) => {
    await new Promise<void>((resolve) => { releaseExchange = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(lateSession) });
  });
  await startGoogleCallback(page);
  await expect.poll(() => typeof releaseExchange).toBe('function');
  await page.evaluate(() => {
    const channel = new BroadcastChannel('pos-mexico-session');
    channel.postMessage('logout');
    setTimeout(() => channel.close(), 50);
  });
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  const freshTab = await page.context().newPage();
  await allowOnlyLoopbackRequests(freshTab);
  // Isolate late local cleanup from the separate incoming SIGNED_IN regression.
  await deferLogoutBroadcasts(freshTab);
  await mockAccount(freshTab, { existingBusiness: true, authenticated: false });
  const freshSession = fixtureAuthSession({}, '38f34fe0-11c4-4bd5-a856-73c00eb6189d');
  await freshTab.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(freshSession) }));
  try {
    await startGoogleCallback(freshTab);
    await expect(freshTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    releaseExchange?.();
    await expect.poll(() => authCalls.some((request) => request.url.includes('/logout') &&
      request.authorization === `Bearer ${lateSession.access_token}`)).toBe(true);
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
    expect(authCalls.filter((request) => request.url.includes('/logout') &&
      request.authorization === `Bearer ${freshSession.access_token}`)).toEqual([]);
    expect(await freshTab.evaluate((key) => {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored).access_token : null;
    }, fixtureAuthKey)).toBe(freshSession.access_token);
    await freshTab.reload();
    await expect(freshTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    await assertNoPersistedOperatorSecrets(freshTab);
  } finally {
    releaseExchange?.();
    await freshTab.evaluate(() => window.dispatchEvent(new Event('release-test-broadcasts')));
    await freshTab.close();
  }
});

test('a cancelled old Google callback leaves another tab pending PKCE verifier intact', async ({ page }) => {
  const { authCalls } = await mockAccount(page, { authenticated: false });
  const lateSession = fixtureAuthSession();
  let releaseOld: (() => void) | undefined;
  let releaseFresh: (() => void) | undefined;
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', async (route) => {
    await new Promise<void>((resolve) => { releaseOld = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(lateSession) });
  });
  await startGoogleCallback(page);
  await expect.poll(() => typeof releaseOld).toBe('function');
  await page.evaluate(() => {
    const channel = new BroadcastChannel('pos-mexico-session');
    channel.postMessage('logout');
    setTimeout(() => channel.close(), 50);
  });
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  const freshTab = await page.context().newPage();
  await allowOnlyLoopbackRequests(freshTab);
  await mockAccount(freshTab, { existingBusiness: true, authenticated: false });
  const freshSession = fixtureAuthSession({}, 'afca1b56-a3b0-4cd6-8890-251ba5c52e4b');
  await freshTab.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', async (route) => {
    await new Promise<void>((resolve) => { releaseFresh = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(freshSession) });
  });
  try {
    await startGoogleCallback(freshTab);
    await expect.poll(() => typeof releaseFresh).toBe('function');
    const before = await freshTab.evaluate((key) => Object.entries(localStorage)
      .filter(([name]) => name.startsWith(key) && name.endsWith('-code-verifier')), fixtureAuthKey);
    expect(before).not.toEqual([]);
    releaseOld?.();
    await expect.poll(() => authCalls.some((request) => request.url.includes('/logout') &&
      request.authorization === `Bearer ${lateSession.access_token}`)).toBe(true);
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
    const after = await freshTab.evaluate((key) => Object.entries(localStorage)
      .filter(([name]) => name.startsWith(key) && name.endsWith('-code-verifier')), fixtureAuthKey);
    expect(after).toEqual(before);
    releaseFresh?.();
    await expect(freshTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    await freshTab.reload();
    await expect(freshTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    expect(authCalls.filter((request) => request.url.includes('/logout') &&
      request.authorization === `Bearer ${freshSession.access_token}`)).toEqual([]);
  } finally {
    releaseOld?.();
    releaseFresh?.();
    await freshTab.close();
  }
});

for (const failure of [
  { name: 'an unrelated 400 error', options: { authLogoutFailureStatus: 400 as const, authLogoutFailureCode: 'unknown_error' } },
  { name: 'a network failure', options: { authLogoutNetworkFailure: true } },
]) {
  test(`authentication logout with ${failure.name} still reports unconfirmed server closure`, async ({ page }) => {
    await mockAccount(page, { existingBusiness: true, ...failure.options });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('No pudimos confirmar el cierre en el servidor');
    expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
    await assertNoPersistedOperatorSecrets(page);
  });
}

test('failed revocation of a cancelled OAuth callback reports unconfirmed server closure', async ({ page }) => {
  const { authCalls } = await mockAccount(page, { authenticated: false, authLogoutFailureStatus: 403 });
  const returnedSession = fixtureAuthSession();
  let releaseExchange: (() => void) | undefined;
  await page.route('http://127.0.0.1:54321/auth/v1/token?grant_type=pkce', async (route) => {
    await new Promise<void>((resolve) => { releaseExchange = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(returnedSession) });
  });
  await startGoogleCallback(page);
  try {
    await expect.poll(() => typeof releaseExchange).toBe('function');
    await page.evaluate(() => {
      const channel = new BroadcastChannel('pos-mexico-session');
      channel.postMessage('logout');
      setTimeout(() => channel.close(), 50);
    });
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
    releaseExchange?.();
    await expect.poll(() => authCalls.some((request) =>
      request.url.includes('/logout') && request.authorization === `Bearer ${returnedSession.access_token}`)).toBe(true);
    await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('No pudimos confirmar el cierre en el servidor');
    expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
    await expect(page.getByLabel('Nombre del negocio')).not.toBeVisible();
  } finally {
    releaseExchange?.();
  }
});

async function startGoogleCallback(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.route('http://127.0.0.1:54321/auth/v1/authorize**', (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'Google OAuth captured by test' }));
  const authorize = page.waitForRequest((request) => request.url().includes('/auth/v1/authorize'));
  await page.getByRole('button', { name: 'Continuar con Google' }).click();
  await authorize;
  const exchange = page.waitForRequest((request) => request.url().includes('/auth/v1/token?grant_type=pkce'));
  await page.goto('/auth/callback?code=fixture-code');
  await exchange;
}

async function logoutFromHome(page: import('@playwright/test').Page) {
  await ownerAccountMenu(page);
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
}

async function deferLogoutBroadcasts(page: import('@playwright/test').Page) {
  // Both users initiate logout before cross-tab notifications are delivered.
  await page.addInitScript(() => {
    const Original = window.BroadcastChannel;
    const pending: (() => void)[] = [];
    window.BroadcastChannel = class extends Original {
      override postMessage(message: unknown) { pending.push(() => super.postMessage(message)); }
    };
    window.addEventListener('release-test-broadcasts', () => {
      for (const send of pending.splice(0)) send();
    });
  });
}

async function assertNoPersistedGoogleProviderTokens(page: import('@playwright/test').Page) {
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(stored).not.toContain('fixture-google-provider-token');
  expect(stored).not.toContain('fixture-google-provider-refresh');
  expect(stored).not.toContain('provider_token');
  expect(stored).not.toContain('provider_refresh_token');
}

async function allowOnlyLoopbackRequests(page: import('@playwright/test').Page) {
  // Guard every tab even if a developer has cloud credentials in .env.local.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
}

async function assertNoPersistedOperatorSecrets(page: import('@playwright/test').Page) {
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(localStorage)),
    session: JSON.stringify(Object.entries(sessionStorage)),
  }));
  for (const storage of Object.values(stored)) {
    expect(storage).not.toContain(fixturePin);
    expect(storage).not.toContain(fixtureOperatorToken);
  }
}
