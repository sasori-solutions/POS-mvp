// A hostname or a VITE flag alone must never enable password access.
function loopbackBackend() {
  try {
    const url = new URL(import.meta.env.VITE_SUPABASE_URL)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch { return false }
}

export const developmentLoginEnabled = import.meta.env.DEV
  && import.meta.env.MODE === 'development'
  && import.meta.env.VITE_LOCAL_PASSWORD_AUTH === 'true'
  && loopbackBackend()
