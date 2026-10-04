import { useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { PointAdminReport, PointReport, PointSettings } from '../lib/point-contracts'
import { downloadPointCsv, pointRequest } from '../lib/point-client'
import { money, saleDate, type PosAccess } from '../lib/pos'
import { businessDate } from '../lib/reporting'
import { accessErrorCodes } from './useCatalog'
import PointStatements from './PointStatements'

const dateLabel = (value: string, timezone: string) => saleDate(value, timezone)
const seconds = (value: number | null) => value === null ? 'No disponible' : `${Math.round(value).toLocaleString('es-MX')} s`
const metricDefinitions = [
  ['Cobros verificados', 'Pagos Point cuyo importe, MXN, cuenta, entorno y referencia fueron verificados. Fecha de confirmación; un intento no es una venta.'],
  ['Volumen bruto', 'Suma del importe de los pagos verificados, antes de devoluciones. MXN; no acredita depósito bancario.'],
  ['Devoluciones', 'Importes confirmados por el proveedor en su fecha efectiva, incluso de pagos de periodos anteriores.'],
  ['Volumen neto', 'Volumen bruto menos devoluciones confirmadas en el periodo. Puede ser negativo.'],
  ['Ticket promedio', 'Volumen bruto dividido entre la cantidad de pagos verificados. Sin pagos: no disponible.'],
  ['Comisión SASORI', 'Base elegible de producción por tarifa vigente, con numeradores exactos. El cierre mensual suma y redondea una vez. Sandbox y tarjeta externa no devengan comisión.'],
  ['IVA de comisión', 'IVA configurado aplicado a la comisión neta. Es impuesto y no ingreso de SASORI.'],
  ['Periodo previo', 'Periodo inmediatamente anterior con la misma cantidad de fechas locales. El rango actual y previo usan la misma zona horaria.'],
  ['Intentos y rechazos', 'Intentos únicos de producción creados en el rango, con estado al corte. Tasa de rechazo: rechazos definitivos / todos los intentos, incluidos pendientes. Los clics no forman parte de la población.'],
  ['Tiempos p50/p95', 'Percentiles entre creación del intento y confirmación efectiva del proveedor; sólo intentos confirmados con duración no negativa. No mide interacción ni depósito bancario.'],
  ['Contabilidad de comisión', 'Cierres y facturas de los meses tocados por el rango. Saldo: total facturado con IVA menos abonos vinculados a esos documentos. Abonos del rango usan su fecha efectiva y se muestran por separado.'],
  ['Salud de eventos', 'Notificaciones firmadas persistidas: duplicados por huella y demora desde el timestamp firmado hasta recepción. Firmas inválidas son globales sin tenant confiable. Conciliación usa la fecha real de la consulta aceptada.'],
  ['Activación y cohortes', 'Primer pago de producción verificado por comercio. Cohortes por mes del primer pago en UTC; tiempo desde conexión hasta primer pago, excluyendo duraciones negativas. Conectado no significa activo.'],
] as const

export default function PointDashboard(props: Parameters<typeof PointDashboardSession>[0]) {
  return <PointDashboardSession key={`${props.access.businessId}:${props.access.operatorToken}:${props.access.deviceToken ?? ''}:${props.admin ?? false}:${props.admin ? props.settings?.permissions.admin : props.settings?.permissions.reports}`} {...props} />
}

function PointDashboardSession({ access, timezone, settings, admin = false, onSessionError }: {
  access: PosAccess; timezone: string; settings: PointSettings | null; admin?: boolean; onSessionError?: (error: AccountClientError) => void
}) {
  const today = businessDate(timezone), [from, setFrom] = useState(`${today.slice(0, 7)}-01`), [to, setTo] = useState(today)
  const [report, setReport] = useState<PointReport | PointAdminReport | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [loadedRange, setLoadedRange] = useState('')
  const [pageBusy, setPageBusy] = useState(false)
  const alive = useRef(true), running = useRef(false), pageRunning = useRef(false), version = useRef(0), heading = useRef<HTMLHeadingElement>(null)
  const permitted = admin ? settings?.permissions.admin : settings?.permissions.reports
  useEffect(() => { alive.current = true; heading.current?.focus(); return () => { alive.current = false } }, [])
  useEffect(() => { if (permitted) void load() }, [permitted, admin])
  async function load() {
    if (running.current || !permitted || !from || !to || from > to) return
    const request = ++version.current
    pageRunning.current = false; setPageBusy(false)
    running.current = true; setBusy(true); setError('')
    try {
      const result = admin ? await pointRequest(access, { command: 'admin_report', from, to }) : await pointRequest(access, { command: 'merchant_report', from, to })
      if (alive.current && request === version.current) { setReport(result); setLoadedRange(`${from}:${to}`) }
    } catch (caught) {
      if (!alive.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos cargar el reporte.')
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const global = report && 'businesses' in report ? report as PointAdminReport : null
  const counts = [
    ['Volumen bruto verificado', report ? money(report.grossCents) : '—'], ['Devoluciones confirmadas', report ? money(report.refundCents) : '—'],
    ['Volumen neto', report ? money(report.netCents) : '—'], ['Cobros verificados', report?.paymentCount.toLocaleString('es-MX') ?? '—'],
    ['Ticket promedio', report?.averageTicketCents === null || !report ? 'No disponible' : money(report.averageTicketCents)],
    ['Comisión neta SASORI', report ? money(report.commissionNetCents) : '—'], ['IVA de comisión', report ? money(report.commissionVatCents) : '—'], ['Comisión e IVA', report ? money(report.commissionTotalCents) : '—'],
  ]
  async function moreBusinesses() {
    if (!global?.nextCursor || pageRunning.current || running.current) return
    const request = version.current
    pageRunning.current = true; setPageBusy(true)
    try {
      const page = await pointRequest(access, { command: 'admin_report', from: global.from, to: global.to, cursor: global.nextCursor })
      if (alive.current && request === version.current) setReport({ ...global, businesses: [...global.businesses, ...page.businesses], nextCursor: page.nextCursor })
    } catch (caught) { if (alive.current && request === version.current) setError(caught instanceof Error ? caught.message : 'No pudimos cargar la siguiente página.') }
    finally { if (alive.current && request === version.current) { pageRunning.current = false; setPageBusy(false) } }
  }
  async function exportReport() {
    if (!report || pageRunning.current || running.current) return
    const request = version.current
    pageRunning.current = true
    let businesses = global?.businesses ?? []
    let cursor = global?.nextCursor
    setPageBusy(true)
    try {
    for (let page = 0; cursor && page < 100; page++) {
      const next = await pointRequest(access, { command: 'admin_report', from: report.from, to: report.to, cursor })
      if (!alive.current || request !== version.current) return
      businesses = [...businesses, ...next.businesses]; cursor = next.nextCursor
    }
    if (cursor) throw new Error('El detalle excede el límite de exportación. Consulta rangos más pequeños.')
    if (!alive.current || request !== version.current) return
    downloadPointCsv(`point-${admin ? 'sasori' : 'comercio'}-${report.from}-${report.to}.csv`, [
      ['Concepto', 'Centavos MXN', 'Desde', 'Hasta', 'Zona de reporte', 'Corte UTC'],
      ['Volumen bruto verificado', report.grossCents, report.from, report.to, report.timezone, report.asOf],
      ['Devoluciones confirmadas', report.refundCents], ['Volumen neto', report.netCents],
      ['Comisión neta', report.commissionNetCents], ['IVA de comisión', report.commissionVatCents], ['Comisión e IVA', report.commissionTotalCents],
      ['Detalle por día local', 'Bruto centavos', 'Devoluciones centavos', 'Cobros'], ...report.daily.map(day => [day.date, day.grossCents, day.refundCents, day.count]),
      ['Detalle por terminal', 'Bruto centavos', 'Devoluciones centavos', 'Cobros'], ...report.terminals.map(terminal => [terminal.terminalId, terminal.grossCents, terminal.refundCents, terminal.count]),
      ...(global ? [['Detalle completo por comercio', 'Nombre', 'Bruto centavos', 'Devoluciones centavos', 'Cobros'], ...businesses.map(business => [business.businessId, business.name, business.grossCents, business.refundCents, business.paymentCount])] : []),
    ])
    } catch (caught) { if (alive.current && request === version.current) setError(caught instanceof Error ? caught.message : 'No pudimos exportar el detalle completo.') }
    finally { if (alive.current && request === version.current) { pageRunning.current = false; setPageBusy(false) } }
  }
  return <div className="point-dashboard ops-form">
    <h2 ref={heading} tabIndex={-1} className="text-2xl font-medium">{admin ? 'Panel privado de SASORI' : 'Pagos integrados y comisión'}</h2>
    {!permitted ? <p>No tienes autorización para este reporte.</p> : <>
      <form className="grid min-w-0 grid-cols-1 gap-3 tablet:grid-cols-[1fr_1fr_auto]" onSubmit={event => { event.preventDefault(); void load() }}>
        <label className="ops-form">Desde<input type="date" value={from} onChange={event => setFrom(event.target.value)} max={to} required disabled={busy} /></label>
        <label className="ops-form">Hasta (incluido)<input type="date" value={to} onChange={event => setTo(event.target.value)} min={from} required disabled={busy} /></label>
        <button className="pos-button pos-primary self-end tablet:w-auto" disabled={busy || !from || !to || from > to}>{busy ? 'Consultando…' : 'Consultar periodo'}</button>
      </form>
      <p className="text-sm">Rango máximo: 366 días. Zona del negocio: {timezone}. Importes en MXN.</p>
      {error && <p className="text-danger" role="alert">{error}</p>}
      {busy && <p role="status">Actualizando datos del servidor…</p>}
      {report && <>
        {loadedRange !== `${from}:${to}` && <p role="status">Los datos visibles corresponden al último rango consultado: {report.from} a {report.to}.</p>}
        <div className="point-kpis grid grid-cols-1 gap-3 min-[390px]:grid-cols-2 tablet:grid-cols-4" aria-label="Métricas verificadas">{counts.map(([label, value]) => <section key={label} className="analytics-kpi"><p className="text-sm">{label}</p><strong className="mt-3 block text-2xl font-medium tabular-nums [overflow-wrap:anywhere]">{value}</strong></section>)}</div>
        <p className="text-sm">Corte: {dateLabel(report.asOf, report.timezone)}. Zona de reporte: {report.timezone}. Última conciliación: {report.lastReconciledAt ? dateLabel(report.lastReconciledAt, report.timezone) : 'No disponible'}.</p>
        <p>Un pago verificado no demuestra depósito bancario. Liquidación y saldo bancario: no disponible.</p>
        <button className="pos-button pos-secondary tablet:max-w-70" onClick={() => void exportReport()} disabled={busy || pageBusy}>Exportar estado de cuenta CSV</button>
        <section className="analytics-card"><h3>Contabilidad de comisión</h3><dl className="ops-totals">
          <div><dt>Comisión neta cerrada</dt><dd>{money(report.commissionAccounting.closedNetCents)}</dd></div>
          <div><dt>Comisión neta facturada</dt><dd>{money(report.commissionAccounting.invoicedNetCents)}</dd></div>
          <div><dt>IVA facturado</dt><dd>{money(report.commissionAccounting.invoicedVatCents)}</dd></div>
          <div><dt>Abonos a esos documentos, con IVA</dt><dd>{money(report.commissionAccounting.collectedForPeriodsCents)}</dd></div>
          <div><dt>Saldo de esos documentos, con IVA</dt><dd>{money(report.commissionAccounting.remainingCents)}</dd></div>
          <div><dt>Abonos recibidos en el rango, con IVA</dt><dd>{money(report.commissionAccounting.collectedCents)}</dd></div>
          <div><dt>Tasa efectiva neta</dt><dd>{report.commissionAccounting.effectiveRate === null ? 'No disponible' : `${(report.commissionAccounting.effectiveRate * 100).toFixed(3)}%`}</dd></div>
          <div><dt>Ingreso neto medio por comercio activo</dt><dd>{report.commissionAccounting.averageNetPerActiveBusinessCents === null ? 'No disponible' : money(report.commissionAccounting.averageNetPerActiveBusinessCents)}</dd></div>
        </dl><p className="text-sm">Los cierres son estados de cuenta. La evidencia de factura se registra aparte; SASORI no emite un CFDI desde esta pantalla.</p></section>
        <div className="analytics-columns"><section className="analytics-card"><h3>Intentos y confirmación</h3><dl className="ops-totals">
          <div><dt>Intentos únicos</dt><dd>{report.attempts.count}</dd></div><div><dt>Confirmados</dt><dd>{report.attempts.confirmed}</dd></div>
          <div><dt>Rechazos definitivos</dt><dd>{report.attempts.rejected}</dd></div><div><dt>Intentos con incidencia</dt><dd>{report.attempts.incidentAttempts}</dd></div>
          <div><dt>Rechazos / todos los intentos</dt><dd>{report.attempts.rejectionRate === null ? 'No disponible' : `${(report.attempts.rejectionRate * 100).toFixed(1)}%`}</dd></div>
          <div><dt>Confirmación p50 / p95</dt><dd>{seconds(report.attempts.confirmationSecondsP50)} / {seconds(report.attempts.confirmationSecondsP95)}</dd></div>
        </dl><ul className="ops-list">{report.attempts.results.map(result => <li key={result.state}><span>{result.state}</span><span>{result.count}</span></li>)}</ul></section>
        <section className="analytics-card"><h3>Salud operativa</h3><dl className="ops-totals">
          <div><dt>Eventos firmados / duplicados</dt><dd>{report.health.receivedEvents} / {report.health.duplicates}</dd></div>
          {admin && <div><dt>Firmas inválidas</dt><dd>{report.health.invalidSignatures ?? 'No disponible'}</dd></div>}
          {admin && <div><dt>Eventos sin orden vinculada</dt><dd>{report.health.unmatchedEvents ?? 'No disponible'}</dd></div>}
          <div><dt>Demora de evento p50 / p95</dt><dd>{seconds(report.health.eventLagSecondsP50)} / {seconds(report.health.eventLagSecondsP95)}</dd></div>
          <div><dt>Trabajos pendientes / agotados</dt><dd>{report.health.queuedJobs} / {report.health.failedJobs}</dd></div>
          <div><dt>Pendientes mayores de 15 min</dt><dd>{report.health.pendingOlderThan15Minutes}</dd></div>
          <div><dt>Antigüedad de conciliación</dt><dd>{seconds(report.health.reconciliationAgeSeconds)}</dd></div>
        </dl></section></div>
        <div className="analytics-columns"><section className="analytics-card"><h3>Periodo previo equivalente</h3><dl className="ops-totals"><div><dt>Volumen bruto</dt><dd>{money(report.previous.grossCents)}</dd></div><div><dt>Devoluciones</dt><dd>{money(report.previous.refundCents)}</dd></div><div><dt>Volumen neto</dt><dd>{money(report.previous.netCents)}</dd></div><div><dt>Cobros verificados</dt><dd>{report.previous.paymentCount}</dd></div></dl></section>
        <section className="analytics-card"><h3>Incidencias y costos</h3><dl className="ops-totals"><div><dt>Pendientes</dt><dd>{report.pendingCount}</dd></div><div><dt>Más antiguo</dt><dd>{report.oldestPendingAt ? dateLabel(report.oldestPendingAt, report.timezone) : 'Ninguno'}</dd></div><div><dt>Costos reales comparables</dt><dd>{report.costsCents === null ? 'No disponible' : money(report.costsCents)}</dd></div><div><dt>Contribución</dt><dd>{report.contributionCents === null ? 'No disponible' : money(report.contributionCents)}</dd></div></dl></section></div>
        <section className="analytics-card"><h3>Otras formas de pago</h3><p className="text-sm">Registradas por confirmación del operador. No verificadas por Point.</p><ul className="ops-list">{report.otherPayments.map(payment => <li key={payment.method}><span>{payment.method === 'cash' ? 'Efectivo' : payment.method === 'card_external' ? 'Tarjeta externa' : payment.method === 'transfer' ? 'Transferencia' : payment.method}<small>{payment.count} registros</small></span><span>{money(payment.totalCents)}</span></li>)}</ul></section>
        <section className="analytics-card"><h3>Volumen por terminal y caja</h3><ul className="ops-list">{report.terminals.map(terminal => <li key={terminal.terminalId}><span>{settings?.terminals.find(t => t.id === terminal.terminalId)?.serial ?? terminal.terminalId}<small>{settings?.terminals.find(t => t.id === terminal.terminalId)?.registerName ?? 'Caja registrada'} / Mercado Pago Point / {terminal.count} cobros</small></span><span>{money(terminal.grossCents)}<small>Devuelto: {money(terminal.refundCents)}</small></span></li>)}</ul>{!report.terminals.length && <p>Sin pagos verificados en este periodo.</p>}</section>
        <section className="analytics-card"><h3>Ventas por día local</h3><ul className="ops-list">{report.daily.map(day => <li key={day.date}><span>{day.date}<small>{day.count} cobros</small></span><span>{money(day.grossCents)}<small>Devuelto: {money(day.refundCents)}</small></span></li>)}</ul></section>
        {global && <>
          <section className="analytics-card"><h3>Activación de comercios</h3><dl className="ops-totals"><div><dt>Conectados y verificados</dt><dd>{global.connectedBusinesses}</dd></div><div><dt>Terminal lista</dt><dd>{global.readyBusinesses}</dd></div><div><dt>Activos por pagos confirmados</dt><dd>{global.activeBusinesses}</dd></div></dl><p className="text-sm">Las cuentas conectadas y las terminales listas son estados de configuración. La actividad exige evidencia de pago.</p></section>
          <section className="analytics-card"><h3>Activación al primer pago</h3><dl className="ops-totals"><div><dt>Conectados con primer pago</dt><dd>{global.activation.connectedWithFirstPayment}</dd></div><div><dt>Tiempo al primer pago p50 / p95</dt><dd>{seconds(global.activation.firstPaymentSecondsP50)} / {seconds(global.activation.firstPaymentSecondsP95)}</dd></div><div><dt>Proveedor</dt><dd>Mercado Pago Point</dd></div></dl></section>
          <section className="analytics-card"><h3>Cohortes del primer pago</h3><ul className="ops-list">{global.cohorts.map(cohort => <li key={cohort.cohort}><span>{cohort.cohort}<small>{cohort.businesses} comercios</small></span><span>{money(cohort.grossCents)}<small>Devuelto: {money(cohort.refundCents)} / numerador comisión: {cohort.commissionExactNumerator}</small></span></li>)}</ul></section>
          <section className="analytics-card"><h3>Volumen por comercio</h3><p className="text-sm">Total de todo el detalle: {money(global.businessDetailTotals.grossCents)}. {global.businesses.length} comercios cargados; los indicadores incluyen todas las páginas.</p><ul className="ops-list">{global.businesses.map(business => <li key={business.businessId}><span>{business.name}<small>{business.paymentCount} pagos verificados</small></span><span>{money(business.grossCents)}<small>Devuelto: {money(business.refundCents)}</small></span></li>)}</ul>{global.nextCursor && <button className="pos-button pos-secondary" disabled={busy || pageBusy} onClick={() => void moreBusinesses()}>Cargar más comercios</button>}</section>
        </>}
        <details className="analytics-card"><summary>Definiciones y fuentes de las métricas</summary><dl className="mt-4 flex flex-col gap-4">{metricDefinitions.map(([label, definition]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="mt-1 text-sm">{definition}</dd></div>)}</dl><p className="mt-4 text-sm">Fuente: registros financieros verificados y snapshots del POS, con corte UTC y periodos locales. Margen por producto, CAC, churn, LTV y recuperación de equipo requieren datos y definiciones adicionales.</p></details>
      </>}
      {!admin && settings?.permissions.manage && <PointStatements access={access} actorId={settings.actorId} onSessionError={onSessionError} />}
    </>}
  </div>
}
