import { useEffect, useRef, useState } from 'react'
import type { DiningTable, TableLayout } from '../../lib/operations-contracts'
import type { OperationalMutation } from './useOperations'

export default function TableLayoutEditor({ table, mutation, onSaved }: {
  table: DiningTable
  mutation: OperationalMutation
  onSaved: () => void
}) {
  const [layout, setLayout] = useState<TableLayout>(table.layout ?? { zone: 'Salón', row: 1, column: 1, seats: 2, shape: 'square' })
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const disabled = mutation.busy || Boolean(mutation.pending)
  const valid = layout.zone.trim().length > 0 && [layout.row, layout.column].every(value => Number.isInteger(value) && value >= 1 && value <= 12) && Number.isInteger(layout.seats) && layout.seats >= 1 && layout.seats <= 24
  async function save(value: TableLayout | null) {
    if (disabled || value !== null && !valid) return
    try {
      await mutation.execute({ command: 'set_table_layout', operationId: crypto.randomUUID(), tableId: table.id, expectedRevision: table.revision, layout: value ? { ...value, zone: value.zone.trim() } : null })
      if (alive.current) onSaved()
    } catch { /* The shell preserves the same layout operation for retry. */ }
  }
  return <form className="ops-form" onSubmit={event => { event.preventDefault(); void save(layout) }}>
    <p className="operations-caption">La fila va de arriba a abajo; la columna, de izquierda a derecha.</p>
    <label>Zona<input autoFocus maxLength={40} value={layout.zone} placeholder="Salón, terraza…" disabled={disabled} onChange={event => setLayout({ ...layout, zone: event.target.value })} /></label>
    <div className="grid grid-cols-2 gap-3"><label>Fila<input inputMode="numeric" type="number" min={1} max={12} value={layout.row} disabled={disabled} onChange={event => setLayout({ ...layout, row: Number(event.target.value) })} /></label><label>Columna<input inputMode="numeric" type="number" min={1} max={12} value={layout.column} disabled={disabled} onChange={event => setLayout({ ...layout, column: Number(event.target.value) })} /></label></div>
    <label>Lugares<input inputMode="numeric" type="number" min={1} max={24} value={layout.seats} disabled={disabled} onChange={event => setLayout({ ...layout, seats: Number(event.target.value) })} /></label>
    <label>Forma<select value={layout.shape} disabled={disabled} onChange={event => setLayout({ ...layout, shape: event.target.value as TableLayout['shape'] })}><option value="square">Cuadrada</option><option value="round">Redonda</option><option value="rectangle">Rectangular</option></select></label>
    {mutation.error && <p role="alert">{mutation.error}</p>}
    <button type="submit" className="pos-button pos-primary" disabled={disabled || !valid}>Guardar ubicación</button>
    {table.layout && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => void save(null)}>Quitar del plano</button>}
  </form>
}
