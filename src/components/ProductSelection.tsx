import { useState } from "react";
import type { ItemSelection, Product } from "../lib/pos-contracts";
import { isSoldOut, productDetails, selectedPrice } from "../lib/product-details";
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
  const [price, setPrice] = useState("");
  const selection = {
    variationId,
    modifierIds,
    variablePriceCents: d.variablePrice ? parsePrice(price) : null,
  };
  const valid =
    !isSoldOut(product) &&
    (!d.variablePrice || selection.variablePriceCents !== null) &&
    (!d.variations.length || d.variations.some((v) => v.id === variationId && !v.soldOut)) &&
    d.modifierSets.every((s) => {
      const count = s.options.filter((o) => modifierIds.includes(o.id)).length;
      return count >= s.min && count <= s.max;
    }) &&
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
      {d.modifierSets.map((s) => (
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
            const checked = modifierIds.includes(o.id);
            const count = s.options.filter((item) =>
              modifierIds.includes(item.id),
            ).length;
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
                    !checked &&
                    ((s.max > 1 && count >= s.max) ||
                      (modifierIds.length >= 24 && (s.max > 1 || count === 0)))
                  }
                  onChange={() =>
                    setModifierIds((ids) =>
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
                <span>{o.name}</span>
                <b>{o.priceCents ? `+${money(o.priceCents)}` : "Sin costo"}</b>
              </label>
            );
          })}
          {s.max === 1 && s.min === 0 && (
            <button
              className="editor-text-button inline-flex min-h-12 items-center gap-2 border-0 bg-transparent py-2 text-left text-sm font-medium text-brand-hover hover:text-brand"
              onClick={() =>
                setModifierIds((ids) =>
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
        <button
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
