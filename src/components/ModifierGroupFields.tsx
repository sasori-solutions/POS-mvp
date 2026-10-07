import { Trash2 } from 'lucide-react'
import type { ModifierSet } from '../lib/pos-contracts'
import { modifierGroupCapacity } from '../lib/product-details'
import MoneyInput from './MoneyInput'

export default function ModifierGroupFields({ group, index = 0, onChange, moneyValue, onMoneyChange }: {
  group: ModifierSet; index?: number; onChange: (group: ModifierSet) => void;
  moneyValue: (id: string, cents: number) => string; onMoneyChange: (id: string, value: string) => void
}) {
  return <>
    <div className="field"><label htmlFor={`modifier-set-${group.id}`}>Grupo {index + 1}</label>
      <input id={`modifier-set-${group.id}`} data-dialog-autofocus value={group.name} placeholder="Ej. Leche" maxLength={60} required onChange={event => onChange({ ...group, name: event.target.value })} />
    </div>
    <div className="grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
      {(['min', 'max'] as const).map(key => <div className="field" key={key}>
        <label htmlFor={`${key}-${group.id}`}>{key === 'min' ? 'Selecciones mínimas' : 'Selecciones máximas'}</label>
        <input id={`${key}-${group.id}`} type="number" inputMode="numeric" min={key === 'min' ? 0 : 1} max={modifierGroupCapacity(group)} value={group[key]} onChange={event => onChange({ ...group, [key]: Number(event.target.value) })} />
      </div>)}
    </div>
    <p className="text-sm text-muted">Los límites cuentan unidades: dos shots son dos selecciones.</p>
    <p className="text-sm text-muted">Puedes ofrecer Media porción como una opción con un ajuste de precio.</p>
    {group.options.map((option, optionIndex) => {
      const value = moneyValue(option.id, option.priceCents), negative = value.startsWith('-')
      return <div key={option.id} className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <div className="flex items-end gap-2">
          <div className="field min-w-0 flex-1"><label htmlFor={`modifier-${option.id}`}>Opción {optionIndex + 1} de grupo {index + 1}</label>
            <input id={`modifier-${option.id}`} value={option.name} maxLength={60} required placeholder="Ej. Leche de avena" onChange={event => onChange({ ...group, options: group.options.map(item => item.id === option.id ? { ...item, name: event.target.value } : item) })} />
          </div>
          <button type="button" className="pos-icon-button" disabled={group.options.length <= 1} aria-label={`Quitar opción ${optionIndex + 1} de grupo ${index + 1}`} onClick={() => {
            const options = group.options.filter(item => item.id !== option.id), capacity = modifierGroupCapacity({ ...group, options })
            onChange({ ...group, options, min: Math.min(group.min, capacity), max: Math.min(group.max, capacity) })
          }}><Trash2 size={18} aria-hidden="true" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3 max-[30rem]:grid-cols-1">
          <div className="field"><label htmlFor={`modifier-adjustment-${option.id}`}>Ajuste de {option.name || `opción ${optionIndex + 1}`}</label>
            <select id={`modifier-adjustment-${option.id}`} value={negative ? 'subtract' : 'add'} onChange={event => onMoneyChange(option.id, `${event.target.value === 'subtract' ? '-' : ''}${value.replace(/^-/, '')}`)}>
              <option value="add">Añade al precio</option><option value="subtract">Resta del precio</option>
            </select>
          </div>
          <div className="field"><label htmlFor={`modifier-price-${option.id}`}>Precio extra {optionIndex + 1}</label>
            <MoneyInput id={`modifier-price-${option.id}`} value={value.replace(/^-/, '')} required onValueChange={next => onMoneyChange(option.id, `${negative ? '-' : ''}${next}`)} />
          </div>
          <div className="field"><label htmlFor={`modifier-quantity-${option.id}`}>Máximo de {option.name || `opción ${optionIndex + 1}`}</label>
            <input id={`modifier-quantity-${option.id}`} type="number" inputMode="numeric" min={1} max={24} value={option.maxQuantity ?? 1} onChange={event => onChange({ ...group, options: group.options.map(item => item.id === option.id ? { ...item, maxQuantity: Number(event.target.value) } : item) })} />
          </div>
          <label className="flex min-h-12 items-center gap-3 self-end"><input type="checkbox" className="size-5" checked={option.soldOut ?? false} onChange={event => onChange({ ...group, options: group.options.map(item => item.id === option.id ? { ...item, soldOut: event.target.checked } : item) })} />No disponible</label>
        </div>
      </div>
    })}
    <button type="button" className="editor-text-button inline-flex min-h-12 items-center gap-2 text-left text-sm font-medium text-brand" disabled={group.options.length >= 12} onClick={() => onChange({ ...group, options: [...group.options, { id: crypto.randomUUID(), name: '', priceCents: 0 }] })}>Añadir opción</button>
  </>
}
