import { Plus, Trash2 } from 'lucide-react'

export interface ProductCustomAttribute { name: string; value: string }

export default function ProductCustomAttributes({ attributes, onChange }: { attributes: ProductCustomAttribute[]; onChange: (attributes: ProductCustomAttribute[]) => void }) {
  return (
    <details className="rounded-lg border border-line px-4">
      <summary className="min-h-12 cursor-pointer py-3.5 text-sm font-medium">
        Atributos personalizados
      </summary>
      <div className="flex flex-col gap-4 pb-4">
        <p className="text-sm text-muted">
          Añade datos como marca, origen o ingredientes. Se pueden consultar en los detalles del producto en Venta.
        </p>
        {attributes.map((attribute, index) => (
          <div key={index} className="flex flex-col gap-3 border-t border-line pt-4">
            <div className="grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
              <div className="field">
                <label htmlFor={`attribute-name-${index}`}>Nombre de atributo {index + 1}</label>
                <input
                  id={`attribute-name-${index}`}
                  value={attribute.name}
                  required
                  maxLength={40}
                  placeholder="Ej. Origen"
                  onChange={event => onChange(attributes.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))}
                />
              </div>
              <div className="field">
                <label htmlFor={`attribute-value-${index}`}>Valor de atributo {index + 1}</label>
                <input
                  id={`attribute-value-${index}`}
                  value={attribute.value}
                  required
                  maxLength={120}
                  placeholder="Ej. Oaxaca"
                  onChange={event => onChange(attributes.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))}
                />
              </div>
            </div>
            <button
              type="button"
              className="pos-button pos-secondary self-start"
              aria-label={`Quitar atributo ${index + 1}`}
              onClick={() => onChange(attributes.filter((_, itemIndex) => itemIndex !== index))}
            >
              <Trash2 size={18} />
              Quitar atributo
            </button>
          </div>
        ))}
        <button
          type="button"
          className="pos-button pos-secondary self-start"
          disabled={attributes.length >= 8}
          onClick={() => onChange([...attributes, { name: '', value: '' }])}
        >
          <Plus size={18} />
          Añadir atributo
        </button>
        <p className="text-sm text-muted">Hasta 8 atributos con nombres diferentes.</p>
      </div>
    </details>
  )
}
