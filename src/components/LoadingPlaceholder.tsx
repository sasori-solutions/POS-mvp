import type { CSSProperties } from 'react'
import { LoaderCircle } from 'lucide-react'

export function PendingIndicator({ label = 'Procesando', size = 18 }: { label?: string; size?: number }) {
  return <span className="ui-pending" role="status" aria-label={label}><LoaderCircle size={size} aria-hidden="true" /></span>
}

export function Skeleton({ className = '', width, height }: { className?: string; width?: string | number; height?: string | number }) {
  return <span aria-hidden="true" className={`ui-skeleton ${className}`} style={{ width, height } as CSSProperties} />
}

/** Content-shaped first-load state. Background refreshes keep the last valid data. */
export default function LoadingPlaceholder({ variant = 'list', rows = 4, dark = false, className = '', label = 'Cargando', filters = true }: {
  variant?: 'list' | 'form' | 'catalog' | 'cards' | 'detail' | 'chart' | 'page'
  rows?: number
  dark?: boolean
  className?: string
  label?: string
  filters?: boolean
}) {
  return <div role="status" aria-label={label} aria-busy="true" className={`ui-placeholder ui-placeholder-${variant}${dark ? ' ui-placeholder-dark' : ''} ${className}`}>
    {variant === 'catalog' ? <>{filters && <div className="ui-placeholder-search"><Skeleton height={48} /><Skeleton width="60%" height={40} /></div>}<div className="ui-placeholder-catalog">{Array.from({ length: rows }, (_, i) => <div key={i}><Skeleton className="ui-placeholder-image" /><Skeleton width="72%" height={18} /><Skeleton width="38%" height={18} /></div>)}</div></>
      : variant === 'chart' ? <><Skeleton width="35%" height={24} /><Skeleton width="45%" height={40} /><Skeleton height={220} /></>
      : variant === 'cards' ? <div className="ui-placeholder-cards">{Array.from({ length: rows }, (_, i) => <div key={i}><Skeleton width="50%" height={16} /><Skeleton width="70%" height={36} /><Skeleton width="40%" height={14} /></div>)}</div>
      : variant === 'form' || variant === 'page' ? <><Skeleton width="55%" height={32} /><Skeleton width="75%" height={18} />{Array.from({ length: rows }, (_, i) => <div className="ui-placeholder-field" key={i}><Skeleton width="30%" height={14} /><Skeleton height={52} /></div>)}<Skeleton height={52} /></>
      : <>{variant === 'detail' && <><Skeleton width="50%" height={24} /><Skeleton width="40%" height={40} /></>}{Array.from({ length: rows }, (_, i) => <div className="ui-placeholder-row" key={i}><Skeleton className="ui-placeholder-avatar" /><div><Skeleton width={i % 2 ? '65%' : '82%'} height={18} /><Skeleton width="42%" height={14} /></div><Skeleton width={56} height={20} /></div>)}</>}
  </div>
}
