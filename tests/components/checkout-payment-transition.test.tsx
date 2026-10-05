// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { gsap } from 'gsap'
import CheckoutPaymentTransition from '../../src/features/operations/CheckoutPaymentTransition'

let height: number, width: number, reduced: boolean
let resized: () => void, motionChanged: () => void
let disconnected: ReturnType<typeof vi.fn>
beforeEach(() => {
  height = 52; width = 320; reduced = false
  disconnected = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe() {}
    disconnect = disconnected
  })
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return reduced },
    addEventListener: (_event: string, listener: () => void) => { motionChanged = listener },
    removeEventListener: vi.fn(),
  })))
  const original = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (!this.classList.contains('checkout-payment-transition') && !this.classList.contains('checkout-payment-content')) return original.call(this)
    const renderedHeight = this.classList.contains('checkout-payment-transition') && this.style.height ? parseFloat(this.style.height) : height
    return { x: 0, y: 0, width, height: renderedHeight, top: 0, right: width, bottom: renderedHeight, left: 0, toJSON: () => ({}) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Fixture({ method }: { method: string }) {
  return <><button>Método</button><CheckoutPaymentTransition transitionKey={method}><button>{method}</button></CheckoutPaymentTransition></>
}
function elements() {
  return { outer: document.querySelector('.checkout-payment-transition') as HTMLElement, inner: document.querySelector('.checkout-payment-content') as HTMLElement }
}

test('height and fade transition current controls immediately, preserving outside focus and canceling rapid changes', () => {
  const view = render(<Fixture method="Efectivo" />), { outer, inner } = elements()
  screen.getByRole('button', { name: 'Método' }).focus()
  height = 180
  view.rerender(<Fixture method="Tarjeta" />)
  expect(screen.queryByRole('button', { name: 'Efectivo' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Tarjeta' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Método' }))
  expect(outer.style.height).toBe('52px')
  const first = gsap.getTweensOf(outer)[0], fade = gsap.getTweensOf(inner)[0]
  expect(first.duration()).toBe(.16); expect(fade.duration()).toBe(.12)
  act(() => { first.progress(.5) })
  const intermediate = parseFloat(outer.style.height)
  expect(intermediate).toBeGreaterThan(52); expect(intermediate).toBeLessThan(180)
  height = 100
  view.rerender(<Fixture method="Transferencia" />)
  const latest = gsap.getTweensOf(outer)[0]
  expect(latest).not.toBe(first)
  expect(parseFloat(outer.style.height)).toBe(intermediate)
  expect(screen.queryByRole('button', { name: 'Tarjeta' })).toBeNull()
  act(() => { latest.progress(1); gsap.getTweensOf(inner)[0].progress(1) })
  expect(outer.style.height).toBe(''); expect(outer.style.overflow).toBe(''); expect(inner.style.opacity).toBe('')
  view.unmount()
  expect(disconnected).toHaveBeenCalledOnce()
  expect(gsap.getTweensOf([outer, inner])).toHaveLength(0)
  act(() => { resized() })
  expect(gsap.getTweensOf([outer, inner])).toHaveLength(0)
})

test('async terminal content changes animate height without replaying fades or delaying actions', () => {
  render(<Fixture method="Tarjeta" />)
  const { outer, inner } = elements(), action = screen.getByRole('button', { name: 'Tarjeta' })
  height = 220
  act(() => { resized() })
  expect(gsap.getTweensOf(outer)).toHaveLength(1)
  expect(gsap.getTweensOf(inner)).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Tarjeta' })).toBe(action)
  act(() => { gsap.getTweensOf(outer)[0].progress(1); resized() })
  expect(gsap.getTweensOf(outer)).toHaveLength(0)
})

test('device width changes and reduced motion snap to the correct current layout', () => {
  const view = render(<Fixture method="Efectivo" />), { outer, inner } = elements()
  height = 200; width = 600
  view.rerender(<Fixture method="Tarjeta" />)
  expect(gsap.getTweensOf([outer, inner])).toHaveLength(0)
  height = 100
  view.rerender(<Fixture method="Transferencia" />)
  expect(gsap.getTweensOf(outer)).toHaveLength(1)
  reduced = true
  act(() => { motionChanged() })
  expect(gsap.getTweensOf([outer, inner])).toHaveLength(0)
  expect(outer.style.height).toBe(''); expect(inner.style.opacity).toBe('')
  height = 180
  view.rerender(<Fixture method="Tarjeta" />)
  expect(gsap.getTweensOf([outer, inner])).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Tarjeta' })).toBeTruthy()
})
