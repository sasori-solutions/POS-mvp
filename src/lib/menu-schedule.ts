import type { MenuSchedule } from './menu-contracts';

export const menuWeekdays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export function minuteLabel(minute: number): string { return minute === 1440 ? '24:00' : `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
export function minuteFromInput(value: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return minute < 60 && hour < 24 ? hour * 60 + minute : value === '24:00' ? 1440 : null;
}
/** Owner preview only. The public endpoint determines availability using its clock. */
export function menuScheduleOpen(schedules: MenuSchedule[], instant: Date, timezone: string): boolean {
  if (!schedules.length) return true;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const value = (key: string) => parts.find(part => part.type === key)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday'));
  const minute = Number(value('hour')) * 60 + Number(value('minute'));
  return schedules.some(schedule => schedule.startMinute < schedule.endMinute
    ? schedule.weekdays.includes(weekday) && minute >= schedule.startMinute && minute < schedule.endMinute
    : schedule.weekdays.includes(weekday) && minute >= schedule.startMinute || schedule.weekdays.includes((weekday + 6) % 7) && minute < schedule.endMinute);
}
export function scheduleLabel(schedule: MenuSchedule): string {
  return `${schedule.weekdays.map(day => menuWeekdays[day]).join(', ')} · ${minuteLabel(schedule.startMinute)}–${minuteLabel(schedule.endMinute)}${schedule.startMinute > schedule.endMinute ? ' del día siguiente' : ''}`;
}
