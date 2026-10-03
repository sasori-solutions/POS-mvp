export const maxOperationalMoneyCents = 9_999_999_999

/** Parse decimal digits into integer cents, without a binary floating point price. */
export function parseOperationalMoney(value: string): number | null {
  const match = value.trim().replace(',', '.').match(/^(\d{1,8})(?:\.(\d{1,2}))?$/)
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return cents <= maxOperationalMoneyCents ? cents : null
}
