import type { BusinessProfile, BusinessType, TransferAccount } from './contracts';
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
  { value: 'unconfigured', label: 'No lo sé todavía · definir por producto' },
];

/** Creation only. A device elsewhere must never rewrite an existing business. */
export function detectedBusinessTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone === 'UTC') return 'Etc/UTC';
    if (/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(timezone)) return timezone;
  } catch { /* Explicit fallback is still editable during creation. */ }
  return 'America/Mexico_City';
}

export function businessTimezoneLabel(timezone: string): string {
  return businessTimezones.find(([value]) => value === timezone)?.[1]
    ?? timezone.split('/').slice(1).join(' / ').replaceAll('_', ' ');
}

export function validClabe(clabe: string): boolean {
  if (!/^[0-9]{18}$/.test(clabe)) return false;
  const sum = Array.from(clabe.slice(0, 17)).reduce((total, digit, index) => total + (Number(digit) * [3, 7, 1][index % 3]) % 10, 0);
  return (10 - sum % 10) % 10 === Number(clabe[17]);
}

export function transferAccountError(value: TransferAccount | null | undefined): string {
  if (!value) return '';
  if (!value.beneficiary.trim() || !value.bank.trim()) return 'Escribe el beneficiario y el banco de la cuenta.';
  if (!validClabe(value.clabe)) return 'Revisa la CLABE: debe tener 18 dígitos y un dígito de verificación válido.';
  return '';
}

export function newBusinessProfile(type: BusinessType = 'cafe'): BusinessProfile {
  return {
    branchName: 'Sucursal principal', registerName: 'Caja 1',
    address: '', city: '', state: '', contactPhone: '',
    paymentMethods: ['cash', 'card_integrated'],
    accountsEnabled: type === 'restaurant', defaultVatTreatment: 'unconfigured', logoImageId: null,
  };
}

/** Missing flags keep existing businesses and existing catalog defaults compatible. */
export function businessAccountsEnabled(profile: BusinessProfile) { return profile.accountsEnabled !== false; }
export function businessDefaultVat(profile: Pick<BusinessProfile, 'defaultVatTreatment'>): VatTreatment {
  return profile.defaultVatTreatment ?? 'vat_16';
}
