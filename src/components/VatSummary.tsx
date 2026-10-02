import type { VatLine } from "../lib/vat";
import { vatSummary } from "../lib/vat";
import { money } from "../lib/pos";

export default function VatSummary({ lines }: { lines: VatLine[] }) {
  const summary = vatSummary(lines);
  return (
    <>
      <div>
        <dt>{summary.unknown ? "Importe de productos" : "Subtotal sin IVA"}</dt>
        <dd>
          {money(summary.unknown ? summary.totalCents : summary.baseCents)}
        </dd>
      </div>
      {summary.groups.map((group) => (
        <div key={group.treatment}>
          <dt>
            {group.label}
            {summary.unknown && group.cents > 0 && group.treatment !== "legacy"
              ? " incluido"
              : ""}
          </dt>
          <dd>{money(group.cents)}</dd>
        </div>
      ))}
      {summary.unknown && (
        <div>
          <dt className="text-xs!">
            {lines.some((line) => line.taxTreatment === "unconfigured")
              ? "Hay productos con IVA sin definir"
              : "Registro anterior sin clasificación de IVA"}
          </dt>
          <dd />
        </div>
      )}
    </>
  );
}
