import { signedRequest } from './device-proof-fixture'
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient, isAuthSessionMissingError, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type LocalConfig = { url: string; anonKey: string; serviceRoleKey: string; dbContainer: string };
type TestAccount = { userId: string; token: string; sessionId: string; client: SupabaseClient };
type BusinessSession = {
  business: { id: string; name: string; businessType: string; timezone: string; currency: string; role: string };
  operatorToken: string;
  expiresAt: string;
};
type ApiReply<T> = { status: number; body: { data?: T; error?: { code: string; message: string; retryAfterSeconds?: number } } };

const config = loadLocalConfig();
const syntheticUserIds: string[] = [];
const syntheticBusinessIds: string[] = [];
const validPin = '583927';
let admin: SupabaseClient;
let owner: TestAccount;
let anotherOwner: TestAccount;
let lockoutOwner: TestAccount;

/** The suite can only create synthetic accounts in a loopback Supabase instance. */
describe.skipIf(!config)('account API against a real local Supabase database', () => {
  beforeAll(async () => {
    admin = createClient(config!.url, config!.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    [owner, anotherOwner, lockoutOwner] = await Promise.all([newAccount(), newAccount(), newAccount()]);
    const readiness = await account<{ businesses: unknown[] }>(owner, { action: 'status' });
    expect(readiness.status, 'Serve account with ALLOW_TEST_PASSWORD_AUTH=true in the local-only .env.functions').toBe(200);
  }, 30_000);

  afterAll(async () => {
    for (const userId of syntheticUserIds) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
    }
    if (syntheticBusinessIds.length) {
      sql(`delete from app_private.businesses where id in (${syntheticBusinessIds.map(sqlUuid).join(',')});`);
    }
  }, 30_000);

  it('rejects missing identity and malformed PINs without creating a business', async () => {
    const unauthenticated = await account(null, { action: 'status' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error?.code).toBe('AUTH_REQUIRED');
    const malformed = await account(owner, createRequest({ pin: '12345' }));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error?.code).toBe('VALIDATION_ERROR');
    const status = await account<{ businesses: unknown[] }>(owner, { action: 'status' });
    expect(status.body.data?.businesses).toEqual([]);
  });

  it('creates an owner/business/PIN atomically, retries safely, and rejects conflicting operation reuse', async () => {
    const request = createRequest();
    const created = await account<BusinessSession>(owner, request);
    expect(created.status).toBe(200);
    const first = created.body.data!;
    rememberBusiness(first.business.id);
    expect(first.business).toMatchObject({ name: request.name, businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner' });
    expect(first.operatorToken).toMatch(/^[a-f0-9]{64}$/);
    const replayed = await account<BusinessSession>(owner, request);
    expect(replayed.status).toBe(200);
    expect(replayed.body.data?.business.id).toBe(first.business.id);
    expect(replayed.body.data?.operatorToken).not.toBe(first.operatorToken);
    const conflict = await account(owner, { ...request, name: 'Different synthetic business' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('OPERATION_CONFLICT');
    const status = await account<{ businesses: { id: string }[] }>(owner, { action: 'status' });
    expect(status.body.data?.businesses.filter((business) => business.id === first.business.id)).toHaveLength(1);
    const context = await account(owner, {
      action: 'context', businessId: first.business.id, operatorToken: replayed.body.data!.operatorToken,
    });
    expect(context.status).toBe(200);
  });

  it('isolates owners and refuses another tenant even with its valid PIN and token', async () => {
    const business = await newBusiness(owner);
    const otherBusiness = await newBusiness(anotherOwner);
    const status = await account<{ businesses: { id: string }[] }>(anotherOwner, { action: 'status' });
    expect(status.body.data?.businesses.map((entry) => entry.id)).not.toContain(business.business.id);
    expect(status.body.data?.businesses.map((entry) => entry.id)).toContain(otherBusiness.business.id);
    for (const request of [
      { action: 'unlock', businessId: business.business.id, pin: validPin },
      { action: 'context', businessId: business.business.id, operatorToken: business.operatorToken },
      { action: 'lock', businessId: business.business.id, operatorToken: business.operatorToken },
    ]) {
      const denied = await account(anotherOwner, request);
      expect(denied.status).toBe(403);
      expect(denied.body.error?.code).toBe('BUSINESS_ACCESS_DENIED');
    }
    const unaffected = await account(owner, {
      action: 'context', businessId: business.business.id, operatorToken: business.operatorToken,
    });
    expect(unaffected.status).toBe(200);
  });

  it('serializes simultaneous retries so one operation creates exactly one business', async () => {
    const request = createRequest();
    const [first, second] = await Promise.all([
      account<BusinessSession>(owner, request),
      account<BusinessSession>(owner, request),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    rememberBusiness(first.body.data!.business.id);
    expect(second.body.data?.business.id).toBe(first.body.data?.business.id);
    const count = sql(`select count(*) from app_private.business_create_operations where user_id = ${sqlUuid(owner.userId)} and operation_id = ${sqlUuid(String(request.operationId))};`);
    expect(count.trim()).toBe('1');
  });

  it('keeps credential and session tables inaccessible to browser REST/RPC callers', async () => {
    for (const table of ['businesses', 'business_memberships', 'operator_credentials', 'operator_sessions', 'business_create_operations', 'account_audit_events']) {
      const direct = await fetch(`${config!.url}/rest/v1/${table}?select=*`, {
        headers: { apikey: config!.anonKey, authorization: `Bearer ${owner.token}`, 'accept-profile': 'app_private' },
      });
      expect(direct.status).toBeGreaterThanOrEqual(400);
      expect(direct.status).toBeLessThan(500);
    }
    const business = await newBusiness(owner);
    const parameters: Record<string, Record<string, unknown>> = {
      account_status: {},
      account_create_business: { p_name: 'Unauthorized bypass', p_business_type: 'cafe', p_timezone: 'America/Mexico_City', p_operation_id: randomUUID(), p_pin: validPin },
      account_unlock: { p_business_id: business.business.id, p_pin: validPin },
      account_context: { p_business_id: business.business.id, p_operator_token: business.operatorToken },
      account_lock: { p_business_id: business.business.id, p_operator_token: business.operatorToken },
      account_revoke_sessions: {},
    };
    for (const [name, args] of Object.entries(parameters)) {
      const direct = await fetch(`${config!.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: config!.anonKey, authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_user_id: owner.userId, p_auth_session_id: owner.sessionId, ...args }),
      });
      expect(direct.status).toBeGreaterThanOrEqual(400);
      expect(direct.status).toBeLessThan(500);
    }
    const storageCheck = sql(`select (pin_hash like '$2%' and pin_hash <> '${validPin}') from app_private.operator_credentials where business_id = ${sqlUuid(business.business.id)} and user_id = ${sqlUuid(owner.userId)};`);
    expect(storageCheck.trim()).toBe('t');
    const tokenCheck = sql(`select (octet_length(token_hash) = 32 and token_hash = extensions.digest('${business.operatorToken}', 'sha256')) from app_private.operator_sessions where business_id = ${sqlUuid(business.business.id)} and user_id = ${sqlUuid(owner.userId)};`);
    expect(tokenCheck.trim()).toBe('t');
  });

  it('revokes a locked token, rejects arbitrary tokens, and allows a fresh correct PIN unlock', async () => {
    const business = await newBusiness(owner);
    const invalid = await account(owner, { action: 'context', businessId: business.business.id, operatorToken: 'e8'.repeat(32) });
    expect(invalid.status).toBe(401);
    expect(invalid.body.error?.code).toBe('SESSION_INVALID');
    const lock = await account(owner, { action: 'lock', businessId: business.business.id, operatorToken: business.operatorToken });
    expect(lock.status).toBe(200);
    const revoked = await account(owner, { action: 'context', businessId: business.business.id, operatorToken: business.operatorToken });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error?.code).toBe('SESSION_INVALID');
    const unlock = await account<BusinessSession>(owner, { action: 'unlock', businessId: business.business.id, pin: validPin });
    expect(unlock.status).toBe(200);
    expect(unlock.body.data?.operatorToken).not.toBe(business.operatorToken);
    const newContext = await account(owner, { action: 'context', businessId: business.business.id, operatorToken: unlock.body.data!.operatorToken });
    expect(newContext.status).toBe(200);
  });

  it('enforces five-attempt PIN lockout on the server, including the correct PIN during cooldown', async () => {
    const business = await newBusiness(lockoutOwner);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const reply = await account(lockoutOwner, { action: 'unlock', businessId: business.business.id, pin: '111111' });
      expect(reply.status).toBe(attempt === 5 ? 429 : 401);
      expect(reply.body.error?.code).toBe(attempt === 5 ? 'PIN_LOCKED' : 'PIN_INVALID');
    }
    const correctDuringCooldown = await account(lockoutOwner, { action: 'unlock', businessId: business.business.id, pin: validPin });
    expect(correctDuringCooldown.status).toBe(429);
    expect(correctDuringCooldown.body.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(correctDuringCooldown.body.error?.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('counts concurrent wrong PIN attempts atomically and resets the counter after cooldown', async () => {
    const business = await newBusiness(lockoutOwner);
    const replies = await Promise.all(Array.from({ length: 5 }, () =>
      account(lockoutOwner, { action: 'unlock', businessId: business.business.id, pin: '111111' })));
    expect(replies.filter((reply) => reply.body.error?.code === 'PIN_INVALID')).toHaveLength(4);
    expect(replies.filter((reply) => reply.body.error?.code === 'PIN_LOCKED')).toHaveLength(1);
    sql(`update app_private.operator_credentials set locked_until = now() - interval '1 second' where business_id = ${sqlUuid(business.business.id)};`);
    const recovered = await account(lockoutOwner, { action: 'unlock', businessId: business.business.id, pin: validPin });
    expect(recovered.status).toBe(200);
    const reset = sql(`select (failed_attempts = 0 and locked_until is null) from app_private.operator_credentials where business_id = ${sqlUuid(business.business.id)};`);
    expect(reset.trim()).toBe('t');
  });

  it('rejects forbidden browser origins and oversized authenticated payloads', async () => {
    const forbidden = await fetch(`${config!.url}/functions/v1/account`, {
      method: 'POST',
      headers: { apikey: config!.anonKey, authorization: `Bearer ${owner.token}`, origin: 'https://untrusted.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe('ORIGIN_FORBIDDEN');
    // Local Supabase's Kong may add '*' to the denied error response. The handler
    // must still deny the action and never reflect the untrusted origin.
    expect(forbidden.headers.get('access-control-allow-origin')).not.toBe('https://untrusted.example.test');
    // Kong handles OPTIONS itself; the security boundary is denial of the
    // authenticated POST above, even if the gateway accepts a preflight.
    const oversized = await fetch(`${config!.url}/functions/v1/account`, {
      method: 'POST',
      headers: { apikey: config!.anonKey, authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', padding: 'x'.repeat(9_000) }),
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(oversized.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects expired operator sessions and sessions whose Google authentication session no longer exists', async () => {
    const expiring = await newBusiness(owner);
    sql(`update app_private.operator_sessions set expires_at = now() - interval '1 second' where business_id = ${sqlUuid(expiring.business.id)};`);
    const expired = await account(owner, { action: 'context', businessId: expiring.business.id, operatorToken: expiring.operatorToken });
    expect(expired.status).toBe(401);
    expect(expired.body.error?.code).toBe('SESSION_EXPIRED');

    const disposable = await newAccount();
    const live = await newBusiness(disposable);
    sql(`delete from auth.sessions where id = ${sqlUuid(disposable.sessionId)};`);
    const afterAuthRevocation = await account(disposable, {
      action: 'context', businessId: live.business.id, operatorToken: live.operatorToken,
    });
    expect(afterAuthRevocation.status).toBe(401);
    expect(afterAuthRevocation.body.error?.code).toBe('AUTH_REQUIRED');
  });

  it('logout revokes operator sessions and repeated Auth logout confirms the removed authentication session', async () => {
    const first = await newBusiness(anotherOwner);
    const second = await newBusiness(anotherOwner);
    const revoked = await account(anotherOwner, { action: 'revoke_sessions' });
    expect(revoked.status).toBe(200);
    for (const business of [first, second]) {
      const reply = await account(anotherOwner, { action: 'context', businessId: business.business.id, operatorToken: business.operatorToken });
      expect(reply.status).toBe(401);
      expect(reply.body.error?.code).toBe('SESSION_INVALID');
    }
    const { error } = await anotherOwner.client.auth.signOut({ scope: 'local' });
    expect(error).toBeNull();
    const duplicate = await anotherOwner.client.auth.admin.signOut(anotherOwner.token, 'local');
    expect(isAuthSessionMissingError(duplicate.error)).toBe(true);
    expect(duplicate.error?.code).toBeUndefined();
    expect(sql(`select count(*) from auth.sessions where id = ${sqlUuid(anotherOwner.sessionId)};`).trim()).toBe('0');
    const oldJwt = await account(anotherOwner, {
      action: 'context', businessId: first.business.id, operatorToken: first.operatorToken,
    });
    expect(oldJwt.status).toBe(401);
    expect(oldJwt.body.error?.code).toBe('AUTH_REQUIRED');
  });
});

function loadLocalConfig(): LocalConfig | null {
  let status: Record<string, string>;
  if (process.env.TEST_SUPABASE_URL) {
    status = {
      API_URL: process.env.TEST_SUPABASE_URL,
      ANON_KEY: process.env.TEST_SUPABASE_ANON_KEY ?? '',
      SERVICE_ROLE_KEY: process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '',
    };
  } else {
    try {
      status = JSON.parse(execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'json'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch {
      return null;
    }
  }
  const url = new URL(status.API_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Integration tests refuse non-loopback Supabase URLs. No cloud accounts will be created.');
  }
  if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Local integration credentials are incomplete.');
  const toml = readFileSync('supabase/config.toml', 'utf8');
  const projectId = toml.match(/^project_id\s*=\s*"([^"\n]+)"/m)?.[1];
  if (!projectId) throw new Error('Local Supabase project_id is missing.');
  return {
    url: status.API_URL,
    anonKey: status.ANON_KEY,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    dbContainer: process.env.TEST_LOCAL_DB_CONTAINER ?? `supabase_db_${projectId}`,
  };
}

async function newAccount(): Promise<TestAccount> {
  const email = `integration-${randomUUID()}@example.test`;
  const password = `local-only-${randomUUID()}-Aa9!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  syntheticUserIds.push(created.data.user.id);
  const client = createClient(config!.url, config!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const token = signedIn.data.session!.access_token;
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  return { userId: created.data.user.id, token, sessionId: claims.session_id, client };
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    action: 'create_business',
    operationId: randomUUID(),
    name: `Synthetic test business ${randomUUID().slice(0, 8)}`,
    businessType: 'cafe',
    timezone: 'America/Mexico_City',
    pin: validPin,
    ...overrides,
  };
}

async function newBusiness(accountOwner: TestAccount): Promise<BusinessSession> {
  const reply = await account<BusinessSession>(accountOwner, createRequest());
  expect(reply.status).toBe(200);
  const data = reply.body.data!;
  rememberBusiness(data.business.id);
  return data;
}

function rememberBusiness(id: string) {
  if (!syntheticBusinessIds.includes(id)) syntheticBusinessIds.push(id);
}

async function account<T = unknown>(identity: TestAccount | null, request: Record<string, unknown>): Promise<ApiReply<T>> {
  const response = await fetch(`${config!.url}/functions/v1/account`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: config!.anonKey,
      ...(identity ? { authorization: `Bearer ${identity.token}` } : {}),
    },
    body: JSON.stringify(await signedRequest(identity?.userId, request)),
  });
  return { status: response.status, body: await response.json() };
}

function sql(statement: string) {
  return execFileSync('docker', ['exec', '-i', config!.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', statement], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sqlUuid(value: string) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Expected a synthetic UUID for local SQL.');
  return `'${value}'::uuid`;
}
