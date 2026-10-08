import { useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import { posRequest, type PosAccess } from '../lib/pos'
import type { Sale } from '../lib/pos-contracts'
import { accessErrorCodes } from './useCatalog'
import { PosDialog, SaleDetail } from './PosShared'
import LoadingPlaceholder from './LoadingPlaceholder'

/** Reading a receipt uses the same live authorization as the sales history. */
export default function SaleReceiptDialog(props: Parameters<typeof SaleReceiptSession>[0]) {
  const { access, saleId } = props
  return <SaleReceiptSession key={`${access.businessId}:${access.operatorToken}:${access.deviceToken ?? ''}:${saleId}`} {...props} />
}

function SaleReceiptSession({ access, businessName, saleId, onClose, onSessionError }: {
  access: PosAccess
  businessName: string
  saleId: string
  onClose: () => void
  onSessionError?: (error: AccountClientError) => void
}) {
  const [sale, setSale] = useState<Sale | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const alive = useRef(false), sequence = useRef(0)
  useEffect(() => {
    alive.current = true
    setSale(null)
    void load()
    return () => { alive.current = false; sequence.current++ }
  }, [saleId, access.businessId, access.operatorToken, access.deviceToken])
  async function load() {
    const request = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const accepted = await posRequest(access, { command: 'sale', saleId })
      if (alive.current && sequence.current === request) setSale(accepted)
    } catch (caught) {
      if (!alive.current || sequence.current !== request) return
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar el comprobante. Reintenta desde esta venta.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
    } finally {
      if (alive.current && sequence.current === request) setLoading(false)
    }
  }
  return <PosDialog title="Pago registrado" onClose={onClose}>
    {loading && !sale && <LoadingPlaceholder variant="detail" rows={3} label="Cargando comprobante" />}
    {error && <div role="alert" className="flex flex-col gap-3"><p>{error}</p><button type="button" className="pos-button pos-secondary" disabled={loading} onClick={() => void load()}>Reintentar</button></div>}
    {sale && <SaleDetail sale={sale} businessName={businessName} />}
    <button type="button" className="pos-button pos-primary mt-6 w-full" onClick={onClose}>Listo</button>
  </PosDialog>
}
