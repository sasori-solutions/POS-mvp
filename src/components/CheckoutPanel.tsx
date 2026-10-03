import { useEffect, useId, useRef, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

/** A separate, modal payment surface; the account underneath remains mounted. */
export default function CheckoutPanel({ title = 'Cobrar', busy = false, completed = false, beforeClose, onClose, children }: {
  title?: string
  busy?: boolean
  completed?: boolean
  beforeClose?: () => Promise<boolean>
  onClose: () => void
  children: ReactNode
}) {
  const displayedChildren = useRef(children)
  if (!completed) displayedChildren.current = children
  const panel = useRef<HTMLDialogElement>(null)
  const closing = useRef(false)
  const titleId = useId()
  const { contextSafe } = useGSAP(() => {
    if (!window.matchMedia) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(panel.current, { yPercent: 100 }, { yPercent: 0, duration: 0.28, ease: 'power2.out' })
    })
    return () => media.revert()
  }, { scope: panel })

  useEffect(() => {
    const dialog = panel.current!
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-checkout-focus]')?.focus()
    return () => {
      dialog.close()
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  const finishClose = contextSafe(() => {
    if (!panel.current) return
    if (panel.current) panel.current.inert = true
    if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) onClose()
    else gsap.to(panel.current, { yPercent: 100, duration: 0.2, ease: 'power2.in', overwrite: true, onComplete: onClose })
  })

  useEffect(() => {
    if (completed && !closing.current) {
      closing.current = true
      finishClose()
    }
  }, [completed, finishClose])

  async function close() {
    if (busy || closing.current) return
    closing.current = true
    if (panel.current) panel.current.inert = true
    try {
      if (beforeClose && !await beforeClose()) {
        closing.current = false
        if (panel.current) { panel.current.inert = false; panel.current.querySelector<HTMLButtonElement>('.checkout-back')?.focus() }
        return
      }
      finishClose()
    } catch { closing.current = false; if (panel.current) panel.current.inert = false }
  }

  return <dialog ref={panel} className="checkout-screen" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); void close() }}>
    <header className="checkout-header">
      <button type="button" className="checkout-back" aria-label="Cerrar" disabled={busy} onClick={() => void close()}>
        <ArrowLeft size={22} aria-hidden="true" /><span>Volver a la cuenta</span>
      </button>
      <h2 id={titleId} tabIndex={-1} data-checkout-focus>{title}</h2>
    </header>
    <div className="checkout-body">{displayedChildren.current}</div>
  </dialog>
}
