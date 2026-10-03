import type { VatLine } from "../lib/vat";
import { vatSummary } from "../lib/vat";
import { money } from "../lib/pos";

export default function VatSummary({ lines }: { lines: VatLine[] }) {
  const summary = vatSummary(lines);
  return (
    <div className="sale-vat-summary">
      <div>
        <dt>{summary.unknown ? "Productos" : "Subtotal sin IVA"}</dt>
        <dd>
          {money(summary.unknown ? summary.totalCents : summary.baseCents)}
        </dd>
      </div>
      {summary.groups.filter((group) => group.cents > 0).map((group) => (
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
          <dt className="sale-vat-note">
            {lines.some((line) => line.taxTreatment === "unconfigured")
              ? "IVA sin definir"
              : "IVA sin clasificar"}
          </dt>
          <dd />
        </div>
      )}
    </div>
  );
}
