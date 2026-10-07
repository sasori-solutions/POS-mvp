import { useState } from 'react'
import { Copy } from 'lucide-react'
import type { TransferAccount } from '../lib/contracts'

export default function TransferConfirmation({ account, checked, onChange, disabled }: {
  account?: TransferAccount | null
  checked: boolean
  onChange: (checked: boolean) => void
  disabled: boolean
}) {
  const [copyMessage, setCopyMessage] = useState('')
  async function copyClabe() {
    if (!account) return
    try {
      await navigator.clipboard.writeText(account.clabe)
      setCopyMessage('CLABE copiada.')
    } catch { setCopyMessage('No pudimos copiar. Selecciona la CLABE para compartirla.') }
  }
  return <div className="flex flex-col gap-3 text-sm">
    {account && <section className="flex flex-col gap-2 rounded-xl border border-line p-4" aria-label="Datos para la transferencia">
      <strong>{account.beneficiary}</strong>
      <span>{account.bank}</span>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="select-all break-all font-medium">CLABE {account.clabe}</span><button type="button" className="pos-button pos-secondary" onClick={() => void copyClabe()}><Copy size={16} aria-hidden="true" />Copiar CLABE</button></div>
      {copyMessage && <p role="status">{copyMessage}</p>}
    </section>}
    <p>Comprueba el abono en la cuenta del comercio antes de registrar el pago.</p>
    <label className="ops-check flex min-h-12 items-center gap-3">
      <input type="checkbox" className="size-5 shrink-0" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>Confirmo que el comercio recibió esta transferencia.</span>
    </label>
  </div>
}
