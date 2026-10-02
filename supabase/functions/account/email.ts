interface RecoveryMail { id: string; email: string; token: string }
export interface MailConfiguration { from: string; appOrigin: string; apiKey?: string; localMailpit?: string }

export function mailConfiguration(env: (name: string) => string | undefined): MailConfiguration | null {
  const appOrigin = env('APP_ORIGIN') ?? ''
  const from = env('PIN_RECOVERY_FROM') ?? ''
  try {
    const origin = new URL(appOrigin)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    if (origin.origin !== appOrigin || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) || !from || /[\r\n]/.test(from)) return null
    const localMailpit = env('TEST_MAILPIT_URL')
    if (localMailpit && local && env('ALLOW_TEST_PASSWORD_AUTH') === 'true') {
      const mailpit = new URL(localMailpit)
      if (['localhost', '127.0.0.1', 'host.docker.internal', 'supabase_inbucket_pos-mexico-pwa'].includes(mailpit.hostname) && mailpit.protocol === 'http:') return { from, appOrigin, localMailpit }
    }
    const apiKey = env('RESEND_API_KEY')
    return apiKey ? { from, appOrigin, apiKey } : null
  } catch { return null }
}

export async function sendPinRecovery(mail: RecoveryMail, config: MailConfiguration): Promise<boolean> {
  // Fragment stays out of HTTP access logs and Referer. The PWA removes it before rendering.
  const link = `${config.appOrigin}/recover-pin#recovery=${mail.token}`
  const subject = 'Confirma el cambio de tu PIN · POS México'
  const text = `Recibimos una solicitud para cambiar tu PIN.\n\nAbre este enlace para elegir uno nuevo:\n${link}\n\nEl enlace vence en 15 minutos y sólo se puede usar una vez.\nSi no solicitaste el cambio, ignora este correo. Tu PIN seguirá igual.`
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:32px auto;color:#171717"><p>POS México</p><h1 style="font-size:26px">Cambia tu PIN</h1><p>Recibimos una solicitud para cambiar tu PIN.</p><p style="margin:32px 0"><a href="${link}" style="background:#171717;color:white;padding:14px 22px;border-radius:8px;text-decoration:none;display:inline-block">Elegir nuevo PIN</a></p><p>El enlace vence en 15 minutos y sólo se puede usar una vez.</p><p style="color:#666">Si no solicitaste el cambio, ignora este correo. Tu PIN seguirá igual.</p></div>`
  try {
    const response = config.localMailpit
      ? await fetch(`${config.localMailpit}/api/v1/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ From: { Email: config.from, Name: 'POS México' }, To: [{ Email: mail.email }], Subject: subject, Text: text, HTML: html }), signal: AbortSignal.timeout(8_000) })
      : await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`, 'Idempotency-Key': `pin-recovery/${mail.id}` }, body: JSON.stringify({ from: config.from, to: [mail.email], subject, text, html }), signal: AbortSignal.timeout(8_000) })
    // Do not log provider responses: they can contain recipient information.
    if (!response.ok) return false
    const result = await response.json()
    return config.localMailpit ? typeof result.ID === 'string' : typeof result.id === 'string'
  } catch { return false }
}
