import type { ProductDetails } from '../lib/pos-contracts'

const palette = [
  ['#E8EEF8', 'Azul claro'], ['#DAEBD9', 'Verde claro'],
  ['#FBE2C8', 'Naranja claro'], ['#F6D6D9', 'Rosa claro'],
  ['#E8DBF3', 'Lila'], ['#F5EDBE', 'Amarillo claro'],
  ['#E4E4E4', 'Gris'], ['#FFFFFF', 'Blanco'],
] as const

export default function ProductIdentityFields({ details, change }: { details: ProductDetails; change: <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) => void }) {
  return (
    <>
      <div className="field">
        <label htmlFor="product-item-type">Tipo de producto</label>
        <select
          id="product-item-type"
          value={details.itemType}
          onChange={event => change('itemType', event.target.value as ProductDetails['itemType'])}
        >
          <option value="prepared">Alimento o bebida preparados</option>
          <option value="physical">Producto físico</option>
          <option value="service">Servicio</option>
          <option value="other">Otro</option>
          {details.itemType === 'digital' && <option value="digital">Digital · existente</option>}
          {details.itemType === 'event' && <option value="event">Evento · existente</option>}
        </select>
      </div>
      <details className="rounded-lg border border-line px-4">
        <summary className="min-h-12 cursor-pointer py-3.5 text-sm font-medium">
          Nombres y códigos opcionales
        </summary>
        <div className="flex flex-col gap-4 pb-4">
          <div className="field">
            <label htmlFor="product-customer-name">Nombre para el cliente</label>
            <input
              id="product-customer-name"
              value={details.customerName}
              maxLength={100}
              placeholder="Usar el nombre del producto"
              onChange={event => change('customerName', event.target.value)}
            />
            <p className="text-sm text-muted">Se usa en las cuentas y las ventas registradas.</p>
          </div>
          <div className="field">
            <label htmlFor="product-kitchen-name">Nombre para cocina</label>
            <input
              id="product-kitchen-name"
              value={details.kitchenName}
              maxLength={100}
              placeholder="Usar el nombre del producto"
              onChange={event => change('kitchenName', event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
            <div className="field">
              <label htmlFor="product-sku">SKU del producto</label>
              <input id="product-sku" value={details.sku} maxLength={60} placeholder="Ej. CAFE-01" onChange={event => change('sku', event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="product-barcode">Código de barras / GTIN</label>
              <input id="product-barcode" value={details.barcode} maxLength={32} placeholder="Ej. 7501234567890" onChange={event => change('barcode', event.target.value)} />
            </div>
          </div>
        </div>
      </details>
      <details className="rounded-lg border border-line px-4">
        <summary className="min-h-12 cursor-pointer py-3.5 text-sm font-medium">
          Apariencia en el catálogo
        </summary>
        <div className="flex flex-col gap-4 pb-4">
          <div className="field">
            <label htmlFor="product-tile-label">Etiqueta corta</label>
            <input id="product-tile-label" value={details.tileLabel} maxLength={8} placeholder="Ej. LATTE" onChange={event => change('tileLabel', event.target.value)} />
            <p className="text-sm text-muted">Hasta 8 caracteres. Aparece cuando no hay una foto.</p>
          </div>
          <fieldset className="min-w-0">
            <legend className="mb-2 text-sm">Color de la ficha</legend>
            <div className="flex flex-wrap gap-2">
              {palette.map(([color, label]) => (
                <button
                  key={color}
                  type="button"
                  className="size-12 rounded-lg border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  style={{ backgroundColor: color, borderColor: details.tileColor.toUpperCase() === color ? '#111111' : '#E4E4E4' }}
                  aria-label={label}
                  aria-pressed={details.tileColor.toUpperCase() === color}
                  onClick={() => change('tileColor', color)}
                />
              ))}
            </div>
          </fieldset>
        </div>
      </details>
    </>
  )
}
