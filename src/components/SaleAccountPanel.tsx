import { useRef, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

/** One persistent account: a lateral column on tablet and a reversible phone panel. */
export default function SaleAccountPanel({ open, onClose, canClose, returnFocus, children }: {
  open: boolean
  onClose: () => void
  canClose: boolean
  returnFocus: RefObject<HTMLButtonElement | null>
  children: ReactNode
}) {
  const panel = useRef<HTMLElement>(null)
  const latestOpen = useRef(open); latestOpen.current = open
  const motion = useRef<{ tween: gsap.core.Tween; reduced: boolean } | null>(null)
  const drag = useRef<{ pointerId: number; startY: number; height: number; progress: number; distance: number } | null>(null)

  useGSAP(() => {
    if (!window.matchMedia) return
    const media = gsap.matchMedia()
    media.add({ phone: '(width < 47.5rem)', tablet: '(width >= 47.5rem)', reduced: '(prefers-reduced-motion: reduce)' }, context => {
      const element = panel.current!
      if (!context.conditions?.phone) return
      gsap.set(element, { visibility: latestOpen.current ? 'visible' : 'hidden' })
      const tween = gsap.fromTo(element, { yPercent: 100 }, {
        yPercent: 0, duration: 0.17, ease: 'power2.out', paused: true,
        onComplete: () => { if (latestOpen.current) element.querySelector<HTMLElement>('[data-account-focus]')?.focus() },
        onReverseComplete: () => { if (!latestOpen.current) element.style.visibility = 'hidden' },
      })
      motion.current = { tween, reduced: Boolean(context.conditions.reduced) }
      tween.progress(latestOpen.current ? 1 : 0, true).pause()
      element.inert = !latestOpen.current
      element.setAttribute('aria-hidden', String(!latestOpen.current))
      return () => { motion.current = null; drag.current = null; element.inert = false; element.removeAttribute('aria-hidden') }
    })
    return () => media.revert()
  }, { scope: panel })

  useGSAP(() => {
    const state = motion.current, element = panel.current
    if (!state || !element) return
    element.inert = !open
    element.setAttribute('aria-hidden', String(!open))
    if (!open) drag.current = null
    if (open) element.style.visibility = 'visible'
    else if (state.tween.progress() === 0) element.style.visibility = 'hidden'
    if (!open && (element.contains(document.activeElement) || state.tween.progress() > 0)) returnFocus.current?.focus()
    if (state.reduced) {
      state.tween.progress(open ? 1 : 0, true).pause()
      element.style.visibility = open ? 'visible' : 'hidden'
      if (open) element.querySelector<HTMLElement>('[data-account-focus]')?.focus()
    } else if (open) state.tween.timeScale(1).play()
    else state.tween.timeScale(1).reverse()
  }, { scope: panel, dependencies: [open] })

  function beginDrag(event: PointerEvent<HTMLElement>) {
    const state = motion.current
    if (!state || !open || !canClose || (event.pointerType === 'mouse' && event.button !== 0)
      || !(event.target instanceof Element) || !event.target.closest('[data-account-drag]')) return
    drag.current = { pointerId: event.pointerId, startY: event.clientY, height: event.currentTarget.getBoundingClientRect().height || window.innerHeight * 0.72, progress: state.tween.progress(), distance: 0 }
    state.tween.pause()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    const gesture = drag.current, state = motion.current
    if (!gesture || gesture.pointerId !== event.pointerId || !state) return
    gesture.distance = Math.max(0, event.clientY - gesture.startY)
    if (!state.reduced) state.tween.progress(Math.max(0, gesture.progress - gesture.distance / gesture.height), true)
  }
  function endDrag(event: PointerEvent<HTMLElement>, canceled = false) {
    const gesture = drag.current, state = motion.current
    if (!gesture || gesture.pointerId !== event.pointerId || !state) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!canceled && gesture.distance >= Math.min(80, gesture.height * 0.2)) onClose()
    else if (state.reduced) state.tween.progress(1, true).pause()
    else state.tween.timeScale(1).play()
  }

  return <>
    {open && canClose && <button type="button" aria-label="Cerrar venta actual" onClick={event => { event.stopPropagation(); onClose() }}
      className="fixed inset-0 z-35 cursor-default border-0 bg-transparent tablet:hidden" />}
    <aside ref={panel} id="current-sale-account" aria-label="Venta actual" data-open={open}
    className="current-sale sale-account sticky top-6 flex h-[calc(100dvh-240px)] min-w-0 flex-col border-l border-line pt-3 pl-8 max-desktop:pl-6 [@media(min-width:47.5rem)_and_(max-height:759px)]:h-auto max-tablet:fixed max-tablet:top-auto max-tablet:right-0 max-tablet:bottom-[calc(76px+env(safe-area-inset-bottom))] max-tablet:left-0 max-tablet:z-40 max-tablet:h-auto max-tablet:max-h-[min(60dvh,calc(100dvh-220px-env(safe-area-inset-bottom)))] max-tablet:rounded-t-2xl max-tablet:border max-tablet:bg-white max-tablet:px-4 max-tablet:pt-2 max-tablet:pb-4 max-tablet:shadow-[0_-8px_28px_rgba(0,0,0,0.10)]"
    onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={event => endDrag(event)} onPointerCancel={event => endDrag(event, true)} onLostPointerCapture={event => endDrag(event, true)}
    onKeyDown={event => { if (event.key === 'Escape' && canClose && motion.current) { event.stopPropagation(); onClose() } }}>
    {children}
  </aside>
  </>
}
