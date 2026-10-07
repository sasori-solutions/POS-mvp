export default function ExternalCardConfirmation({ checked, onChange, disabled, refund = false, recovering = false }: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled: boolean
  refund?: boolean
  recovering?: boolean
}) {
  return (
    <div className="external-card-confirmation flex flex-col gap-2 text-sm">
      <p>{recovering
        ? refund ? 'Verifica la devolución original en la terminal del comercio. No la repitas; el POS sólo registra el resultado.' : 'Verifica el pago original en la terminal del comercio. No vuelvas a cobrar; el POS sólo registra el resultado.'
        : refund
        ? 'Realiza la devolución en la terminal del comercio y verifica el resultado original. El POS sólo registra la devolución.'
        : 'Cobra en la terminal del comercio y verifica que el pago esté aprobado. El POS sólo registra el pago.'}</p>
      <label className="ops-check flex min-h-12 items-center gap-3">
        <input type="checkbox" className="size-5 shrink-0" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
        <span>{refund ? 'Confirmo que la devolución se realizó en la terminal externa.' : 'Confirmo que la terminal externa aprobó este pago.'}</span>
      </label>
    </div>
  )
}
