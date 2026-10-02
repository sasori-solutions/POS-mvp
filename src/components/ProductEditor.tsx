import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Plus, Trash2 } from 'lucide-react'
import { AccountClientError } from '../lib/account'
import type { PosCommand, Product, ProductDetails } from '../lib/pos-contracts'
import { emptyDetails, productDetails } from '../lib/product-details'
import { parsePrice, posRequest, priceInput, type PosAccess } from '../lib/pos'
import { PosDialog } from './PosShared'
import MoneyInput from './MoneyInput'
import { accessErrorCodes } from './useCatalog'

const sections = [['identity', 'Información'], ['pricing', 'Precio e impuestos'], ['variations', 'Opciones y variantes'], ['modifiers', 'Modificadores'], ['inventory', 'Disponibilidad'], ['additional', 'Más detalles']] as const

export default function ProductEditor({ product, products, access, onClose, onSaved, onRefresh, onSessionError }: {
  product: Product | null; products: Product[]; access: PosAccess; onClose: () => void; onSaved: (product: Product) => void; onRefresh: () => void; onSessionError?: (error: AccountClientError) => void
}) {
  const [name, setName] = useState(product?.name ?? '')
  const [category, setCategory] = useState(product?.category ?? '')
  const [price, setPrice] = useState(product ? priceInput(product.priceCents) : '')
  const [details, setDetails] = useState<ProductDetails>(product ? productDetails(product) : emptyDetails())
  const [image, setImage] = useState(product?.image ?? '')
  const [options, setOptions] = useState('')
  const [optionName, setOptionName] = useState('Tamaño')
  const [additionalOptions, setAdditionalOptions] = useState<{name: string; values: string}[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [conflict, setConflict] = useState(false)
  const productId = useRef(product?.id ?? crypto.randomUUID())
  const request = useRef<Extract<PosCommand, { command: 'save_product' }> | null>(null)
  const imageUpload = useRef<{ id: string; data: string; operations: string[]; uploaded: boolean } | null>(null)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const locked = busy || uncertain || conflict
  function change<K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) { setDetails(d => ({ ...d, [key]: value })) }

  async function chooseImage(file?: File) {
    if (!file) return
    setError(''); setBusy(true)
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('Elige una imagen JPG, PNG o WebP de hasta 8 MB.')
      const bitmap = await createImageBitmap(file)
      const ratio = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio)
      const context = canvas.getContext('2d')!
      context.fillStyle = '#FFFFFF'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close()
      let dataUrl = canvas.toDataURL('image/jpeg', .8)
      if (dataUrl.length > 245783) dataUrl = canvas.toDataURL('image/jpeg', .5)
      if (dataUrl.length > 245783) throw new Error('La imagen es demasiado compleja. Elige una foto más pequeña.')
      if (!mounted.current) return
      const data = dataUrl.split(',')[1], id = crypto.randomUUID()
      imageUpload.current = { id, data, operations: Array.from({ length: Math.ceil(data.length / 4096) }, () => crypto.randomUUID()), uploaded: false }
      setImage(dataUrl); change('imageId', id)
    } catch (caught) { if (mounted.current) setError((caught as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || conflict) return
    if (!request.current) {
      const priceCents = details.variablePrice ? 0 : parsePrice(price)
      if (!name.trim() || priceCents === null) { setError('Escribe el nombre y un precio válido.'); return }
      const nextDetails = { ...details, description: details.description.replace(/\s+/g, ' ').trim() }
      if (details.modifierSets.reduce((sum, set) => sum + set.min, 0) > 24) { setError('Los grupos pueden exigir como máximo 24 selecciones en total. Reduce las selecciones mínimas.'); return }
      request.current = { command: 'save_product', productId: productId.current, expectedVersion: product?.version ?? null, name: name.trim(), category: category.trim(), priceCents, details: nextDetails, operationId: crypto.randomUUID() }
      // Leave room for the signed browser proof and access envelope within the HTTP limit.
      if (new TextEncoder().encode(JSON.stringify(request.current)).length > 6800) { request.current = null; setError('Este producto tiene demasiadas opciones o texto. Reduce el contenido antes de guardar.'); return }
    }
    submitting.current = true; setBusy(true); setError('')
    try {
      const upload = imageUpload.current
      if (upload && !upload.uploaded) {
        for (let part = 0; part < upload.operations.length; part++) {
          if (!mounted.current) return
          await posRequest(access, { command: 'upload_product_image', imageId: upload.id, part, parts: upload.operations.length, data: upload.data.slice(part * 4096, (part + 1) * 4096), operationId: upload.operations[part] })
        }
        upload.uploaded = true
      }
      if (!mounted.current) return
      const saved = await posRequest(access, request.current)
      if (mounted.current) onSaved(saved)
    } catch (caught) {
      if (!mounted.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar el producto.')
      const unknown = !(caught instanceof AccountClientError) || ['NETWORK_ERROR', 'SERVER_ERROR'].includes(caught.code)
      setUncertain(unknown)
      if (!unknown) request.current = null
      if (caught instanceof AccountClientError) {
        setConflict(caught.code === 'PRODUCT_CHANGED')
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
      }
    } finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }
  function generateVariants() {
    const groups = [{name: optionName, values: options}, ...additionalOptions].map(group => ({name: group.name.trim(), values: group.values.split(',').map(value => value.trim()).filter(Boolean)}))
    if (groups.some(group => !group.name || !group.values.length || new Set(group.values).size !== group.values.length) || groups.reduce((count, group) => count * group.values.length, 1) > 20) { setError('Escribe opciones distintas separadas por comas. Puedes crear hasta 20 combinaciones.'); return }
    const names = groups.reduce<string[]>((combinations, group) => combinations.flatMap(prefix => group.values.map(value => `${prefix}${prefix ? ' / ' : ''}${group.name}: ${value}`)), [''])
    if (names.some(value => Array.from(value).length > 60)) { setError('Abrevia los nombres de las opciones: cada variante admite 60 caracteres.'); return }
    change('variations', names.map(value => ({ id: crypto.randomUUID(), name: value, priceCents: parsePrice(price) ?? 0, sku: '', barcode: '', soldOut: false })))
    setOptions(''); setError('')
  }

  return <PosDialog title={product ? 'Editar producto' : 'Agregar producto'} onClose={onClose} busy={busy} className="product-editor-dialog">
    <form onSubmit={event => void save(event)} className="product-editor-form">
      <nav className="editor-sections" aria-label="Secciones del producto">{sections.map(([id, label]) => <a key={id} href={`#product-${id}`}>{label}</a>)}</nav>
      <fieldset disabled={locked} className="editor-fields">
        <section id="product-identity" className="editor-section"><h3>Información del producto</h3>
          <div className="product-identity-layout"><div className="image-editor">
            <div className="product-image-preview" style={{ backgroundColor: details.tileColor }}>{image ? <img src={image} alt="Imagen del producto" /> : <ImagePlus size={36} strokeWidth={1.5} aria-hidden="true" />}</div>
            <label className="image-upload">{image ? 'Cambiar imagen' : 'Añadir imagen'}<input type="file" aria-label="Imagen del producto" accept="image/jpeg,image/png,image/webp" onChange={e => void chooseImage(e.target.files?.[0])} /></label>
            {image && <button type="button" className="editor-text-button" onClick={() => { setImage(''); imageUpload.current = null; change('imageId', null) }}>Quitar imagen</button>}
          </div><div className="editor-field-stack">
            <div className="field"><label htmlFor="product-name">Nombre</label><input id="product-name" value={name} onChange={e => setName(e.target.value)} maxLength={100} required autoFocus placeholder="Ej. Latte" /></div>
            <div className="field"><label htmlFor="product-type">Tipo de producto</label><select id="product-type" value={details.itemType} onChange={e => change('itemType', e.target.value as ProductDetails['itemType'])}><option value="prepared">Alimentos y bebidas preparados</option><option value="physical">Producto físico</option><option value="service">Servicio</option><option value="digital">Digital (entrega manual)</option><option value="event">Evento (entrega manual)</option><option value="other">Otro</option></select></div>
            <div className="field"><label htmlFor="product-category">Categoría (opcional)</label><input id="product-category" value={category} onChange={e => setCategory(e.target.value)} maxLength={60} list="product-categories" placeholder="Ej. Café" /><datalist id="product-categories">{[...new Set(products.map(p => p.category).filter(Boolean))].map(v => <option key={v} value={v} />)}</datalist></div>
          </div></div>
          <div className="field"><label htmlFor="product-description">Descripción</label><textarea id="product-description" value={details.description} onChange={e => change('description', e.target.value)} maxLength={1000} rows={3} placeholder="Ingredientes, preparación y lo que hace especial a este producto" /></div>
          <div className="editor-two-columns"><div className="field"><label htmlFor="product-tile-label">Etiqueta de la cuadrícula</label><input id="product-tile-label" value={details.tileLabel} onChange={e => change('tileLabel', e.target.value)} maxLength={8} placeholder="Ej. LAT" /></div><div className="field"><label htmlFor="product-color">Color de la ficha</label><div className="tile-colors" role="group" aria-label="Color de la ficha">{['#E8EEF8', '#F4E6DC', '#E4EDE4', '#EDE5F3', '#F4EED7', '#E4E4E4'].map(c => <button key={c} type="button" style={{ backgroundColor: c }} aria-label={`Color ${c}`} aria-pressed={details.tileColor === c} onClick={() => change('tileColor', c)} />)}</div></div></div>
        </section>
        <section id="product-pricing" className="editor-section"><h3>Precio e impuestos</h3>
          <div className="editor-two-columns"><div className="field"><label htmlFor="product-price">Precio MXN</label><MoneyInput id="product-price" value={price} onValueChange={setPrice} required={!details.variablePrice} disabled={details.variablePrice} placeholder="$0.00" /><p className="product-help">Precio final, con impuestos incluidos.</p></div><div className="field"><label htmlFor="product-cost">Costo por unidad (opcional)</label><MoneyInput id="product-cost" value={details.costCents === null ? '' : priceInput(details.costCents)} onValueChange={v => change('costCents', v === '' ? null : parsePrice(v))} placeholder="$0.00" /></div></div>
          <label className="editor-check"><input type="checkbox" checked={details.variablePrice} disabled={details.variations.length > 0} onChange={e => change('variablePrice', e.target.checked)} /><span>Introducir precio al vender<small>Para productos cuyo precio cambia en cada venta.</small></span></label>
          <div className="field"><label htmlFor="product-tax">Impuesto incluido</label><select id="product-tax" value={details.taxBps} onChange={e => change('taxBps', Number(e.target.value))}><option value={0}>Sin desglose de impuesto</option><option value={800}>8 % incluido</option><option value={1600}>16 % incluido</option>{![0,800,1600].includes(details.taxBps) && <option value={details.taxBps}>{details.taxBps / 100} % incluido</option>}</select><p className="product-help">Se desglosa en la venta y no se suma al precio.</p></div>
        </section>
        <section id="product-variations" className="editor-section"><h3>Opciones y variantes</h3><p className="product-help">Tamaños, sabores o presentaciones con precio y código propios.</p>
          {!details.variablePrice && details.variations.length === 0 && <div className="variant-generator"><div className="editor-two-columns"><div className="field"><label htmlFor="product-option-name">Nombre de la opción</label><input id="product-option-name" value={optionName} maxLength={30} onChange={e => setOptionName(e.target.value)} /></div><div className="field"><label htmlFor="product-option-values">Valores separados por comas</label><input id="product-option-values" value={options} onChange={e => setOptions(e.target.value)} placeholder="Chico, Mediano, Grande" /></div></div>
            {additionalOptions.map((group, index) => <div className="editor-two-columns" key={index}><div className="field"><label htmlFor={`additional-option-name-${index}`}>Nombre de la opción {index + 2}</label><input id={`additional-option-name-${index}`} value={group.name} maxLength={30} onChange={e => setAdditionalOptions(previous => previous.map((item, i) => i === index ? {...item, name: e.target.value} : item))} /></div><div className="field"><label htmlFor={`additional-option-values-${index}`}>Valores de la opción {index + 2}</label><input id={`additional-option-values-${index}`} value={group.values} onChange={e => setAdditionalOptions(previous => previous.map((item, i) => i === index ? {...item, values: e.target.value} : item))} placeholder="Ej. Vainilla, Chocolate" /></div></div>)}
            <div className="editor-row-actions"><button type="button" className="editor-text-button" onClick={() => setAdditionalOptions(previous => [...previous, {name: '', values: ''}])} disabled={additionalOptions.length >= 2}>Añadir otra opción</button><button type="button" className="editor-text-button" onClick={generateVariants} disabled={!options.trim()}>Crear variantes</button></div></div>}
          {details.variations.map((v, index) => <div className="editor-option-row" key={v.id}><div className="editor-two-columns"><div className="field"><label htmlFor={`variation-${v.id}`}>Variante {index + 1}</label><input id={`variation-${v.id}`} value={v.name} maxLength={60} required onChange={e => change('variations', details.variations.map(item => item.id === v.id ? { ...item, name: e.target.value } : item))} /></div><div className="field"><label htmlFor={`variation-price-${v.id}`}>Precio de variante {index + 1}</label><MoneyInput id={`variation-price-${v.id}`} value={priceInput(v.priceCents)} required onValueChange={value => change('variations', details.variations.map(item => item.id === v.id ? { ...item, priceCents: parsePrice(value) ?? 0 } : item))} /></div></div>
            <div className="editor-two-columns">{(['sku','barcode'] as const).map(k => <div className="field" key={k}><label htmlFor={`variant-${k}-${v.id}`}>{k === 'sku' ? 'SKU' : 'Código de barras'} de variante {index + 1}</label><input id={`variant-${k}-${v.id}`} value={v[k]} maxLength={k === 'sku' ? 60 : 32} onChange={e => change('variations', details.variations.map(item => item.id === v.id ? { ...item, [k]: e.target.value } : item))} /></div>)}</div>
            <div className="editor-row-actions"><label className="editor-check"><input type="checkbox" checked={v.soldOut} onChange={e => change('variations', details.variations.map(item => item.id === v.id ? { ...item, soldOut: e.target.checked } : item))} />Agotada</label><button type="button" className="pos-icon-button" aria-label={`Quitar variante ${index + 1}`} onClick={() => change('variations', details.variations.filter(item => item.id !== v.id))}><Trash2 size={18} /></button></div>
          </div>)}
          <button type="button" className="editor-add" disabled={details.variablePrice || details.variations.length >= 20} onClick={() => change('variations', [...details.variations, { id: crypto.randomUUID(), name: '', priceCents: parsePrice(price) ?? 0, sku: '', barcode: '', soldOut: false }])}><Plus size={18} />Añadir variante</button>
        </section>
        <section id="product-modifiers" className="editor-section"><h3>Modificadores</h3><p className="product-help">Personaliza el pedido con leche, extras o acompañamientos.</p>
          {details.modifierSets.map((set, index) => <div className="editor-option-row" key={set.id}><div className="field"><label htmlFor={`modifier-set-${set.id}`}>Grupo {index + 1}</label><input id={`modifier-set-${set.id}`} value={set.name} maxLength={60} required onChange={e => change('modifierSets', details.modifierSets.map(s => s.id === set.id ? { ...s, name: e.target.value } : s))} /></div>
            <div className="editor-two-columns">{(['min','max'] as const).map(k => <div className="field" key={k}><label htmlFor={`${k}-${set.id}`}>{k === 'min' ? 'Selecciones mínimas' : 'Selecciones máximas'}</label><input id={`${k}-${set.id}`} type="number" min={k === 'min' ? 0 : 1} max={set.options.length} value={set[k]} onChange={e => change('modifierSets', details.modifierSets.map(s => s.id === set.id ? { ...s, [k]: Number(e.target.value) } : s))} /></div>)}</div>
            {set.options.map((o, oi) => <div className="modifier-input-row" key={o.id}><div className="field"><label htmlFor={`modifier-${o.id}`}>Opción {oi + 1} de grupo {index + 1}</label><input id={`modifier-${o.id}`} value={o.name} maxLength={60} required placeholder="Ej. Leche de avena" onChange={e => change('modifierSets', details.modifierSets.map(s => s.id === set.id ? { ...s, options: s.options.map(item => item.id === o.id ? { ...item, name: e.target.value } : item) } : s))} /></div><div className="field"><label htmlFor={`modifier-price-${o.id}`}>Precio extra {oi + 1}</label><MoneyInput id={`modifier-price-${o.id}`} value={priceInput(o.priceCents)} onValueChange={v => change('modifierSets', details.modifierSets.map(s => s.id === set.id ? { ...s, options: s.options.map(item => item.id === o.id ? { ...item, priceCents: parsePrice(v) ?? 0 } : item) } : s))} /></div><button type="button" className="pos-icon-button" disabled={set.options.length <= 1} aria-label={`Quitar opción ${oi + 1} de grupo ${index + 1}`} onClick={() => change('modifierSets', details.modifierSets.map(s => s.id === set.id ? { ...s, max: Math.min(s.max, s.options.length - 1), min: Math.min(s.min, s.options.length - 1), options: s.options.filter(item => item.id !== o.id) } : s))}><Trash2 size={18} /></button></div>)}
            <div className="editor-row-actions"><button type="button" className="editor-text-button" disabled={set.options.length >= 12} onClick={() => change('modifierSets', details.modifierSets.map(s => s.id === set.id ? { ...s, options: [...s.options, { id: crypto.randomUUID(), name: '', priceCents: 0 }] } : s))}>Añadir opción</button><button type="button" className="editor-text-button" onClick={() => change('modifierSets', details.modifierSets.filter(s => s.id !== set.id))}>Quitar grupo</button></div>
          </div>)}
          <button type="button" className="editor-add" disabled={details.modifierSets.length >= 6} onClick={() => change('modifierSets', [...details.modifierSets, { id: crypto.randomUUID(), name: '', min: 0, max: 1, options: [{ id: crypto.randomUUID(), name: '', priceCents: 0 }] }])}><Plus size={18} />Añadir grupo de modificadores</button>
        </section>
        <section id="product-inventory" className="editor-section"><h3>Disponibilidad e inventario</h3>
          <label className="editor-check"><input type="checkbox" checked={details.soldOut} onChange={e => change('soldOut', e.target.checked)} /><span>Marcar como agotado<small>También puedes hacerlo directamente desde Venta.</small></span></label>
          <label className="editor-check"><input type="checkbox" checked={details.favorite} onChange={e => change('favorite', e.target.checked)} /><span>Mostrar en favoritos</span></label>
          <label className="editor-check"><input type="checkbox" checked={details.trackStock} onChange={e => change('trackStock', e.target.checked)} /><span>Controlar existencias<small>Se descuenta una unidad por artículo vendido, incluidas sus variantes.</small></span></label>
          {details.trackStock && <div className="editor-two-columns"><div className="field"><label htmlFor="product-stock">Existencias actuales</label><input id="product-stock" type="number" min={0} max={999999} step={1} value={details.stock} onChange={e => change('stock', Number(e.target.value))} required /></div><div className="field"><label htmlFor="product-low-stock">Aviso de pocas existencias</label><input id="product-low-stock" type="number" min={0} max={999999} value={details.lowStockAlert} onChange={e => change('lowStockAlert', Number(e.target.value))} /></div></div>}
          <div className="editor-two-columns">{(['sku','barcode'] as const).map(k => <div className="field" key={k}><label htmlFor={`product-${k}`}>{k === 'sku' ? 'SKU' : 'Código de barras / GTIN'}</label><input id={`product-${k}`} value={details[k]} maxLength={k === 'sku' ? 60 : 32} onChange={e => change(k, e.target.value)} /></div>)}</div>
        </section>
        <section id="product-additional" className="editor-section"><h3>Más detalles</h3>
          <div className="editor-two-columns"><div className="field"><label htmlFor="product-customer-name">Nombre para el cliente</label><input id="product-customer-name" value={details.customerName} maxLength={100} placeholder="Usar nombre del producto" onChange={e => change('customerName', e.target.value)} /></div><div className="field"><label htmlFor="product-kitchen-name">Nombre para cocina</label><input id="product-kitchen-name" value={details.kitchenName} maxLength={100} onChange={e => change('kitchenName', e.target.value)} /></div></div>
          {details.itemType === 'prepared' && <><div className="field"><label htmlFor="product-calories">Calorías (opcional)</label><input id="product-calories" type="number" min={0} max={100000} value={details.calories ?? ''} onChange={e => change('calories', e.target.value === '' ? null : Number(e.target.value))} /></div><div className="editor-two-columns"><div className="field"><label htmlFor="product-dietary">Preferencias alimentarias</label><input id="product-dietary" value={details.dietary} maxLength={200} onChange={e => change('dietary', e.target.value)} placeholder="Ej. Vegano, sin gluten" /></div><div className="field"><label htmlFor="product-allergens">Alérgenos</label><input id="product-allergens" value={details.allergens} maxLength={200} onChange={e => change('allergens', e.target.value)} placeholder="Ej. Leche, nueces" /></div></div></>}
        </section>
      </fieldset>
      <footer className="editor-footer">{error && <p className="pos-error" role="alert">{error}</p>}{uncertain && <p className="product-help">Reintenta para confirmar el guardado.</p>}<div className="editor-footer-actions"><button type="button" className="pos-button pos-secondary" disabled={busy} onClick={onClose}>Cancelar</button>{conflict ? <button type="button" className="pos-button pos-primary" onClick={onRefresh}>Revisar cambios</button> : <button className="pos-button pos-primary" disabled={busy} aria-busy={busy}>{busy ? 'Guardando…' : uncertain ? 'Reintentar guardado' : 'Guardar producto'}</button>}</div></footer>
    </form>
  </PosDialog>
}
