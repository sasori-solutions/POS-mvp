import type { ProductDetails } from '../lib/pos-contracts'

export default function ProductNutritionFields({ details, calories, setCalories, change }: { details: ProductDetails; calories: string; setCalories: (value: string) => void; change: <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) => void }) {
  return (
    <details className="rounded-lg border border-line px-4">
      <summary className="min-h-12 cursor-pointer py-3.5 text-sm font-medium">
        Información alimentaria (opcional)
      </summary>
      <div className="flex flex-col gap-4 pb-4">
        <div className="field">
          <label htmlFor="product-calories">Calorías por porción</label>
          <input id="product-calories" type="number" inputMode="numeric" min={0} max={100000} step={1} value={calories} onChange={event => setCalories(event.target.value)} placeholder="Ej. 120" />
        </div>
        <div className="field">
          <label htmlFor="product-dietary">Preferencias alimentarias</label>
          <input id="product-dietary" value={details.dietary} maxLength={200} onChange={event => change('dietary', event.target.value)} placeholder="Ej. Vegetariano, sin gluten" />
        </div>
        <div className="field">
          <label htmlFor="product-allergens">Alérgenos (opcional)</label>
          <input id="product-allergens" value={details.allergens} maxLength={200} onChange={event => change('allergens', event.target.value)} placeholder="Ej. Leche, nueces" />
        </div>
        <p className="text-sm text-muted">
          Completa solo la información que conoces. Se muestra en los detalles del producto en Venta.
        </p>
      </div>
    </details>
  )
}
