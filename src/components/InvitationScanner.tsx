import { useEffect, useRef, useState } from 'react'
import { Camera } from 'lucide-react'
import { invitationFromLink } from '../lib/business-access'

export default function InvitationScanner({ onInvitation, disabled = false }: {
  onInvitation: (link: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const found = useRef(onInvitation)
  const restoreFocus = useRef(false)
  found.current = onInvitation

  function close() {
    setOpen(false)
    restoreFocus.current = true
  }

  useEffect(() => {
    if (!open) {
      if (restoreFocus.current) { button.current?.focus(); restoreFocus.current = false }
      return
    }
    let alive = true
    let stream: MediaStream | undefined
    let timer: number | undefined
    const preview = video.current!
    cancel.current?.focus()
    const stop = () => {
      window.clearTimeout(timer)
      stream?.getTracks().forEach(track => track.stop())
      preview.srcObject = null
    }
    const hidden = () => { if (document.hidden) close() }
    document.addEventListener('visibilitychange', hidden)
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
        // Decode on the device; camera images are never uploaded.
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } })
        if (!alive) { stop(); return }
        const decoder = await import('jsqr')
        if (!alive) { stop(); return }
        preview.srcObject = stream
        await preview.play()
        if (!alive) { stop(); return }
        setReady(true)
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('canvas')
        function scan() {
          if (!alive) return
          try {
            if (preview.readyState >= 2 && preview.videoWidth > 0) {
              const scale = Math.min(1, 960 / preview.videoWidth)
              canvas.width = Math.round(preview.videoWidth * scale)
              canvas.height = Math.round(preview.videoHeight * scale)
              context!.drawImage(preview, 0, 0, canvas.width, canvas.height)
              const pixels = context!.getImageData(0, 0, canvas.width, canvas.height)
              const code = decoder.default(pixels.data, pixels.width, pixels.height)
              if (code) {
                if (invitationFromLink(code.data)) {
                  stop(); close(); found.current(code.data); return
                }
                setError('Este QR no es una invitación de POS México. Escanea el QR del dueño.')
              }
            }
            timer = window.setTimeout(scan, 250)
          } catch {
            stop(); setError('No pudimos leer la cámara. Cancela y pega el enlace de invitación.')
          }
        }
        scan()
      } catch (problem) {
        stop()
        if (!alive) return
        const name = problem instanceof Error ? problem.name : ''
        setError(name === 'NotAllowedError'
          ? 'Permite el acceso a la cámara o pega el enlace de invitación.'
          : name === 'NotFoundError'
            ? 'No encontramos una cámara. Pega el enlace de invitación.'
            : 'No pudimos abrir la cámara. Pega el enlace de invitación.')
      }
    }
    void start()
    return () => { alive = false; stop(); document.removeEventListener('visibilitychange', hidden) }
  }, [open])

  return (
    <div className="invitation-scanner flex flex-col gap-3">
      <button ref={button} className="button secondary" type="button" disabled={disabled || open}
        onClick={() => { setError(''); setReady(false); setOpen(true) }}>
        <Camera size={20} aria-hidden="true" />Escanear QR
      </button>
      {open && <section aria-label="Escanear invitación" className="flex flex-col gap-3" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close() }
      }}>
        <video ref={video} muted playsInline aria-label="Vista de la cámara" className="aspect-square w-full rounded-lg bg-ink object-cover" />
        {!error && <p role="status" className="text-sm">{ready ? 'Apunta al QR de la invitación.' : 'Esperando acceso a la cámara…'}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button ref={cancel} className="button secondary" type="button" onClick={close}>Cancelar escaneo</button>
      </section>}
    </div>
  )
}
