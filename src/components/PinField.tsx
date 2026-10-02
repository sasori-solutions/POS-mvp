export default function PinField({ label, value, onChange, confirm = false, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void; confirm?: boolean; disabled?: boolean
}) {
  const id = confirm ? 'pin-confirm-input' : 'pin-input'
  return <div className="field pin-field">
    <label htmlFor={id}>{label}</label>
    <div className="pin-control">
      <input id={id} data-testid={id} type="password" inputMode="numeric" pattern="[0-9]*"
        maxLength={6} autoComplete="off" value={value} disabled={disabled}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        aria-describedby="pin-help" />
      <div className="pin-slots" aria-hidden="true">{Array.from({ length: 6 }, (_, index) =>
        <span key={index} className={value.length > index ? 'filled' : ''}>{value.length > index ? '●' : ''}</span>,
      )}</div>
    </div>
  </div>
}

