import ReportDashboard, { type ReportTab } from './ReportDashboard'
import type { ReportController } from './usePeriodReport'
export { businessDate } from '../../lib/reporting'

export default function ReportsScreen({ controller, tab, onTabChange }: { controller: ReportController; tab: ReportTab; onTabChange: (tab: ReportTab) => void }) {
  return <ReportDashboard controller={controller} tab={tab} onTabChange={onTabChange} detailed />
}
