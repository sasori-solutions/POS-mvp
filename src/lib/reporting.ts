export function businessDate(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('-')
}

export function averageTicket(cents: number, count: number): number | null {
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(count) || count <= 0) return null
  return Number((BigInt(cents) * 2n + BigInt(count)) / (BigInt(count) * 2n))
}

export function changePercent(current: number, previous: number): string | null {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(previous) || previous <= 0) return null
  const bps = Number(((BigInt(current) - BigInt(previous)) * 10000n) / BigInt(previous))
  return `${bps > 0 ? '+' : ''}${(bps / 100).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`
}

export function paymentPercent(cents: number, total: number): string {
  return total > 0 ? `${Number((BigInt(cents) * 1000n + BigInt(total) / 2n) / BigInt(total)) / 10}%` : '—'
}
