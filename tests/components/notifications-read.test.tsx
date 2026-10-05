// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import NotificationsPanel from '../../src/components/NotificationsPanel'
import { accountRequest } from '../../src/lib/account'
import type { OwnerNotification } from '../../src/lib/contracts'

vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn() }))
const first: OwnerNotification = { id: 'notice-a', type: 'employee_device_requested', employeeId: 'employee-a', employeeName: 'Persona A', deviceName: 'Dispositivo A', createdAt: '2026-10-04T12:00:00Z', readAt: null, status: 'pending' }
const second: OwnerNotification = { ...first, id: 'notice-b', employeeId: 'employee-b', employeeName: 'Persona B', deviceName: 'Dispositivo B', status: 'info', type: 'employee_device_linked' }
const props = { businessId: 'business-a', operatorToken: 'memory-only-a', onBack: vi.fn(), onSessionError: vi.fn(), onUnreadCount: vi.fn() }
const data = (notifications: OwnerNotification[]) => ({ notifications, unreadCount: notifications.filter(notice => !notice.readAt).length })
const read = (notice: OwnerNotification) => ({ ...notice, readAt: '2026-10-04T12:30:00Z' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { vi.mocked(accountRequest).mockReset(); props.onUnreadCount.mockReset(); props.onSessionError.mockReset(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

test('visible read actions confirm through the existing API without approving device access', async () => {
  const mutation = deferred<{ read: true }>()
  vi.mocked(accountRequest).mockResolvedValueOnce(data([first])).mockReturnValueOnce(mutation.promise).mockResolvedValueOnce(data([read(first)]))
  render(<NotificationsPanel {...props} />)
  const button = await screen.findByRole('button', { name: 'Marcar como leída' })
  expect(button.className).toBe('notification-read-button')
  fireEvent.click(button)
  expect(screen.queryByRole('status', { name: 'Cargando notificaciones' })).toBeNull()
  expect(screen.queryByText('Leída')).toBeNull()
  expect(screen.getByText('Persona A')).toBeTruthy()
  await act(async () => mutation.resolve({ read: true }))
  expect(screen.getByText('Leída')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Marcar como leída' })).toBeNull()
  expect(vi.mocked(accountRequest).mock.calls.map(([request]) => request.action)).toEqual(['notifications', 'mark_notification_read', 'notifications'])
  expect(props.onUnreadCount).toHaveBeenLastCalledWith(0)
  expect(screen.getByRole('button', { name: 'Autorizar cambio' })).toBeTruthy()
})

test('mark all reads only unread rows and preserves each confirmed result on partial failure', async () => {
  vi.mocked(accountRequest).mockResolvedValueOnce(data([first, second])).mockResolvedValueOnce({ read: true }).mockRejectedValueOnce(new Error('Sin conexión')).mockResolvedValueOnce(data([read(first), second]))
  render(<NotificationsPanel {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Marcar todas como leídas' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toBe('Sin conexión')
  const notices = screen.getAllByRole('listitem')
  expect(within(notices[0]).getByText('Leída')).toBeTruthy()
  expect(within(notices[1]).getByRole('button', { name: 'Marcar como leída' })).toBeTruthy()
  expect(vi.mocked(accountRequest).mock.calls.filter(([request]) => request.action === 'mark_notification_read').map(([request]) => 'notificationId' in request ? request.notificationId : '')).toEqual(['notice-a', 'notice-b'])
  expect(vi.mocked(accountRequest).mock.calls.some(([request]) => request.action === 'review_employee_device')).toBe(false)
  expect(props.onUnreadCount).toHaveBeenLastCalledWith(1)
})

test('a manual read supersedes an in-flight background refresh without hiding the card', async () => {
  vi.useFakeTimers()
  const background = deferred<ReturnType<typeof data>>()
  const mutation = deferred<{ read: true }>()
  vi.mocked(accountRequest).mockResolvedValueOnce(data([second])).mockReturnValueOnce(background.promise).mockReturnValueOnce(mutation.promise).mockResolvedValueOnce(data([read(second)]))
  render(<NotificationsPanel {...props} />)
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  const card = screen.getByRole('listitem')
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como leída' }))
  await act(async () => background.resolve(data([second])))
  expect(screen.getByRole('listitem')).toBe(card)
  expect(screen.queryByText('Leída')).toBeNull()
  await act(async () => mutation.resolve({ read: true }))
  expect(screen.getByText('Leída')).toBeTruthy()
  expect(props.onUnreadCount).toHaveBeenLastCalledWith(0)
})

test('a late read result from a previous business cannot affect the next inbox', async () => {
  const mutation = deferred<{ read: true }>()
  vi.mocked(accountRequest).mockResolvedValueOnce(data([first])).mockReturnValueOnce(mutation.promise).mockResolvedValueOnce(data([second]))
  const view = render(<NotificationsPanel {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Marcar como leída' }))
  view.rerender(<NotificationsPanel {...props} businessId="business-b" operatorToken="memory-only-b" />)
  await screen.findByText('Persona B')
  await act(async () => mutation.resolve({ read: true }))
  expect(screen.queryByText('Persona A')).toBeNull()
  expect(screen.queryByText('Leída')).toBeNull()
  expect(props.onUnreadCount).toHaveBeenLastCalledWith(1)
  expect(vi.mocked(accountRequest).mock.calls).toHaveLength(3)
})


test('a confirmed read updates the bell even when the follow-up refresh fails', async () => {
  vi.mocked(accountRequest).mockResolvedValueOnce(data([second])).mockResolvedValueOnce({ read: true }).mockRejectedValueOnce(new Error('Sin conexión'))
  render(<NotificationsPanel {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Marcar como leída' }))
  await screen.findByRole('alert')
  expect(screen.getByText('Leída')).toBeTruthy()
  expect(props.onUnreadCount).toHaveBeenLastCalledWith(0)
  expect(screen.queryByRole('button', { name: 'Marcar como leída' })).toBeNull()
})
