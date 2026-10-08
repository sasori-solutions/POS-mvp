export const maxAmountCents = 99_999_999;
export const maxAmountConceptLength = 100;

/** Decimal text becomes integer cents without a floating point conversion. */
export function parseAmountCents(value: string): number | null {
  const text = value.trim().replace(',', '.');
  if (!/^(?:\d{1,6}(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) return null;
  const [whole = '', fraction = ''] = text.split('.');
  const cents = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
  return cents > 0 && cents <= maxAmountCents ? cents : null;
}

export function amountKey(value: string, key: string): string {
  if (key === 'clear') return '';
  if (key === 'backspace') return value.slice(0, -1);
  if (key === '.' || key === ',') return value.includes('.') || value.includes(',') ? value : `${value || '0'}.`;
  if (!/^\d$/.test(key)) return value;
  if (/[.,]\d{2}$/.test(value) || !/[.,]/.test(value) && value.replace(/^0+/, '').length >= 6) return value;
  return value === '0' ? key : `${value}${key}`;
}
