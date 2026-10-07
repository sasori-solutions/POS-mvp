import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handlePublicMenu } from '../../supabase/functions/public-menu/handler';
import { parseMenuCommand } from '../../supabase/functions/account/menu-validation';
import { menuScheduleOpen, minuteFromInput, scheduleLabel } from '../../src/lib/menu-schedule';
const menuId = randomUUID(), origin = 'https://pos.example.test';
describe('public menu HTTP boundary and schedules', () => {
  it('accepts only a known menu ID without any identity, with no-store and explicit CORS', async () => {
    const ids: string[] = []; const dependencies = { origins: new Set([origin]), read: async (id: string) => { ids.push(id); return { data: { publicId: menuId } }; } };
    for (const request of [new Request(`https://api.example.test?menuId=${menuId}`, { headers: { origin } }), new Request('https://api.example.test', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ menuId }) })]) {
      const response = await handlePublicMenu(request, dependencies); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('access-control-allow-origin')).toBe(origin); expect(response.headers.get('access-control-allow-headers')).not.toContain('authorization');
      expect(await response.json()).toEqual({ data: { publicId: menuId } });
    }
    expect(ids).toEqual([menuId, menuId]);
    const denied = await handlePublicMenu(new Request(`https://api.example.test?menuId=${menuId}`, { headers: { origin: 'https://other.example.test' } }), dependencies);
    expect(denied.status).toBe(403); expect(denied.headers.has('access-control-allow-origin')).toBe(false); expect(ids).toHaveLength(2);
  });

  it('rejects repeated/unknown fields, streamed oversize input and malformed UUIDs before SQL; unavailable responses reveal no tenant', async () => {
    let calls = 0; const dependencies = { origins: new Set([origin]), read: async () => { calls++; return { error: { code: 'MENU_UNAVAILABLE', internal: 'must not leave SQL' } }; } };
    for (const url of [`?menuId=${menuId}&menuId=${menuId}`, `?menuId=${menuId}&businessId=${randomUUID()}`, '?menuId=invalid']) expect((await handlePublicMenu(new Request(`https://api.example.test${url}`), dependencies)).status).toBe(400);
    const forbidden = new Request('https://api.example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ menuId, operatorToken: 'never' }) });
    expect((await handlePublicMenu(forbidden, dependencies)).status).toBe(400);
    const large = new Request('https://api.example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ menuId, padding: 'a'.repeat(8200) }) });
    expect((await handlePublicMenu(large, dependencies)).status).toBe(413); expect(calls).toBe(0);
    const missing = await handlePublicMenu(new Request(`https://api.example.test?menuId=${menuId}`), dependencies);
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: { code: 'MENU_UNAVAILABLE', message: 'Este menú no está disponible.' } });
  });

  it('checks exact owner command keys, ordered days, positive windows and limits before HTTP', () => {
    const command = { command: 'save_menu', operationId: randomUUID(), menuId: randomUUID(), expectedRevision: null, name: 'Desayuno', locationLabel: 'Terraza', published: true, productIds: [randomUUID()], schedules: [{ weekdays: [0, 1], startMinute: 1320, endMinute: 120 }] };
    expect(parseMenuCommand(command, [])).toEqual(command);
    for (const patch of [{ publicId: randomUUID() }, { productIds: [] }, { productIds: Array.from({ length: 101 }, () => randomUUID()) }, { schedules: [{ weekdays: [1, 0], startMinute: 1, endMinute: 10 }] }, { schedules: [{ weekdays: [1], startMinute: 0, endMinute: 0 }] }]) expect(() => parseMenuCommand({ ...command, ...patch }, [])).toThrow();
  });

  it('previews the business timezone and midnight boundaries, with no inference from browser location', () => {
    const schedules = [{ weekdays: [2], startMinute: 1320, endMinute: 120 }];
    expect(menuScheduleOpen(schedules, new Date('2026-10-07T07:00:00Z'), 'America/Hermosillo')).toBe(true);
    expect(menuScheduleOpen(schedules, new Date('2026-10-07T09:00:00Z'), 'America/Hermosillo')).toBe(false);
    expect(menuScheduleOpen(schedules, new Date('2026-10-07T07:00:00Z'), 'Etc/UTC')).toBe(false);
    expect(menuScheduleOpen([], new Date(), 'Etc/UTC')).toBe(true);
    expect(scheduleLabel(schedules[0])).toBe('Mar · 22:00–02:00 del día siguiente');
    expect(minuteFromInput('24:00')).toBe(1440); expect(minuteFromInput('24:01')).toBeNull();
  });
});
