import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { Variation } from '../lib/pos-contracts'
import { appendVariations, previewVariations, type VariationDimension } from '../lib/product-variation-builder'

export default function ProductVariationBuilder({ variations, priceCents, onChange }: { variations: Variation[]; priceCents: number | null; onChange: (variations: Variation[]) => void }) {
  const [dimensions, setDimensions] = useState<VariationDimension[]>([{ id: crypto.randomUUID(), name: '', values: '' }])
  const preview = previewVariations(dimensions, variations)
  const started = dimensions.some(dimension => dimension.name || dimension.values)
  return (
    <details className="rounded-lg border border-line px-4">
      <summary className="min-h-12 cursor-pointer py-3.5 text-sm font-medium">
        Crear variantes con opciones
      </summary>
      <div className="flex flex-col gap-4 pb-4">
        <p className="text-sm text-muted">
          Combina tamaños, temperaturas o presentaciones. Se añaden variantes nuevas y se conservan las que ya tienes, con sus precios y códigos.
        </p>
        {dimensions.map((dimension, index) => (
          <div className="flex flex-col gap-3 border-t border-line pt-4" key={dimension.id}>
            <div className="field">
              <label htmlFor={`dimension-name-${dimension.id}`}>Nombre de opción {index + 1}</label>
              <input
                id={`dimension-name-${dimension.id}`}
                value={dimension.name}
                maxLength={60}
                placeholder="Ej. Tamaño"
                onChange={event => setDimensions(current => current.map(item => item.id === dimension.id ? { ...item, name: event.target.value } : item))}
              />
            </div>
            <div className="field">
              <label htmlFor={`dimension-values-${dimension.id}`}>Valores de opción {index + 1}</label>
              <textarea
                id={`dimension-values-${dimension.id}`}
                value={dimension.values}
                rows={2}
                maxLength={1200}
                placeholder="Ej. Chico, Mediano, Grande"
                onChange={event => setDimensions(current => current.map(item => item.id === dimension.id ? { ...item, values: event.target.value } : item))}
              />
              <p className="text-sm text-muted">Separa los valores con comas o saltos de línea.</p>
            </div>
            {dimensions.length > 1 && (
              <button
                type="button"
                className="pos-button pos-secondary self-start"
                aria-label={`Quitar opción de variantes ${index + 1}`}
                onClick={() => setDimensions(current => current.filter(item => item.id !== dimension.id))}
              >
                <Trash2 size={18} />
                Quitar opción
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="pos-button pos-secondary self-start"
          disabled={dimensions.length >= 3}
          onClick={() => setDimensions(current => [...current, { id: crypto.randomUUID(), name: '', values: '' }])}
        >
          <Plus size={18} />
          Añadir opción de variantes
        </button>
        {started && preview.error && <p className="text-sm text-danger" role="status">{preview.error}</p>}
        {preview.names.length > 0 && (
          <div className="rounded-lg bg-surface p-4" aria-label="Vista previa de combinaciones">
            <p className="mb-2 text-sm font-medium">{preview.names.length} combinaciones · {preview.additions.length} nuevas</p>
            <ul className="flex flex-wrap gap-2 text-sm">
              {preview.names.map(name => <li key={name} className="rounded-md border border-line bg-white px-2 py-1">{name}</li>)}
            </ul>
          </div>
        )}
        <button
          type="button"
          className="pos-button pos-secondary"
          disabled={Boolean(preview.error) || !preview.additions.length || priceCents === null}
          onClick={() => onChange(appendVariations(variations, preview.additions, priceCents!))}
        >
          Añadir combinaciones
        </button>
        {priceCents === null && <p className="text-sm text-muted">Define un precio final antes de añadir las combinaciones.</p>}
      </div>
    </details>
  )
}
