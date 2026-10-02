import { useState } from 'react'
import type { ItemSelection, Product } from '../lib/pos-contracts'
import { productDetails, selectedPrice } from '../lib/product-details'
import { money, parsePrice } from '../lib/pos'
import { PosDialog } from './PosShared'
import MoneyInput from './MoneyInput'

export default function ProductSelection({ product, onClose, onAdd }: { product: Product; onClose: () => void; onAdd: (selection: ItemSelection) => void }) {
  const d = productDetails(product)
  const [variationId, setVariationId] = useState<string | null>(d.variations.find(v => !v.soldOut)?.id ?? null)
  const [modifierIds, setModifierIds] = useState<string[]>([])
  const [price, setPrice] = useState('')
  const selection = { variationId, modifierIds, variablePriceCents: d.variablePrice ? parsePrice(price) : null }
  const valid = (!d.variablePrice || selection.variablePriceCents !== null) && (!d.variations.length || variationId !== null)
    && d.modifierSets.every(s => { const count = s.options.filter(o => modifierIds.includes(o.id)).length; return count >= s.min && count <= s.max })
    && modifierIds.length <= 24 && selectedPrice(product, selection) <= 99_999_999
  return <PosDialog title={product.name} onClose={onClose}>
    {product.image && <img src={product.image} className="selection-photo" alt="" />}{d.description && <p className="selection-description">{d.description}</p>}
    {d.allergens && <p className="product-help">Alérgenos: {d.allergens}</p>}
    {d.variations.length > 0 && <fieldset className="selection-group"><legend>Presentación</legend>{d.variations.map(v => <label key={v.id} className="selection-choice"><input type="radio" name="variation" value={v.id} checked={variationId === v.id} disabled={v.soldOut} onChange={() => setVariationId(v.id)} /><span>{v.name}{v.soldOut && <small>Agotada</small>}</span><b>{money(v.priceCents)}</b></label>)}</fieldset>}
    {d.variablePrice && <div className="field"><label htmlFor="sale-variable-price">Precio de esta venta MXN</label><MoneyInput id="sale-variable-price" value={price} onValueChange={setPrice} placeholder="$0.00" autoFocus /></div>}
    {d.modifierSets.map(s => <fieldset key={s.id} className="selection-group"><legend>{s.name} <small>{s.min > 0 ? `Elige de ${s.min} a ${s.max}` : `Opcional · hasta ${s.max}`}</small></legend>{s.options.map(o => {
      const checked = modifierIds.includes(o.id)
      const count = s.options.filter(item => modifierIds.includes(item.id)).length
      return <label key={o.id} className="selection-choice"><input type={s.max === 1 ? 'radio' : 'checkbox'} name={s.id} checked={checked} disabled={!checked && (s.max > 1 && count >= s.max || modifierIds.length >= 24 && (s.max > 1 || count === 0))} onChange={() => setModifierIds(ids => checked ? ids.filter(id => id !== o.id) : [...ids.filter(id => s.max !== 1 || !s.options.some(item => item.id === id)), o.id])} /><span>{o.name}</span><b>{o.priceCents ? `+${money(o.priceCents)}` : 'Sin costo'}</b></label>
    })}{s.max === 1 && s.min === 0 && <button className="editor-text-button" onClick={() => setModifierIds(ids => ids.filter(id => !s.options.some(o => o.id === id)))}>Sin {s.name.toLocaleLowerCase('es-MX')}</button>}</fieldset>)}
    <div className="dialog-actions"><button className="pos-button pos-primary" disabled={!valid} onClick={() => { onAdd(selection); onClose() }}>Agregar · {money(selectedPrice(product, selection))}</button></div>
  </PosDialog>
}
