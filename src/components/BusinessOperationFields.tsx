import { Check, ReceiptText, ShoppingBag } from 'lucide-react';
import type { BusinessProfile } from '../lib/contracts';
import { businessVatOptions } from '../lib/business-profile';

export default function BusinessOperationFields({ profile, onChange, disabled = false, prefix = 'business', taxSelectionPending = false, onTaxSelected }: {
  profile: BusinessProfile; onChange: (profile: BusinessProfile) => void; disabled?: boolean; prefix?: string; taxSelectionPending?: boolean; onTaxSelected?: () => void;
}) {
  const accounts = profile.accountsEnabled !== false;
  return <>
    <fieldset className="business-choice-group">
      <legend>Cómo cobras</legend>
      <div className="business-operation-options">
        {[
          { enabled: false, Icon: ShoppingBag, title: 'Cobro directo', description: 'Cobra primero; el pago genera la comanda.' },
          { enabled: true, Icon: ReceiptText, title: 'Cuentas abiertas', description: 'Guarda y modifica la cuenta, envía comandas y cobra al final.' },
        ].map(({ enabled, Icon, title, description }) => <label key={title} className={`business-operation-choice${accounts === enabled ? ' selected' : ''}`}>
          <input type="radio" name={`${prefix}-account-mode`} value={String(enabled)} checked={accounts === enabled} disabled={disabled} onChange={() => onChange({ ...profile, accountsEnabled: enabled })} />
          <Icon size={23} aria-hidden="true" />
          <span><strong>{title}</strong><small>{description}</small></span>
          {accounts === enabled && <Check size={18} aria-hidden="true" />}
        </label>)}
      </div>
    </fieldset>
    <div className="field">
      <label htmlFor={`${prefix}-vat`}>{prefix === 'business' ? '¿Qué IVA usas en tus precios?' : 'IVA para productos nuevos'}</label>
      <select id={`${prefix}-vat`} required value={taxSelectionPending ? '' : profile.defaultVatTreatment ?? 'vat_16'} disabled={disabled} aria-describedby={`${prefix}-vat-help`} onChange={event => { onTaxSelected?.(); onChange({ ...profile, defaultVatTreatment: event.target.value as BusinessProfile['defaultVatTreatment'] }); }}>
        {taxSelectionPending && <option value="" disabled>Selecciona una opción</option>}
        {businessVatOptions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
      <p id={`${prefix}-vat-help`} className="field-help text-sm text-muted">Los precios finales incluyen el IVA. Puedes elegir una tasa distinta en cada producto; las ventas anteriores conservan su impuesto.</p>
      {profile.defaultVatTreatment === 'border_8' && <p className="field-help text-sm text-muted">Usa el 8 % únicamente si tu negocio cumple los requisitos del estímulo fronterizo.</p>}
    </div>
  </>;
}
