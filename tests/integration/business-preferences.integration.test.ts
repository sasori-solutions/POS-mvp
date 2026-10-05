import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import type { BusinessContext, BusinessProfile, OperatorSession } from '../../src/lib/contracts';
import { signedRequest } from './device-proof-fixture';
import { profileJpeg } from '../fixtures/profile-image';

const url = process.env.TEST_SUPABASE_URL;
const enabled = Boolean(url);
if (enabled && (new URL(url!).protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))) throw new Error('Profile integration tests require loopback Auth/Edge/PostgreSQL.');
const anon = process.env.TEST_SUPABASE_ANON_KEY ?? '', service = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '', container = process.env.TEST_LOCAL_DB_CONTAINER ?? '';
const admin = enabled ? createClient(url!, service, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const users: string[] = [], businesses: string[] = [];
const profile: BusinessProfile = { branchName: 'Principal', registerName: 'Caja', address: 'Dirección sintética privada', city: 'Ciudad', state: 'Estado', contactPhone: '', paymentMethods: ['cash', 'card_integrated'] };
type Actor = { userId: string; jwt: string; operator: OperatorSession };
type Reply<T> = { status: number; data?: T; error?: { code: string } };

describe.skipIf(!enabled)('business setup and profile images through real local Auth/Edge/Postgres', () => {
  afterAll(async () => {
    if (businesses.length) sql(`delete from app_private.businesses where id in (${businesses.map(uuid).join(',')});`);
    for (const id of users) { const result = await admin!.auth.admin.deleteUser(id); if (result.error) throw result.error; }
  }, 60_000);

  it('persists creation preferences and allows exact creation retry without duplicating a business', async () => {
    const actor = await identity();
    const request = { action: 'create_business', operationId: randomUUID(), name: 'Negocio sintético preferencia', businessType: 'restaurant', timezone: 'America/Mexico_City', pin: '024680', profile: { ...profile, accountsEnabled: true, defaultVatTreatment: 'exempt', logoImageId: null } };
    actor.operator = data(await call<OperatorSession>(actor, request)); businesses.push(actor.operator.business.id);
    expect(actor.operator.business.profile).toMatchObject({ accountsEnabled: true, defaultVatTreatment: 'exempt', logoImageId: null });
    const replayed = data(await call<OperatorSession>(actor, request));
    expect(replayed.business.id).toBe(actor.operator.business.id);
    actor.operator = replayed; // Creating/replaying deliberately rotates PIN sessions.
    expect(sql(`select count(*) from app_private.business_create_operations where user_id=${uuid(actor.userId)} and operation_id=${uuid(request.operationId)}`).trim()).toBe('1');
    const saved = data(await call<BusinessContext>(actor, { action: 'update_business', ...access(actor), name: request.name, businessType: request.businessType, timezone: request.timezone, profile: { ...request.profile, accountsEnabled: false, defaultVatTreatment: 'vat_0' } }));
    expect(saved.profile).toMatchObject({ accountsEnabled: false, defaultVatTreatment: 'vat_0' });
    const olderClient = data(await call<BusinessContext>(actor, { action: 'update_business', ...access(actor), name: request.name, businessType: request.businessType, timezone: request.timezone, profile }));
    expect(olderClient.profile).toMatchObject({ accountsEnabled: false, defaultVatTreatment: 'vat_0' });
    expect((await call(actor, { action: 'update_business', ...access(actor), name: request.name, businessType: request.businessType, timezone: request.timezone, profile: { ...profile, accountsEnabled: 'false' } })).error?.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('persists a business logo after the final part, survives refresh and rejects foreign references', async () => {
    const owner = await ownerActor(), other = await ownerActor();
    const imageId = randomUUID(), image = jpeg(3400);
    const part0 = upload(owner, 'business', imageId, image, 0), part1 = upload(owner, 'business', imageId, image, 1);
    expect(data(await call(owner, part0))).toEqual({ imageId, complete: false });
    expect(data(await call<{ business: BusinessContext }>(owner, { action: 'context', ...access(owner) })).business.logoUrl).toBeNull();
    const complete = data(await call<{ business: BusinessContext; complete: boolean }>(owner, part1));
    expect(complete.complete).toBe(true);
    expect(complete.business.logoUrl).toBe(`data:image/jpeg;base64,${image}`);
    expect(data(await call<{ business: BusinessContext }>(owner, { action: 'context', ...access(owner) })).business.profile.logoImageId).toBe(imageId);
    expect(data(await call(owner, part1))).toMatchObject({ complete: true, imageId });
    expect((await call(other, { action: 'update_business', ...access(other), name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', profile: { ...profile, logoImageId: imageId } })).error?.code).toBe('VALIDATION_ERROR');
    const invalid = randomUUID();
    expect((await call(owner, upload(owner, 'business', invalid, Buffer.from('not jpeg').toString('base64')))).error?.code).toBe('VALIDATION_ERROR');
    expect(sql(`select count(*) from app_private.profile_images where id=${uuid(invalid)}`).trim()).toBe('0');
  }, 30_000);

  it('lets an authenticated employee set an avatar while preserving tenant privacy and current state on retries', async () => {
    const owner = await ownerActor(), staff = await identity();
    const invitation = data(await call<{ invitation: { invitationCode: string } }>(owner, { action: 'create_employee', ...access(owner), name: 'Persona sintética imagen', role: 'cashier', permissions: ['catalog.read'], pin: null, inviteWithGoogle: true, operationId: randomUUID() }));
    staff.operator = data(await call<OperatorSession>(staff, { action: 'accept_invitation', invitationCode: invitation.invitation.invitationCode, pin: '024681', operationId: randomUUID(), deviceName: 'Navegador sintético' }));
    const first = upload(staff, 'account', randomUUID(), jpeg(40));
    const firstReply = data(await call<{ business: BusinessContext }>(staff, first));
    expect(firstReply.business.profile.address).toBe('');
    expect(firstReply.business.accountAvatarUrl).toBe(`data:image/jpeg;base64,${jpeg(40)}`);
    expect((await call(staff, upload(staff, 'business', randomUUID(), jpeg(40)))).error?.code).toBe('PERMISSION_DENIED');
    const remove = { action: 'remove_profile_image', ...access(staff), subject: 'account', operationId: randomUUID() };
    data(await call(staff, remove));
    const current = data(await call<{ business: BusinessContext }>(staff, upload(staff, 'account', randomUUID(), jpeg(80))));
    for (const request of [first, remove]) expect(data(await call<{ business: BusinessContext }>(staff, request)).business.accountAvatarUrl).toBe(current.business.accountAvatarUrl);
    expect(data(await call<{ business: BusinessContext }>(owner, { action: 'context', ...access(owner) })).business.accountAvatarUrl).toBeNull();
    data(await call(owner, { action: 'update_employee', ...access(owner), employeeId: staff.operator.business.employee!.id, name: 'Persona sintética imagen', role: 'cashier', permissions: ['catalog.read'], active: false, pin: null }));
    expect((await call(staff, first)).error?.code).toBe('BUSINESS_ACCESS_DENIED');
  }, 45_000);

  it('rejects an upload when PIN-session revocation wins the operator lock', async () => {
    const owner = await ownerActor(), imageId = randomUUID(), lock = session();
    let pending: Promise<Reply<unknown>> | undefined;
    try {
      const pid = await lock.ready(`begin; update app_private.operator_sessions set revoked_at=clock_timestamp() where business_id=${uuid(owner.operator.business.id)} and user_id=${uuid(owner.userId)}`);
      pending = call(owner, upload(owner, 'business', imageId, jpeg(40))); pending.catch(() => {});
      await blockedBy(pid);
      await lock.finish('commit');
      expect((await pending).error?.code).toBe('SESSION_INVALID');
      expect(sql(`select count(*) from app_private.profile_images where id=${uuid(imageId)}`).trim()).toBe('0');
    } finally { await lock.finish('rollback'); if (pending) await pending.catch(() => {}); }
  }, 30_000);
});

async function identity(): Promise<Actor> {
  const email = `profile-${randomUUID()}@example.test`, password = `Local-${randomUUID()}-Aa9!`;
  const created = await admin!.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw created.error;
  users.push(created.data.user.id);
  const auth = createClient(url!, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await auth.auth.signInWithPassword({ email, password }); if (signed.error || !signed.data.session) throw signed.error ?? new Error('Missing synthetic session');
  return { userId: created.data.user.id, jwt: signed.data.session.access_token } as Actor;
}
async function ownerActor() {
  const actor = await identity();
  actor.operator = data(await call<OperatorSession>(actor, { action: 'create_business', operationId: randomUUID(), name: 'Negocio sintético imagen', businessType: 'cafe', timezone: 'America/Mexico_City', pin: '024680', profile }));
  businesses.push(actor.operator.business.id); return actor;
}
function access(actor: Actor) { return { businessId: actor.operator.business.id, operatorToken: actor.operator.operatorToken }; }
async function call<T = unknown>(actor: Actor, payload: Record<string, unknown>): Promise<Reply<T>> {
  const response = await fetch(`${url}/functions/v1/account`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: anon, authorization: `Bearer ${actor.jwt}` }, body: JSON.stringify(await signedRequest(actor.userId, payload)), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, ...await response.json() };
}
function data<T>(reply: Reply<T>): T { expect(reply.error).toBeUndefined(); expect(reply.status).toBe(200); expect(reply.data).toBeDefined(); return reply.data!; }
function jpeg(size: number) { return profileJpeg(size); }
function upload(actor: Actor, subject: 'business' | 'account', imageId: string, image: string, part = 0) { return { action: 'upload_profile_image', ...access(actor), subject, imageId, operationId: randomUUID(), part, parts: Math.ceil(image.length / 4096), data: image.slice(part * 4096, (part + 1) * 4096) }; }
function uuid(value: string) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid synthetic UUID'); return `'${value}'::uuid`; }
function sql(statement: string) { return execFileSync('docker', psqlArgs(), { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function psqlArgs() { return ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-Atq']; }
async function blockedBy(pid: number) {
  for (let n = 0; n < 100; n++) { if (Number(sql(`select count(*) from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`)) > 0) return; await delay(20); }
  throw new Error('Expected real PostgreSQL operator-session contention');
}
function session() {
  const process: ChildProcessWithoutNullStreams = spawn('docker', psqlArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', finished = false;
  process.stdout.on('data', value => { output += String(value); }); process.stderr.on('data', value => { errors += String(value); });
  const done = new Promise<void>((resolve, reject) => { process.on('error', reject); process.on('close', code => code === 0 ? resolve() : reject(new Error(`Synthetic lock session failed: ${errors}`))); });
  async function until(marker: string) { for (let n = 0; n < 150; n++) { if (output.includes(marker)) return; await delay(20); } throw new Error('Synthetic lock session did not become ready'); }
  return {
    async ready(statement: string) { const marker = `READY_${randomUUID()}`; process.stdin.write(`${statement}; select '${marker}:'||pg_backend_pid();\n`); await until(marker); const pid = Number(output.split(marker + ':')[1]?.split('\n')[0]); if (!Number.isSafeInteger(pid)) throw new Error('Missing synthetic lock PID'); return pid; },
    async finish(statement: string) { if (finished) return; finished = true; process.stdin.end(`${statement};\n`); await done; },
  };
}
