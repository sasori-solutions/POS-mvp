import type { ProductDetails, VatTreatment } from "./pos-contracts";
import { includedTax } from "./product-details";

export const vatRates: Record<VatTreatment, number> = {
  vat_16: 1600,
  vat_0: 0,
  exempt: 0,
  border_8: 800,
  unconfigured: 0,
};
export const vatLabels: Record<VatTreatment | "legacy", string> = {
  vat_16: "IVA 16 %",
  vat_0: "IVA tasa 0 %",
  exempt: "Exento de IVA",
  border_8: "IVA 8 % (frontera)",
  unconfigured: "IVA sin definir",
  legacy: "IVA incluido (registro anterior)",
};
export function productVat(
  details: Pick<ProductDetails, "taxBps" | "taxTreatment">,
): VatTreatment {
  return (
    details.taxTreatment ??
    (details.taxBps === 1600
      ? "vat_16"
      : details.taxBps === 800
        ? "border_8"
        : "unconfigured")
  );
}
export interface VatLine {
  totalCents: number;
  taxCents?: number;
  taxBps?: number | null;
  taxTreatment?: VatTreatment | "legacy";
}
export function vatSummary(lines: VatLine[]) {
  let totalCents = 0,
    taxCents = 0,
    unknown = false;
  const groups = new Map<VatTreatment | "legacy", number>();
  for (const line of lines) {
    const treatment = line.taxTreatment ?? "legacy";
    const tax = line.taxCents ?? includedTax(line.totalCents, line.taxBps ?? 0);
    totalCents += line.totalCents;
    taxCents += tax;
    if (
      treatment === "unconfigured" ||
      (treatment === "legacy" && line.taxBps == null)
    )
      unknown = true;
    if (treatment !== "unconfigured" && (treatment !== "legacy" || tax > 0))
      groups.set(treatment, (groups.get(treatment) ?? 0) + tax);
  }
  return {
    totalCents,
    baseCents: totalCents - taxCents,
    taxCents,
    unknown,
    groups: [...groups].map(([treatment, cents]) => ({
      treatment,
      label: vatLabels[treatment],
      cents,
    })),
  };
}
