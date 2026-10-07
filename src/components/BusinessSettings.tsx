import { useEffect, useRef, useState } from "react";
import { AccessButtonContent } from "./AccessBusy";
import { accountRequest, AccountClientError } from "../lib/account";
import PointSetup from './PointSetup';
import { usePoint } from './usePoint';
import { collectionPaymentMethods, paymentLabels } from '../lib/payment-methods';
import { businessTimezones, businessDefaultVat } from '../lib/business-profile';
import BusinessOperationFields from './BusinessOperationFields';
import ProfileImageEditor from './ProfileImageEditor';
import './business-profile.css';
import type {
  BusinessContext,
  BusinessProfile,
  BusinessType,
  PaymentMethod,
} from "../lib/contracts";

interface BusinessSettingsProps {
  business: BusinessContext;
  operatorToken: string;
  focusPaymentMethods?: boolean;
  onSaved: (business: BusinessContext) => void;
  onBack: () => void;
  onSessionError?: (error: AccountClientError) => void;
}

const paymentOptions: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Efectivo" },
  { value: "card_external", label: paymentLabels.card_external },
  { value: "card_integrated", label: paymentLabels.card_integrated },
  { value: "transfer", label: "Transferencia" },
];
const emptyProfile: BusinessProfile = {
  branchName: "",
  registerName: "",
  address: "",
  city: "",
  state: "",
  contactPhone: "",
  paymentMethods: ["cash"],
};
function profileSignature(profile: BusinessProfile) {
  // PostgreSQL JSON key ordering and older seven-key responses are equivalent
  // to the displayed defaults. Method identifiers remain exact for conversion.
  return JSON.stringify({
    branchName: profile.branchName, registerName: profile.registerName,
    address: profile.address, city: profile.city, state: profile.state, contactPhone: profile.contactPhone,
    paymentMethods: profile.paymentMethods,
    accountsEnabled: profile.accountsEnabled !== false,
    defaultVatTreatment: businessDefaultVat(profile), logoImageId: profile.logoImageId ?? null,
  });
}

