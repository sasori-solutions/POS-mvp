/** Convert wall time in the business timezone, rejecting DST gaps and ambiguity. */
export function serviceLocalInput(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp))
  const value = (name: string) => parts.find(part => part.type === name)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}
export function serviceLocalTimestamp(wallTime: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(wallTime)) return null
  const naive = Date.parse(wallTime + ':00Z')
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== wallTime) return null
  try {
    const candidates = new Set<string>()
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = naive + hours * 3_600_000
      const offset = Date.parse(serviceLocalInput(new Date(sample).toISOString(), timezone) + ':00Z') - sample
      const candidate = new Date(naive - offset).toISOString()
      if (serviceLocalInput(candidate, timezone) === wallTime) candidates.add(candidate)
    }
    return candidates.size === 1 ? [...candidates][0] : null
  } catch { return null }
}
