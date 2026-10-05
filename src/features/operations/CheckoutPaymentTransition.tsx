import { useRef, type ReactNode } from 'react'
import { useGSAP } from '@gsap/react'
import { gsap } from 'gsap'

gsap.registerPlugin(useGSAP)

/** Animate the current controls only: previous payment actions never stay clickable. */
export default function CheckoutPaymentTransition({ transitionKey, children }: { transitionKey: string; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const previousKey = useRef(transitionKey)
  const animate = useRef<((fade: boolean) => void) | null>(null)

  useGSAP((_context, contextSafe) => {
    if (!contextSafe) return
    const outer = viewport.current!, inner = content.current!
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let active = true
    let previous = inner.getBoundingClientRect()
    const clear = contextSafe(() => {
      gsap.killTweensOf(outer)
      gsap.killTweensOf(inner)
      gsap.set(outer, { clearProps: 'height,overflow' })
      gsap.set(inner, { clearProps: 'opacity' })
    })
    const resize = contextSafe((fade: boolean) => {
      if (!active) return
      const next = inner.getBoundingClientRect(), old = previous
      previous = next
      // Layout changes from resizing a device should remain immediate.
      if (media?.matches || Math.abs(next.width - old.width) > 1 || !old.height || !next.height) { clear(); return }
      if (Math.abs(next.height - old.height) > .5) {
        const from = outer.style.height ? outer.getBoundingClientRect().height : old.height
        gsap.killTweensOf(outer)
        gsap.set(outer, { height: from, overflow: 'clip' })
        gsap.to(outer, { height: next.height, duration: .16, ease: 'power1.out', overwrite: 'auto', onComplete: contextSafe(() => gsap.set(outer, { clearProps: 'height,overflow' })) })
      }
      if (fade) {
        gsap.killTweensOf(inner)
        gsap.fromTo(inner, { opacity: .72 }, { opacity: 1, duration: .12, ease: 'power1.out', overwrite: 'auto', onComplete: contextSafe(() => gsap.set(inner, { clearProps: 'opacity' })) })
      }
    })
    animate.current = resize
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => resize(false))
    observer?.observe(inner)
    const motionChanged = () => { if (media?.matches) clear() }
    media?.addEventListener?.('change', motionChanged)
    return () => {
      active = false
      observer?.disconnect()
      media?.removeEventListener?.('change', motionChanged)
      animate.current = null
    }
  }, { scope: viewport })

  useGSAP(() => {
    if (previousKey.current === transitionKey) return
    previousKey.current = transitionKey
    animate.current?.(true)
  }, { scope: viewport, dependencies: [transitionKey] })

  return <div ref={viewport} className="checkout-payment-transition"><div ref={content} className="checkout-payment-content">{children}</div></div>
}
