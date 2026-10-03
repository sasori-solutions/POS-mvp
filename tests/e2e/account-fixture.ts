import type { Page } from '@playwright/test';
import { businessPermissions } from '../../src/lib/contracts';

export const fixtureBusiness = {
  id: '8be7bbee-3947-478c-a2d2-02a6ee44432b',
  name: 'Café de prueba',
  businessType: 'cafe',
  canRecoverPin: true,
  recoveryReady: true,
  timezone: 'America/Mexico_City',
  currency: 'MXN',
  role: 'owner',
  permissions: [...businessPermissions],
  createdAt: '2026-10-01T12:00:00.000Z',
  profile: {
    branchName: 'Sucursal principal',
    registerName: 'Caja 1',
    address: '',
    city: '',
    state: '',
    contactPhone: '',
    paymentMethods: ['cash', 'card_external'],
  },
};

export const fixturePin = '583927';
export const fixtureOperatorToken = 'a7'.repeat(32);
export const fixtureAuthKey = 'pos-mexico-auth';
const fixtureUser = {
  id: '1796c0f3-39f4-45c9-a70c-a978c82d4b03',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'fixture@example.test',
  app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { full_name: 'Persona de prueba' },
  created_at: '2026-10-01T12:00:00.000Z',
  identities: [{ provider: 'google', identity_id: 'test-google-identity' }],
};

export type FixtureAuthLogoutState = {
  revokedTokens: Set<string>;
  responses: { authorization: string | undefined; status: number; errorCode?: string }[];
};

export function fixtureAuthSession(overrides: Record<string, unknown> = {}, sessionId = '4653a47d-0b0c-46b6-afc6-de40245d04ab') {
  const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: fixtureUser.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: fixtureUser.email,
    exp: expiresAt,
    session_id: sessionId,
  })).toString('base64url');
  return {
    access_token: `${header}.${payload}.test-browser-fixture-signature`,
    refresh_token: 'test-browser-fixture-refresh-token',
    token_type: 'bearer',
    expires_in: 3_600,
    expires_at: expiresAt,
    user: fixtureUser,
    ...overrides,
  };
}

/** This harness mocks network state only; production contains no test login route. */
export async function mockAccount(page: Page, options: {
  existingBusiness?: boolean;
  authenticated?: boolean;
  createResponseLosses?: number;
  sessionOverrides?: Record<string, unknown>;
  revokeSessionAuthRequired?: boolean;
  authLogoutFailureStatus?: 400 | 401 | 403 | 404;
  authLogoutFailureCode?: string;
  authLogoutNetworkFailure?: boolean;
  authLogoutState?: FixtureAuthLogoutState;
} = {}) {
  const calls: Record<string, unknown>[] = [];
  const authCalls: { url: string; authorization: string | undefined }[] = [];
  let hasBusiness = options.existingBusiness ?? false;
  let locked = true;
  let wrongAttempts = 0;
  let createResponseLosses = options.createResponseLosses ?? 0;

  if (options.authenticated ?? true) {
    const session = fixtureAuthSession(options.sessionOverrides);
    await page.addInitScript(({ key, value }) => {
      if (!sessionStorage.getItem('test-auth-initialized')) {
        localStorage.setItem(key, JSON.stringify(value));
        sessionStorage.setItem('test-auth-initialized', 'true');
      }
    }, { key: fixtureAuthKey, value: session });
  }

  await page.route('http://127.0.0.1:54321/auth/v1/**', async (route) => {
    const request = route.request();
    authCalls.push({ url: request.url(), authorization: request.headers().authorization });
    if (request.url().includes('/logout')) {
      if (options.authLogoutNetworkFailure) return route.abort('failed');
      if (options.authLogoutFailureStatus) {
        await route.fulfill({
          status: options.authLogoutFailureStatus,
          contentType: 'application/json',
          body: JSON.stringify({ error_code: options.authLogoutFailureCode ?? 'bad_jwt', msg: 'Authentication logout rejected.' }),
        });
        return;
      }
      const state = options.authLogoutState;
      const authorization = request.headers().authorization;
      if (state && authorization && state.revokedTokens.has(authorization)) {
        state.responses.push({ authorization, status: 403, errorCode: 'session_not_found' });
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error_code: 'session_not_found', msg: 'Session not found' }),
        });
      }
      if (state && authorization) {
        state.revokedTokens.add(authorization);
        state.responses.push({ authorization, status: 204 });
      }
      locked = true;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixtureUser) });
  });

  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    calls.push(body);
    const reply = (data: unknown) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data }),
    });
    const reject = (status: number, code: string, message: string, retryAfterSeconds?: number) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message, retryAfterSeconds } }),
    });
    const unlocked = {
      business: fixtureBusiness,
      operatorToken: fixtureOperatorToken,
      expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    };
    switch (body.action) {
    case 'pos':
        if (body.command === 'catalog') return reply({ products: [], paymentMethods: ['cash', 'card_external', 'transfer'] });
        if (body.command === 'sales') return reply({ sales: [], nextCursor: null });
        return reject(400, 'VALIDATION_ERROR', 'Acción inválida.');
      case 'notifications': return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { notifications: [], unreadCount: 0 } }) });
      case 'status':
        return reply({ businesses: hasBusiness ? [{ id: fixtureBusiness.id, name: fixtureBusiness.name, businessType: fixtureBusiness.businessType, role: fixtureBusiness.role }] : [] });
      case 'create_business':
        hasBusiness = true;
        locked = false;
        if (createResponseLosses > 0) {
          createResponseLosses -= 1;
          return route.abort('failed');
        }
        return reply(unlocked);
      case 'unlock':
        if (body.pin !== fixturePin) {
          wrongAttempts += 1;
          return wrongAttempts >= 5
            ? reject(429, 'PIN_LOCKED', 'Demasiados intentos. Intenta de nuevo en 15 minutos.', 900)
            : reject(401, 'PIN_INVALID', 'PIN incorrecto. Intenta de nuevo.');
        }
        locked = false;
        return reply(unlocked);
      case 'context':
        return locked
          ? reject(401, 'SESSION_INVALID', 'La sesión está bloqueada.')
          : reply({ business: fixtureBusiness, expiresAt: unlocked.expiresAt });
      case 'lock':
        locked = true;
        return reply({ locked: true });
      case 'revoke_sessions':
        locked = true;
        if (options.revokeSessionAuthRequired) return reject(401, 'AUTH_REQUIRED', 'Sign in to continue.');
        return reply({ revoked: true });
      default:
        return reject(400, 'VALIDATION_ERROR', 'Acción inválida.');
    }
  });

  return { calls, authCalls };
}
