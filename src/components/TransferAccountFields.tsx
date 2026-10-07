import type { TransferAccount } from '../lib/contracts';

export default function TransferAccountFields({ value, onChange, disabled = false, prefix = 'transfer' }: {
  value: TransferAccount | null; onChange: (value: TransferAccount | null) => void; disabled?: boolean; prefix?: string;
}) {
  return <fieldset className="settings-group">
    <legend>Cuenta para recibir transferencias</legend>
    <p className="mb-4 text-sm text-muted">Opcional. Estos datos se muestran al cajero al cobrar por transferencia. Confirma el depósito antes de registrar el pago.</p>
    {!value ? <button type="button" className="button secondary" disabled={disabled} onClick={() => onChange({ beneficiary: '', bank: '', clabe: '' })}>Añadir cuenta bancaria</button> : <>
      <div className="settings-fields-grid">
        <div className="field"><label htmlFor={`${prefix}-beneficiary`}>Beneficiario</label><input id={`${prefix}-beneficiary`} value={value.beneficiary} maxLength={100} required disabled={disabled} autoComplete="off" onChange={event => onChange({ ...value, beneficiary: event.target.value })} /></div>
        <div className="field"><label htmlFor={`${prefix}-bank`}>Banco</label><input id={`${prefix}-bank`} value={value.bank} maxLength={100} required disabled={disabled} autoComplete="off" onChange={event => onChange({ ...value, bank: event.target.value })} /></div>
        <div className="field"><label htmlFor={`${prefix}-clabe`}>CLABE</label><input id={`${prefix}-clabe`} value={value.clabe} maxLength={18} minLength={18} pattern="[0-9]{18}" inputMode="numeric" required disabled={disabled} autoComplete="off" aria-describedby={`${prefix}-help`} onChange={event => onChange({ ...value, clabe: event.target.value.replace(/[^0-9]/g, '').slice(0, 18) })} /></div>
      </div>
      <p id={`${prefix}-help`} className="mt-3 text-sm text-muted">18 dígitos. El POS no accede a tu banco ni confirma depósitos automáticamente.</p>
      <button type="button" className="button secondary mt-4" disabled={disabled} onClick={() => onChange(null)}>Quitar cuenta bancaria</button>
    </>}
  </fieldset>;
}
