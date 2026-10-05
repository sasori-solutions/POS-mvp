import { useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Coffee, Store, Utensils } from 'lucide-react';
import type { BusinessProfile, BusinessType } from '../lib/contracts';
import { businessTimezones } from '../lib/business-profile';
import BusinessOperationFields from './BusinessOperationFields';
import './business-profile.css';

export interface BusinessDraft {
  name: string; businessType: BusinessType; timezone: string; profile: BusinessProfile;
}

export default function BusinessSetup({ draft, onChange, onSubmit, error }: {
  draft: BusinessDraft; onChange: (draft: BusinessDraft) => void; onSubmit: (event: FormEvent) => void; error: string;
}) {
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  function changeStep(next: number) {
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    if (step === 0) { event.preventDefault(); changeStep(1); }
    else onSubmit(event);
  }
  const setProfile = (profile: BusinessProfile) => onChange({ ...draft, profile });
  return <section className="access-flow screen business-setup">
    <ol className="business-setup-progress" aria-label="Crear negocio">
      {['Negocio', 'Operación', 'PIN'].map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined} className={index <= step ? 'current' : ''}><span aria-hidden="true">{index + 1}</span>{label}</li>)}
    </ol>
    <h1 ref={heading} tabIndex={-1}>{step === 0 ? 'Tu negocio' : 'Tu forma de trabajar'}</h1>
    <form onSubmit={submit}>
      {step === 0 ? <>
        <div className="field">
          <label htmlFor="business-name">Nombre del negocio</label>
          <input id="business-name" name="businessName" autoComplete="organization" placeholder="Nombre del negocio" minLength={2} maxLength={100} required value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} />
        </div>
        <fieldset className="business-choice-group">
          <legend>Tipo de negocio</legend>
          <div className="business-type-options">
            {[
              { type: 'cafe' as const, label: 'Cafetería', Icon: Coffee },
              { type: 'restaurant' as const, label: 'Restaurante', Icon: Utensils },
              { type: 'other' as const, label: 'Otro', Icon: Store },
            ].map(({ type, label, Icon }) => <label key={type} className={`business-type-choice${draft.businessType === type ? ' selected' : ''}`}>
              <input type="radio" name="business-type" value={type} checked={draft.businessType === type} onChange={() => onChange({ ...draft, businessType: type, profile: { ...draft.profile, accountsEnabled: type === 'restaurant' } })} />
              <Icon size={24} aria-hidden="true" /><span>{label}</span>
            </label>)}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="business-timezone">Zona horaria</label>
          <select id="business-timezone" value={draft.timezone} onChange={event => onChange({ ...draft, timezone: event.target.value })}>{businessTimezones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
      </> : <>
        <BusinessOperationFields profile={draft.profile} onChange={setProfile} />
        <fieldset className="business-choice-group">
          <legend>Formas de pago</legend>
          <div className="flex flex-wrap gap-3">
            {([['cash', 'Efectivo'], ['card_integrated', 'Tarjeta'], ['transfer', 'Transferencia']] as const).map(([value, label]) => <label className="flex min-h-12 items-center gap-3 rounded-lg border border-line px-4 [&_input]:size-5" key={value}>
              <input type="checkbox" checked={draft.profile.paymentMethods.includes(value)} onChange={event => setProfile({ ...draft.profile, paymentMethods: event.target.checked ? [...draft.profile.paymentMethods, value] : draft.profile.paymentMethods.filter(method => method !== value) })} />{label}
            </label>)}
          </div>
        </fieldset>
        <details className="business-extra-settings">
          <summary>Sucursal y contacto</summary>
          <div className="business-extra-fields">
            {([
              ['branchName', 'Sucursal', true], ['registerName', 'Caja', true],
              ['address', 'Dirección', false], ['city', 'Ciudad', false], ['state', 'Estado', false], ['contactPhone', 'Teléfono', false],
            ] as const).map(([key, label, required]) => <div className="field" key={key}>
              <label htmlFor={`profile-${key}`}>{label}</label>
              <input id={`profile-${key}`} value={draft.profile[key]} required={required} maxLength={key === 'address' ? 300 : key === 'contactPhone' ? 30 : 100} type={key === 'contactPhone' ? 'tel' : 'text'} onChange={event => setProfile({ ...draft.profile, [key]: event.target.value })} />
            </div>)}
          </div>
        </details>
      </>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="business-setup-actions">
        {step === 1 && <button type="button" className="button secondary" onClick={() => changeStep(0)}><ArrowLeft size={20} aria-hidden="true" />Anterior</button>}
        <button className="button primary" type="submit">Continuar<ArrowRight size={20} aria-hidden="true" /></button>
      </div>
    </form>
  </section>;
}
