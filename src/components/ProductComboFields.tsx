import { useState } from 'react'
import type { ComboComponentInput, Product } from '../lib/pos-contracts'
import { productAvailabilityReason, productDetails, quickProductSelection, selectionLabel } from '../lib/product-details'
import ProductSelection from './ProductSelection'

export default function ProductComboFields({ products, productId, components, onChange }: {
  products: Product[]; productId: string; components: ComboComponentInput[]; onChange: (components: ComboComponentInput[]) => void
}) {
  const [chosen, setChosen] = useState(''), [customizing, setCustomizing] = useState<Product | null>(null), [error, setError] = useState(''), [enabled, setEnabled] = useState(components.length > 0)
  const available = products.filter(product => product.id !== productId && product.active && !productDetails(product).comboComponents?.length)
  function add(component: Product, selection?: ComboComponentInput['selection']) {
    if (selection) selection = { ...selection, modifierIds: [...selection.modifierIds].sort() }
    const existing = components.find(part => part.productId === component.id && JSON.stringify(part.selection ?? null) === JSON.stringify(selection ?? null))
    if (existing && existing.quantity >= 24) { setError('Cada componente admite hasta 24 unidades por combo.'); return }
    onChange(existing ? components.map(part => part === existing ? { ...part, quantity: part.quantity + 1 } : part) : [...components, { productId: component.id, version: component.version, quantity: 1, ...(selection ? { selection } : {}) }])
    setChosen(''); setError('')
  }
  return <div className="flex flex-col gap-4 rounded-lg border border-line p-4">
    <label className="flex min-h-12 items-center gap-3 font-medium"><input type="checkbox" className="size-5" checked={enabled} onChange={event => { setEnabled(event.target.checked); if (!event.target.checked) onChange([]); }} />Configurar como combo</label>
    {enabled && <>
    <h4 className="font-medium">Componentes del combo</h4>
    <p className="text-sm text-muted">El precio final de arriba es el precio del combo. Estos componentes indican qué preparar; no se suman sus precios. Hasta 8 preparaciones diferentes.</p>
    {components.map((part, index) => {
      const product = products.find(product => product.id === part.productId), reason = product ? productAvailabilityReason(product) : 'El producto ya no está en el catálogo.'
      return <div key={index} className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <strong className="text-sm font-medium">{product?.name ?? 'Componente retirado'}{product && selectionLabel(product, part.selection) ? ` · ${selectionLabel(product, part.selection)}` : ''}</strong>
        {(reason || product?.version !== part.version) && <p className="text-sm text-muted">{reason || 'El componente cambió. El combo conserva su preparación guardada; quítalo y vuelve a elegirlo para actualizarla.'}</p>}
        <div className="flex flex-wrap items-end gap-3"><div className="field min-w-28 flex-1"><label htmlFor={`combo-quantity-${index}`}>Cantidad de {product?.name ?? `componente ${index + 1}`}</label><input id={`combo-quantity-${index}`} type="number" inputMode="numeric" min={1} max={24} value={part.quantity} onChange={event => onChange(components.map((item, position) => position === index ? { ...item, quantity: Number(event.target.value) } : item))} /></div>
          <button type="button" className="pos-button pos-secondary" aria-label={`Quitar componente ${index + 1}`} onClick={() => onChange(components.filter((_, position) => position !== index))}>Quitar</button>
        </div>
      </div>
    })}
    <div className="field"><label htmlFor="combo-product">Agregar al combo</label><select id="combo-product" value={chosen} onChange={event => setChosen(event.target.value)}><option value="">Elegir producto</option>{available.map(product => <option key={product.id} value={product.id} disabled={Boolean(productAvailabilityReason(product))}>{product.name}{productAvailabilityReason(product) ? ' · No disponible' : ''}</option>)}</select></div>
    <button type="button" className="pos-button pos-secondary" disabled={!chosen || components.length >= 8} onClick={() => {
      const product = available.find(product => product.id === chosen)
      if (!product) return
      const quick = quickProductSelection(product)
      if (quick) add(product, productDetails(product).modifierSets.length || productDetails(product).variations.length ? quick : undefined)
      else setCustomizing(product)
    }}>Añadir componente</button>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {customizing && <ProductSelection product={customizing} onClose={() => setCustomizing(null)} onAdd={selection => add(customizing, selection)} />}
    </>}
  </div>
}
