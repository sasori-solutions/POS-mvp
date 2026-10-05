import type { BusinessProfile, BusinessType } from './contracts';
import type { VatTreatment } from './pos-contracts';

export const businessTimezones = [
  ['America/Mexico_City', 'Ciudad de México'],
  ['America/Cancun', 'Cancún'],
  ['America/Monterrey', 'Monterrey'],
  ['America/Mazatlan', 'Mazatlán'],
  ['America/Hermosillo', 'Hermosillo'],
  ['America/Tijuana', 'Tijuana'],
] as const;

export const businessVatOptions: { value: VatTreatment; label: string }[] = [
  { value: 'vat_16', label: 'IVA 16 %' },
  { value: 'vat_0', label: 'IVA tasa 0 %' },
  { value: 'exempt', label: 'Exento de IVA' },
  { value: 'border_8', label: 'IVA 8 % · Frontera' },
  { value: 'unconfigured', label: 'Definir por producto' },
];

export function newBusinessProfile(type: BusinessType = 'cafe'): BusinessProfile {
  return {
    branchName: 'Sucursal principal', registerName: 'Caja 1',
    address: '', city: '', state: '', contactPhone: '',
    paymentMethods: ['cash', 'card_integrated'],
    accountsEnabled: type === 'restaurant', defaultVatTreatment: 'vat_16', logoImageId: null,
  };
}

/** Missing flags keep existing businesses and existing catalog defaults compatible. */
export function businessAccountsEnabled(profile: BusinessProfile) { return profile.accountsEnabled !== false; }
export function businessDefaultVat(profile: Pick<BusinessProfile, 'defaultVatTreatment'>): VatTreatment {
  return profile.defaultVatTreatment ?? 'vat_16';
}
