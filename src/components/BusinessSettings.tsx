import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { accountRequest, AccountClientError } from '../lib/account'
import type { BusinessContext, BusinessProfile, BusinessType, PaymentMethod } from '../lib/contracts'
import './account-management.css'

interface BusinessSettingsProps {
  business: BusinessContext
  operatorToken: string
  onSaved: (business: BusinessContext) => void
  onBack: () => void
  onSessionError?: (error: AccountClientError) => void
}

const timezones = [
  ['America/Mexico_City', 'Ciudad de México'], ['America/Cancun', 'Cancún'],
  ['America/Monterrey', 'Monterrey'], ['America/Mazatlan', 'Mazatlán'],
  ['America/Hermosillo', 'Hermosillo'], ['America/Tijuana', 'Tijuana'],
]
const paymentOptions: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Efectivo' }, { value: 'card_external', label: 'Tarjeta externa' }, { value: 'transfer', label: 'Transferencia' },
]
const emptyProfile: BusinessProfile = { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] }

export default function BusinessSettings({ business, operatorToken, onSaved, onBack, onSessionError }: BusinessSettingsProps) {
  const [name, setName] = useState(business.name)
  const [businessType, setBusinessType] = useState<BusinessType>(business.businessType)
  const [timezone, setTimezone] = useState(business.timezone)
  const [profile, setProfile] = useState<BusinessProfile>({ ...emptyProfile, ...business.profile })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [denied, setDenied] = useState(business.role !== 'owner')
  const saving = useRef(false)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  function changeProfile<K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) {
    setProfile((previous) => ({ ...previous, [key]: value }))
    setSaved(false)
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving.current || denied) return
    const normalizedName = name.trim().replace(/\s+/g, ' ')
    if (normalizedName.length < 2 || normalizedName.length > 100) { setError('Escribe un nombre de 2 a 100 caracteres.'); return }
    if (!profile.branchName.trim() || !profile.registerName.trim()) { setError('Escribe el nombre de la sucursal y la caja.'); return }
    if (!profile.paymentMethods.length) { setError('Elige al menos un método de pago.'); return }
    if (profile.contactPhone.trim() && !/^[+0-9() -]{5,30}$/.test(profile.contactPhone.trim())) { setError('Revisa el teléfono del negocio. Usa números y, si hace falta, el código de país.'); return }
    saving.current = true
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const updated = await accountRequest({ action: 'update_business', businessId: business.id, operatorToken,
        name: normalizedName, businessType, timezone,
        profile: { ...profile, branchName: profile.branchName.trim(), registerName: profile.registerName.trim(),
          address: profile.address.trim(), city: profile.city.trim(), state: profile.state.trim(), contactPhone: profile.contactPhone.trim() },
      })
      if (!mounted.current) return
      setName(updated.name)
      setProfile(updated.profile)
      setSaved(true)
      onSaved(updated)
    } catch (caught) {
      if (!mounted.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar los cambios. Intenta de nuevo.')
      if (caught instanceof AccountClientError && ['AUTH_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'BUSINESS_ACCESS_DENIED', 'PERMISSION_DENIED', 'REAUTH_REQUIRED'].includes(caught.code)) {
        setDenied(true)
        onSessionError?.(caught)
      }
    } finally { saving.current = false; if (mounted.current) setBusy(false) }
  }

  return <div className="management-shell">
    <button type="button" className="back-button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />Volver</button>
    <div className="management-heading"><h1>Datos del negocio</h1><p>Configura tu primera sucursal y caja.</p></div>
    {error && <p className="error-message" role="alert">{error}</p>}
    {saved && <p className="management-success" role="status">Cambios guardados.</p>}
    {denied ? <p className="management-warning">Sólo el dueño puede editar los datos del negocio.</p> : <form className="management-form" onSubmit={save}>
      <div className="field"><label htmlFor="settings-name">Nombre del negocio</label><input id="settings-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false) }} minLength={2} maxLength={100} required disabled={busy} /></div>
      <div className="field"><label htmlFor="settings-type">Tipo de negocio</label><select id="settings-type" value={businessType} onChange={(event) => { setBusinessType(event.target.value as BusinessType); setSaved(false) }} disabled={busy}><option value="cafe">Cafetería</option><option value="restaurant">Restaurante</option><option value="other">Otro</option></select></div>
      <div className="field"><label htmlFor="settings-timezone">Zona horaria</label><select id="settings-timezone" value={timezone} onChange={(event) => { setTimezone(event.target.value); setSaved(false) }} disabled={busy}>{!timezones.some(([value]) => value === timezone) && <option value={timezone}>{timezone}</option>}{timezones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div className="management-fields-row"><div className="field"><label htmlFor="settings-branch">Sucursal</label><input id="settings-branch" value={profile.branchName} onChange={(event) => changeProfile('branchName', event.target.value)} maxLength={100} required disabled={busy} /></div><div className="field"><label htmlFor="settings-register">Caja</label><input id="settings-register" value={profile.registerName} onChange={(event) => changeProfile('registerName', event.target.value)} maxLength={100} required disabled={busy} /></div></div>
      <div className="field"><label htmlFor="settings-address">Dirección <span>(opcional)</span></label><input id="settings-address" autoComplete="street-address" value={profile.address} onChange={(event) => changeProfile('address', event.target.value)} maxLength={200} disabled={busy} /></div>
      <div className="management-fields-row"><div className="field"><label htmlFor="settings-city">Ciudad <span>(opcional)</span></label><input id="settings-city" autoComplete="address-level2" value={profile.city} onChange={(event) => changeProfile('city', event.target.value)} maxLength={100} disabled={busy} /></div><div className="field"><label htmlFor="settings-state">Estado <span>(opcional)</span></label><input id="settings-state" autoComplete="address-level1" value={profile.state} onChange={(event) => changeProfile('state', event.target.value)} maxLength={100} disabled={busy} /></div></div>
      <div className="field"><label htmlFor="settings-phone">Teléfono del negocio <span>(opcional)</span></label><input id="settings-phone" type="tel" autoComplete="tel" value={profile.contactPhone} onChange={(event) => changeProfile('contactPhone', event.target.value)} maxLength={30} disabled={busy} /></div>
      <fieldset><legend>Métodos de pago</legend>{paymentOptions.map(({ value, label }) => <label className="management-checkbox" key={value}><input type="checkbox" checked={profile.paymentMethods.includes(value)} disabled={busy} onChange={(event) => changeProfile('paymentMethods', event.target.checked ? [...profile.paymentMethods, value] : profile.paymentMethods.filter((method) => method !== value))} />{label}</label>)}<p className="field-help">La tarjeta se cobra en tu terminal externa. Las ventas estarán disponibles próximamente.</p></fieldset>
      <div className="management-actions"><button className="button primary" disabled={busy} aria-busy={busy}>{busy ? 'Guardando…' : 'Guardar cambios'}</button></div>
    </form>}
  </div>
}