export default function BusinessSettings({
  business,
  operatorToken,
  focusPaymentMethods = false,
  onSaved,
  onSessionError,
}: BusinessSettingsProps) {
  const [name, setName] = useState(business.name);
  const [businessType, setBusinessType] = useState<BusinessType>(
    business.businessType,
  );
  const [timezone, setTimezone] = useState(business.timezone);
  const [profile, setProfile] = useState<BusinessProfile>({
    ...emptyProfile,
    ...business.profile,
    paymentMethods: collectionPaymentMethods(business.profile.paymentMethods),
    accountsEnabled: business.profile.accountsEnabled !== false,
    defaultVatTreatment: businessDefaultVat(business.profile),
    logoImageId: business.profile.logoImageId ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [denied, setDenied] = useState(business.role !== "owner");
  const [pointSetup, setPointSetup] = useState(false);
  const paymentMethodInput = useRef<HTMLInputElement>(null);
  const paymentFocusPending = useRef(false);
  const pointAccess = { businessId: business.id, operatorToken };
  const point = usePoint(pointAccess, business.role === 'owner', onSessionError);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!pointSetup && (focusPaymentMethods || paymentFocusPending.current)) {
      paymentMethodInput.current?.focus();
      paymentMethodInput.current?.scrollIntoView?.({ block: 'center' });
      paymentFocusPending.current = false;
    }
  }, [pointSetup, focusPaymentMethods]);

  function changeProfile<K extends keyof BusinessProfile>(
    key: K,
    value: BusinessProfile[K],
  ) {
    setProfile((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || denied || imageBusy) return;
    const normalizedName = name.trim().replace(/\s+/g, " ");
    if (normalizedName.length < 2 || normalizedName.length > 100) {
      setError("Escribe un nombre de 2 a 100 caracteres.");
      return;
    }
    if (!profile.branchName.trim() || !profile.registerName.trim()) {
      setError("Escribe el nombre de la sucursal y la caja.");
      return;
    }
    if (!profile.paymentMethods.length) {
      setError("Elige al menos un método de pago.");
      return;
    }
    if (
      profile.contactPhone.trim() &&
      !/^[+0-9() -]{5,30}$/.test(profile.contactPhone.trim())
    ) {
      setError(
        "Revisa el teléfono del negocio. Usa números y, si hace falta, el código de país.",
      );
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      // Image operations own this reference; a delayed form save must preserve
      // the current server logo, including a concurrently completed upload.
      const editableProfile = { ...profile };
      delete editableProfile.logoImageId;
      const updated = await accountRequest({
        action: "update_business",
        businessId: business.id,
        operatorToken,
        name: normalizedName,
        businessType,
        timezone,
        profile: {
          ...editableProfile,
          branchName: profile.branchName.trim(),
          registerName: profile.registerName.trim(),
          address: profile.address.trim(),
          city: profile.city.trim(),
          state: profile.state.trim(),
          contactPhone: profile.contactPhone.trim(),
        },
      });
      if (!mounted.current) return;
      setName(updated.name);
      setProfile(updated.profile);
      setSaved(true);
      onSaved(updated);
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "No pudimos guardar los cambios. Intenta de nuevo.",
      );
      if (
        caught instanceof AccountClientError &&
        [
          "AUTH_REQUIRED",
          "SESSION_INVALID",
          "SESSION_EXPIRED",
          "BUSINESS_ACCESS_DENIED",
          "PERMISSION_DENIED",
          "REAUTH_REQUIRED",
        ].includes(caught.code)
      ) {
        setDenied(true);
        onSessionError?.(caught);
      }
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const dirty =
    name !== business.name ||
    businessType !== business.businessType ||
    timezone !== business.timezone ||
    profileSignature(profile) !== profileSignature({ ...emptyProfile, ...business.profile });

  if (pointSetup) return <PointSetup access={pointAccess} controller={point} paymentMethodEnabled={business.profile.paymentMethods.includes('card_integrated')} onOpenPaymentMethods={() => { paymentFocusPending.current = true; setPointSetup(false); }} onBack={() => setPointSetup(false)} onSessionError={onSessionError} />;
  return (
    <div className="management-shell management-polish settings-polish business-profile-settings">
      <div className="management-heading mb-8"><h1>Configuración</h1></div>
      {error && <p className="mb-6 text-sm text-danger" role="alert">{error}</p>}
      {saved && <p className="mb-6 text-sm text-success" role="status">Cambios guardados.</p>}
      {denied ? <p className="text-sm text-muted">Sólo el dueño puede editar el negocio.</p> : <>
        <ProfileImageEditor business={business} operatorToken={operatorToken} subject="business" name={name || business.name}
          disabled={busy} onBusyChange={setImageBusy}
          onSaved={updated => { setProfile(previous => ({ ...previous, logoImageId: updated.profile.logoImageId ?? null })); onSaved(updated); }} onSessionError={onSessionError} />
        <form className="management-form my-6 flex flex-col" onSubmit={save}>
          <fieldset className="settings-group">
            <legend>Negocio</legend>
            <div className="settings-fields-grid">
              <div className="field"><label htmlFor="settings-name">Nombre</label><input id="settings-name" value={name} onChange={event => { setName(event.target.value); setSaved(false); }} minLength={2} maxLength={100} required disabled={busy} /></div>
              <div className="field"><label htmlFor="settings-type">Tipo de negocio</label><select id="settings-type" value={businessType} onChange={event => { setBusinessType(event.target.value as BusinessType); setSaved(false); }} disabled={busy}><option value="cafe">Cafetería</option><option value="restaurant">Restaurante</option><option value="other">Otro</option></select></div>
              <div className="field"><label htmlFor="settings-timezone">Zona horaria</label><select id="settings-timezone" value={timezone} onChange={event => { setTimezone(event.target.value); setSaved(false); }} disabled={busy}>
                {!businessTimezones.some(([value]) => value === timezone) && <option value={timezone}>{timezone}</option>}
                {businessTimezones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select></div>
            </div>
          </fieldset>
          <div className="settings-operation">
            <BusinessOperationFields profile={profile} onChange={value => { setProfile(value); setSaved(false); }} disabled={busy} prefix="settings" />
          </div>
          <fieldset className="settings-group">
            <legend>Formas de pago</legend>
            <div className="flex flex-wrap gap-3">
              {paymentOptions.map(({ value, label }) => <label className="management-checkbox flex min-h-12 items-center gap-3 rounded-lg border border-line px-4 [&_input]:size-5" key={value}>
                <input type="checkbox" ref={value === 'card_integrated' ? paymentMethodInput : undefined} checked={profile.paymentMethods.includes(value)} disabled={busy} onChange={event => changeProfile('paymentMethods', event.target.checked ? [...profile.paymentMethods, value] : profile.paymentMethods.filter(method => method !== value))} />{label}
              </label>)}
            </div>
            <p className="mt-3 text-sm text-muted">Tarjeta externa registra un pago aprobado en la terminal del comercio. Mercado Pago Point envía el cobro a una terminal vinculada.</p>
            <button type="button" className="pos-button pos-secondary mt-4" disabled={busy} onClick={() => setPointSetup(true)}>Vincular una terminal</button>
          </fieldset>
          <details className="business-extra-settings">
            <summary>Sucursal y contacto</summary>
            <div className="business-extra-fields">
              {([
                ['branchName', 'Sucursal', true], ['registerName', 'Caja', true], ['address', 'Dirección', false],
                ['city', 'Ciudad', false], ['state', 'Estado', false], ['contactPhone', 'Teléfono', false],
              ] as const).map(([key, label, required]) => <div className="field" key={key}>
                <label htmlFor={`settings-${key}`}>{label}</label>
                <input id={`settings-${key}`} value={profile[key]} maxLength={key === 'address' ? 300 : key === 'contactPhone' ? 30 : 100} type={key === 'contactPhone' ? 'tel' : 'text'} required={required} disabled={busy} onChange={event => changeProfile(key, event.target.value)} />
              </div>)}
            </div>
          </details>
          <div className="management-actions flex flex-wrap gap-3">
            <button className="button primary" disabled={busy || imageBusy || !dirty} aria-busy={busy}><AccessButtonContent busy={busy}>Guardar cambios</AccessButtonContent></button>
          </div>
        </form>
      </>}
    </div>
  );
}
