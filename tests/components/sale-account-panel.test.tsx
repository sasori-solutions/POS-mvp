// @vitest-environment jsdom
import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { gsap } from 'gsap'
import SaleAccountPanel from '../../src/components/SaleAccountPanel'

let width: number, reduced: boolean
beforeEach(() => {
  width = 390; reduced = false
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number; pointerType: string
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'touch' }
  })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    get matches() { return query.includes('width <') ? width < 760 : query.includes('width >=') ? width >= 760 : reduced },
    media: query, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function Fixture({ open, onClose = vi.fn(), canClose = true }: { open: boolean; onClose?: () => void; canClose?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null)
  return <><button ref={trigger}>Ver cuenta</button><div>Catálogo disponible</div>
    <SaleAccountPanel open={open} canClose={canClose} returnFocus={trigger} onClose={onClose}>
      <h2 data-account-focus data-account-drag tabIndex={-1}>Venta actual</h2><button>Quitar Café</button>
    </SaleAccountPanel>
  </>
}
function account() { return document.getElementById('current-sale-account')! }

test('phone expansion slides up without a modal, preserves catalog and reverses the same tween on rapid toggles', () => {
  const view = render(<Fixture open={false} />), panel = account()
  const tween = gsap.getTweensOf(panel)[0]
  expect(panel.getAttribute('aria-hidden')).toBe('true'); expect(panel.inert).toBe(true)
  view.rerender(<Fixture open />)
  act(() => { tween.progress(1) })
  expect(Number(gsap.getProperty(panel, 'yPercent'))).toBe(0)
  expect(panel.style.opacity).toBe('')
  expect(screen.getByRole('complementary', { name: 'Venta actual' })).toBe(panel)
  expect(screen.getByText('Catálogo disponible')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Venta actual' }))
  view.rerender(<Fixture open={false} />)
  expect(tween.reversed()).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ver cuenta' }))
  view.rerender(<Fixture open />)
  expect(gsap.getTweensOf(panel)[0]).toBe(tween); expect(tween.reversed()).toBe(false)
  view.rerender(<Fixture open={false} />)
  act(() => { tween.progress(0) })
  expect(panel.inert).toBe(true); expect(Number(gsap.getProperty(panel, 'yPercent'))).toBe(100)
  view.unmount()
  expect(gsap.getTweensOf(panel)).toHaveLength(0)
})

test('reduced motion opens and closes immediately with the same account and accessible focus', () => {
  reduced = true
  const view = render(<Fixture open={false} />), panel = account()
  view.rerender(<Fixture open />)
  expect(Number(gsap.getProperty(panel, 'yPercent'))).toBe(0)
  expect(gsap.getTweensOf(panel)[0].paused()).toBe(true)
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Venta actual' }))
  view.rerender(<Fixture open={false} />)
  expect(Number(gsap.getProperty(panel, 'yPercent'))).toBe(100)
  expect(panel.inert).toBe(true)
})

test('crossing the tablet breakpoint restores the always-visible column and clears phone styles', async () => {
  const view = render(<Fixture open={false} />), panel = account()
  expect(panel.getAttribute('aria-hidden')).toBe('true')
  width = 1024
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); gsap.matchMediaRefresh() })
  expect(panel.hasAttribute('aria-hidden')).toBe(false); expect(panel.inert).toBe(false)
  expect(panel.style.transform).toBe(''); expect(panel.style.visibility).toBe('')
  expect(screen.getByRole('complementary', { name: 'Venta actual' })).toBe(panel)
  width = 390
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); gsap.matchMediaRefresh() })
  expect(panel.getAttribute('aria-hidden')).toBe('true')
  view.rerender(<Fixture open />)
  act(() => { gsap.getTweensOf(panel)[0].progress(1) })
  expect(panel.inert).toBe(false)
})

test('an outside click requests fast dismissal without affecting account items', () => {
  const close = vi.fn(), view = render(<Fixture open onClose={close} />), panel = account()
  fireEvent.click(screen.getByRole('button', { name: 'Cerrar venta actual' }))
  expect(close).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Quitar Café' })).toBeTruthy()
  view.rerender(<Fixture open={false} onClose={close} />)
  const tween = gsap.getTweensOf(panel)[0]
  expect(tween.reversed()).toBe(true); expect(Math.abs(tween.timeScale())).toBe(1)
  act(() => { tween.progress(0) })
  expect(panel.style.visibility).toBe('hidden')
})

test('a downward finger drag tracks the panel and closes it; a short or canceled drag returns it upward', () => {
  const close = vi.fn()
  const view = render(<Fixture open={false} onClose={close} />)
  const panel = account(), tween = gsap.getTweensOf(panel)[0]
  view.rerender(<Fixture open onClose={close} />)
  act(() => { tween.progress(1) })
  const header = screen.getByRole('heading', { name: 'Venta actual' })
  fireEvent.pointerDown(header, { clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(panel, { clientY: 125, pointerId: 1 })
  expect(Number(gsap.getProperty(panel, 'yPercent'))).toBeGreaterThan(0)
  fireEvent.pointerUp(panel, { clientY: 125, pointerId: 1 })
  expect(close).not.toHaveBeenCalled(); expect(tween.reversed()).toBe(false)
  act(() => { tween.progress(1) })
  fireEvent.pointerDown(header, { clientY: 100, pointerId: 2 })
  fireEvent.pointerMove(panel, { clientY: 300, pointerId: 2 })
  fireEvent.pointerCancel(panel, { pointerId: 2 })
  expect(close).not.toHaveBeenCalled()
  act(() => { tween.progress(1) })
  fireEvent.pointerDown(header, { clientY: 100, pointerId: 3 })
  fireEvent.pointerMove(panel, { clientY: 300, pointerId: 3 })
  fireEvent.pointerUp(panel, { clientY: 300, pointerId: 3 })
  expect(close).toHaveBeenCalledTimes(1)
})

test('article scrolling and unrelated pointers do not become dismissal gestures', () => {
  const close = vi.fn()
  render(<Fixture open onClose={close} />)
  const panel = account(), item = screen.getByRole('button', { name: 'Quitar Café' })
  fireEvent.pointerDown(item, { clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(panel, { clientY: 300, pointerId: 1 })
  fireEvent.pointerUp(panel, { clientY: 300, pointerId: 1 })
  expect(close).not.toHaveBeenCalled(); expect(Number(gsap.getProperty(panel, 'yPercent'))).toBe(0)
  fireEvent.pointerDown(screen.getByRole('heading', { name: 'Venta actual' }), { clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(panel, { clientY: 300, pointerId: 2 })
  fireEvent.pointerUp(panel, { clientY: 300, pointerId: 2 })
  expect(close).not.toHaveBeenCalled(); expect(Number(gsap.getProperty(panel, 'yPercent'))).toBe(0)
})

test('dragging completely down hides the panel without covering bottom navigation', () => {
  const close = vi.fn(), view = render(<Fixture open={false} onClose={close} />), panel = account()
  const tween = gsap.getTweensOf(panel)[0]
  view.rerender(<Fixture open onClose={close} />)
  act(() => { tween.progress(1) })
  fireEvent.pointerDown(screen.getByRole('heading', { name: 'Venta actual' }), { clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(panel, { clientY: 1200, pointerId: 1 })
  fireEvent.pointerUp(panel, { clientY: 1200, pointerId: 1 })
  expect(close).toHaveBeenCalledTimes(1)
  view.rerender(<Fixture open={false} onClose={close} />)
  expect(panel.style.visibility).toBe('hidden'); expect(panel.inert).toBe(true)
})
