import { useState } from "react";
import type { ItemSelection, Product } from "../lib/pos-contracts";
import { activeModifierSets, modifierOptionAvailable, modifierOptionLimit, modifierQuantity, normalizeModifierIds, productAvailabilityReason, productDetails, selectedPrice, selectionIssue } from "../lib/product-details";
import { money, parsePrice } from "../lib/pos";
import { PosDialog } from "./PosShared";
import MoneyInput from "./MoneyInput";

export default function ProductSelection({
  product,
  onClose,
  onAdd,
  addingDisabled = false,
}: {
  product: Product;
  onClose: () => void;
  onAdd: (selection: ItemSelection) => void;
  addingDisabled?: boolean;
}) {
  const d = productDetails(product);
  const [variationId, setVariationId] = useState<string | null>(
    d.variations.find((v) => !v.soldOut)?.id ?? null,
  );
  const [modifierIds, setModifierIds] = useState<string[]>([]);
  const updateModifierIds = (update: (ids: string[]) => string[]) => setModifierIds(ids => normalizeModifierIds(product, update(ids)));
  const [price, setPrice] = useState("");
  const selection = {
    variationId,
    modifierIds,
    variablePriceCents: d.variablePrice ? parsePrice(price) : null,
  };
  const valid =
    !selectionIssue(product, selection) &&
    (!d.variablePrice || selection.variablePriceCents !== null) &&
    (!d.variations.length || d.variations.some((v) => v.id === variationId && !v.soldOut)) &&
    modifierIds.length <= 24 &&
    selectedPrice(product, selection) <= 99_999_999;
  return (
    <PosDialog title={product.name} onClose={onClose} className="product-selection-dialog">
      {product.image && (
        <img
          width={240}
          height={240}
          src={product.image}
          className="selection-photo mb-4 max-h-45 w-full rounded-lg object-cover"
          alt=""
        />
      )}
      {d.description && (
        <p className="selection-description mb-4">{d.description}</p>
      )}
      {d.customerName && d.customerName !== product.name && (
        <p className="product-help mb-4 text-sm">En la cuenta: {d.customerName}</p>
      )}
      {Boolean(product.comboComponents?.length) && <div className="mb-4 rounded-lg bg-surface p-4"><p className="mb-2 text-sm font-medium">Este combo incluye</p><ul className="m-0 list-none space-y-2 p-0 text-sm" aria-label="Componentes del combo">{product.comboComponents!.map((component, index) => <li key={index}>{component.quantity} × {component.name}{component.selectionLabel ? ` · ${component.selectionLabel}` : ''}</li>)}</ul></div>}
      {(d.calories !== null || d.dietary || d.allergens) && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg bg-surface p-4" aria-label="Información alimentaria">
          {d.calories !== null && <p className="text-sm">Calorías: {d.calories} kcal</p>}
          {d.dietary && <p className="text-sm">Preferencias alimentarias: {d.dietary}</p>}
          {d.allergens && <p className="text-sm">Alérgenos: {d.allergens}</p>}
        </div>
      )}
      {Boolean(d.customAttributes?.length) && (
        <dl className="mb-4 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-sm" aria-label="Atributos del producto">
          {d.customAttributes!.map((attribute, index) => (
            <div key={index} className="col-span-full grid grid-cols-subgrid gap-x-4">
              <dt className="text-muted [overflow-wrap:anywhere]">{attribute.name}</dt>
              <dd className="m-0 [overflow-wrap:anywhere]">{attribute.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {d.variations.length > 0 && (
        <fieldset className="selection-group mt-6 border-0 p-0 [&_legend]:w-full [&_legend]:pb-3 [&_legend]:font-medium [&_legend_small]:mt-1 [&_legend_small]:block [&_legend_small]:text-[13px] [&_legend_small]:font-normal [&_legend_small]:text-muted">
          <legend>Presentación</legend>
          {d.variations.map((v) => (
            <label
              key={v.id}
              className="selection-choice flex min-h-14 cursor-pointer items-center gap-3 border-t border-line py-3 [&_input]:size-5 [&_span]:min-w-0 [&_span]:flex-1 [&_span]:[overflow-wrap:anywhere] [&_small]:block [&_small]:text-muted [&_b]:text-sm [&_b]:font-normal has-disabled:cursor-default has-disabled:opacity-50"
            >
              <input
                type="radio"
                name="variation"
                value={v.id}
                checked={variationId === v.id}
                disabled={v.soldOut}
                onChange={() => setVariationId(v.id)}
              />
              <span>
                {v.name}
                {v.soldOut && <small>Agotada</small>}
              </span>
              <b>{money(v.priceCents)}</b>
            </label>
          ))}
        </fieldset>
      )}
      {d.variablePrice && (
        <div className="field">
          <label htmlFor="sale-variable-price">Precio de esta venta MXN</label>
          <MoneyInput
            id="sale-variable-price"
            value={price}
            onValueChange={setPrice}
            placeholder="$0.00"
            autoFocus
          />
        </div>
      )}
      {activeModifierSets(product, selection).map((s) => (
        <fieldset
          key={s.id}
          className="selection-group mt-6 border-0 p-0 [&_legend]:w-full [&_legend]:pb-3 [&_legend]:font-medium [&_legend_small]:mt-1 [&_legend_small]:block [&_legend_small]:text-[13px] [&_legend_small]:font-normal [&_legend_small]:text-muted"
        >
          <legend>
            {s.name}{" "}
            <small>
              {s.min > 0
                ? `Elige de ${s.min} a ${s.max}`
                : `Opcional · hasta ${s.max}`}
            </small>
          </legend>
          {s.options.map((o) => {
            const quantity = modifierQuantity(selection, o.id), checked = quantity > 0;
            const count = s.options.reduce((sum, item) => sum + modifierQuantity(selection, item.id), 0);
            const adjustment = o.priceCents ? `${o.priceCents > 0 ? '+' : '−'}${money(Math.abs(o.priceCents))}` : 'Sin costo';
            if (modifierOptionLimit(o) > 1 && s.max > 1) return (
              <div key={o.id} className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-line py-3">
                <div className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span>{o.name}</span><small className="block text-muted">{!modifierOptionAvailable(d.modifierSets, o.id) ? 'No disponible' : `${adjustment} por unidad`}</small></div>
                <div className="flex items-center gap-2" aria-label={`Cantidad de ${o.name}`}>
                  <button type="button" className="pos-icon-button" aria-label={`Reducir ${o.name}`} disabled={!quantity} onClick={() => updateModifierIds(ids => { const next = [...ids]; next.splice(next.indexOf(o.id), 1); return next; })}>−</button>
                  <output className="min-w-6 text-center" aria-label={`Unidades de ${o.name}`}>{quantity}</output>
                  <button type="button" className="pos-icon-button" aria-label={`Añadir ${o.name}`} disabled={!modifierOptionAvailable(d.modifierSets, o.id) || quantity >= modifierOptionLimit(o) || count >= s.max || modifierIds.length >= 24} onClick={() => updateModifierIds(ids => [...ids, o.id])}>+</button>
                </div>
              </div>
            );
            return (
              <label
                key={o.id}
                className="selection-choice flex min-h-14 cursor-pointer items-center gap-3 border-t border-line py-3 [&_input]:size-5 [&_span]:min-w-0 [&_span]:flex-1 [&_span]:[overflow-wrap:anywhere] [&_small]:block [&_small]:text-muted [&_b]:text-sm [&_b]:font-normal has-disabled:cursor-default has-disabled:opacity-50"
              >
                <input
                  type={s.max === 1 ? "radio" : "checkbox"}
                  name={s.id}
                  checked={checked}
                  disabled={
                    !modifierOptionAvailable(d.modifierSets, o.id) || (!checked &&
                    ((s.max > 1 && count >= s.max) ||
                      (modifierIds.length >= 24 && (s.max > 1 || count === 0))))
                  }
                  onChange={() =>
                    updateModifierIds((ids) =>
                      checked
                        ? ids.filter((id) => id !== o.id)
                        : [
                            ...ids.filter(
                              (id) =>
                                s.max !== 1 ||
                                !s.options.some((item) => item.id === id),
                            ),
                            o.id,
                          ],
                    )
                  }
                />
                <span>{o.name}{!modifierOptionAvailable(d.modifierSets, o.id) && <small>No disponible{o.soldOut ? '' : ': faltan opciones de preparación'}</small>}</span>
                <b>{adjustment}</b>
              </label>
            );
          })}
          {s.max === 1 && s.min === 0 && (
            <button
              type="button"
              className="editor-text-button inline-flex min-h-12 items-center gap-2 border-0 bg-transparent py-2 text-left text-sm font-medium text-brand-hover hover:text-brand"
              onClick={() =>
                updateModifierIds((ids) =>
                  ids.filter((id) => !s.options.some((o) => o.id === id)),
                )
              }
            >
              Sin {s.name.toLocaleLowerCase("es-MX")}
            </button>
          )}
        </fieldset>
      ))}
      <div className="dialog-actions selection-actions mt-6 flex flex-col gap-3">
        {(productAvailabilityReason(product) || selectedPrice(product, selection) < 0 || selectedPrice(product, selection) > 99_999_999) && <p role="alert" className="text-sm text-danger">{productAvailabilityReason(product) || 'Los ajustes deben dejar el precio entre $0.00 y $999,999.99.'}</p>}
        <button
          type="button"
          className="pos-button pos-primary"
          disabled={!valid || addingDisabled}
          onClick={() => {
            onAdd(selection);
            onClose();
          }}
        >
          Agregar · {money(selectedPrice(product, selection))}
        </button>
      </div>
    </PosDialog>
  );
}
