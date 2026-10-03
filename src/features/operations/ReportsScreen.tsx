import type { AccountClientError } from '../../lib/account'
import type { PosAccess } from '../../lib/pos'
import ReportDashboard from './ReportDashboard'
export { businessDate } from '../../lib/reporting'

export default function ReportsScreen({ access, timezone, onSessionError }: { access: PosAccess; timezone: string; onSessionError?: (error: AccountClientError) => void }) {
  return <ReportDashboard access={access} timezone={timezone} onSessionError={onSessionError} detailed />
}
