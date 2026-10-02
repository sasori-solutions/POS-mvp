import { useState } from "react";
import type { VatTreatment } from "../lib/pos-contracts";
import { money } from "../lib/pos";
import { includedTax } from "../lib/product-details";
import { vatRates } from "../lib/vat";

export default function ProductVatFields({
  treatment,
  priceCents,
  confirmedBorder,
  onChange,
}: {
  treatment: VatTreatment;
  priceCents: number | null;
  confirmedBorder: boolean;
  onChange: (value: VatTreatment) => void;
}) {
  const [borderAccepted, setBorderAccepted] = useState(confirmedBorder);
  const tax =
    priceCents === null ? null : includedTax(priceCents, vatRates[treatment]);
  return (
    <>
      <div className="field">
        <label htmlFor="product-tax">IVA del producto</label>
        <select
          id="product-tax"
          value={treatment === "unconfigured" ? "" : treatment}
          required
          aria-describedby="product-tax-help"
          onChange={(event) => {
            setBorderAccepted(false);
            onChange(event.target.value as VatTreatment);
          }}
        >
          <option value="" disabled>
            Selecciona el IVA
          </option>
          <option value="vat_16">16 % · General</option>
          <option value="vat_0">Tasa 0 % · Productos que califican</option>
          <option value="exempt">Exento de IVA</option>
          <option value="border_8">8 % · Estímulo fronterizo</option>
        </select>
        <p id="product-tax-help" className="text-sm text-muted">
          {treatment === "vat_16"
            ? "Para alimentos preparados, incluso para llevar o a domicilio. Se aplica también a tamaños y extras."
            : treatment === "vat_0"
              ? "La tasa 0 % no equivale a exento. Úsala solo si este producto califica; no aplica por ser un alimento preparado."
              : treatment === "exempt"
                ? "Úsalo solo cuando la operación esté exenta. No equivale a tasa 0 %."
                : treatment === "border_8"
                  ? "Solo para operaciones y negocios que cumplen los requisitos del estímulo fronterizo y presentan el aviso al SAT."
                  : "Este producto anterior no tenía IVA definido. Elige su tratamiento para guardar; su precio final se conserva."}
        </p>
      </div>
      {treatment === "border_8" && (
        <label className="flex min-h-12 items-start gap-3 py-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-5"
            required
            checked={borderAccepted}
            onChange={(event) => setBorderAccepted(event.target.checked)}
          />
          <span>
            El negocio aplica el estímulo fronterizo del IVA para esta
            operación.
          </span>
        </label>
      )}
      {priceCents !== null && treatment !== "unconfigured" && (
        <dl
          aria-label="Desglose del precio"
          className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 border-t border-line pt-4 text-sm [&_dd]:text-right [&_dd]:tabular-nums"
        >
          <dt className="text-muted">Precio sin IVA</dt>
          <dd>{money(priceCents - tax!)}</dd>
          <dt className="text-muted">
            {treatment === "exempt"
              ? "IVA · Exento"
              : `IVA ${vatRates[treatment] / 100} % incluido`}
          </dt>
          <dd>{money(tax!)}</dd>
          <dt className="font-medium">Precio final al público</dt>
          <dd className="font-medium">{money(priceCents)}</dd>
        </dl>
      )}
    </>
  );
}
