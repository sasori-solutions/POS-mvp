import { expect, test } from '@playwright/test';
import { fixtureAuthKey, fixtureAuthSession, fixtureBusiness, fixtureOperatorToken, fixturePin, mockAccount } from './account-fixture';

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
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  expect(calls.some((call) => call.action === 'lock')).toBe(true);
  await page.getByTestId('pin-input').fill('111111');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/PIN/i);
  await page.getByTestId('pin-input').fill(fixturePin);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
  await assertNoPersistedOperatorSecrets(page);
});

test('refresh requires the PIN again while the Google account stays signed in', async ({ page }) => {
  await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await page.getByTestId('pin-input').fill(fixturePin);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).not.toBeVisible();
  await assertNoPersistedOperatorSecrets(page);
});

test('a lost business-creation response can be retried with the same operation id', async ({ page }) => {
  const { calls } = await mockAccount(page, { createResponseLosses: 1 });
  await page.goto('/');
  await page.getByLabel('Nombre del negocio').fill(fixtureBusiness.name);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await page.getByTestId('pin-input').fill(fixturePin);
  await page.getByTestId('pin-confirm-input').fill(fixturePin);
  await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).not.toBeVisible();
  await page.getByTestId('pin-input').fill(fixturePin);
  await page.getByTestId('pin-confirm-input').fill(fixturePin);
  await page.getByRole('button', { name: 'Crear PIN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
  const attempts = calls.filter((call) => call.action === 'create_business');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.operationId).toBe(attempts[0]?.operationId);
});

test('PIN lockout reports the wait and prevents further immediate attempts', async ({ page }) => {
  const { calls } = await mockAccount(page, { existingBusiness: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByTestId('pin-input').fill('111111');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect.poll(() => calls.filter((call) => call.action === 'unlock').length).toBe(attempt + 1);
  }
  await expect(page.getByRole('alert')).toContainText(/15|minut|intentos/i);
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeDisabled();
});

test('the initial screen is usable by keyboard and fits the viewport', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('main')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
    await tab.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(tab.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Bloquear', exact: true }).click();
  await expect(otherTab.getByRole('heading', { name: 'Ingresa tu PIN' })).toBeVisible();
  await otherTab.getByTestId('pin-input').fill(fixturePin);
  await otherTab.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(otherTab.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeEnabled();
    await page.getByTestId('pin-input').fill(fixturePin);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
    heldAction = 'revoke_sessions';
    seen = new Promise<void>((resolve) => { markSeen = resolve; });
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
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
  await expect(page.getByLabel('Nombre del negocio')).toBeVisible();
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
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
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
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), fixtureAuthKey)).toBeNull();
  await expect.poll(() => authCalls.some((request) => request.url.includes('/logout'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Continuar con Google' })).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('No pudimos confirmar el cierre en el servidor');
  await expect(page.getByRole('heading', { name: 'Tu negocio está listo' })).not.toBeVisible();
  await assertNoPersistedOperatorSecrets(page);
});

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
