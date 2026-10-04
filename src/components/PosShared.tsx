import VatSummary from "./VatSummary";
import { useEffect, useId, useRef } from "react";
import { ArrowLeft, Package, Search, X } from "lucide-react";
import { gsap } from "gsap";
import type { Product, Sale } from "../lib/pos-contracts";
import { money, saleDate } from "../lib/pos";

export const paymentLabels = {
  cash: "Efectivo",
  card_external: "Tarjeta externa",
  card_integrated: "Mercado Pago",
  transfer: "Transferencia",
};

export function CatalogFilters({
  products,
  query,
  category,
  onQuery,
  onCategory,
  action,
  trailingFilter,
  appearance = "library",
}: {
  products: Product[];
  query: string;
  category: string;
  onQuery: (value: string) => void;
  onCategory: (value: string) => void;
  action?: React.ReactNode;
  trailingFilter?: React.ReactNode;
  appearance?: "library" | "sale";
}) {
  const categories = [
    ...new Set(products.map((product) => product.category).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "es"));
  const sale = appearance === "sale";
  return (
    <div className={sale ? "catalog-filters sale-filters" : "catalog-filters my-5 flex flex-col gap-4"}>
      <div className="flex items-center gap-3 max-tablet:flex-wrap">
        <div className={sale ? "catalog-search" : "catalog-search flex min-h-13.5 min-w-0 flex-1 items-center gap-3 rounded-lg border border-transparent bg-surface px-4 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand [&_input]:min-h-13 [&_input]:min-w-0 [&_input]:w-full [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-ink [&_input:focus-visible]:outline-none [&_button]:-mr-3 [&_button]:size-12 [&_button]:min-h-12 [&_svg]:shrink-0 max-tablet:basis-full"}>
          <Search size={20} aria-hidden="true" />
          <input
            aria-label="Buscar producto"
            type="search"
            placeholder="Buscar producto"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="pos-icon-button"
              aria-label="Limpiar búsqueda"
              onClick={() => onQuery("")}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        {action}
      </div>
      <div className="flex min-w-0 items-start justify-between gap-4 max-tablet:flex-wrap">
        <div
          className="catalog-categories flex min-w-0 max-w-full gap-2 overflow-x-auto px-0.5 pt-0.5 pb-2"
          role="group"
          aria-label="Categorías"
        >
          {["", ...categories].map((value) => (
            <button
              type="button"
              key={value}
              className={sale ? "catalog-category" : "catalog-category min-h-12 max-w-55 shrink-0 rounded-lg border border-line bg-white px-4 py-2.5 [overflow-wrap:anywhere] hover:border-brand aria-pressed:border-brand-soft aria-pressed:bg-brand-soft aria-pressed:text-brand-hover"}
              aria-pressed={category === value}
              onClick={() => onCategory(value)}
            >
              {value || "Todo"}
            </button>
          ))}
        </div>
        {trailingFilter}
      </div>
    </div>
  );
}

export function EmptyCatalog({
  title = "Aún no hay productos",
  description = "Agrega tu primer producto para empezar a vender.",
  children,
}: {
  title?: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="pos-empty flex min-h-70 flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center tablet:min-h-90 [&_h2]:text-[22px] [&_p]:max-w-[32ch]">
      <Package
        className="pos-empty-icon mb-2 text-muted"
        size={32}
        strokeWidth={1.4}
        aria-hidden="true"
      />
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}

export function PosDialog({
  title,
  onClose,
  busy = false,
  children,
  className = "",
}: {
  className?: string;
  title: string;
  onClose: () => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus();
    const animation = window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches
      ? gsap.fromTo(dialog, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: .16, ease: 'power2.out', clearProps: 'transform,opacity' })
      : null;
    return () => {
      animation?.kill();
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const editor = className === "product-editor-dialog";
  return (
    <dialog
      ref={ref}
      className={`pos-dialog ${className} m-auto overflow-y-auto border border-line bg-white text-ink ${editor ? "w-[min(1056px,calc(100%-48px))] max-h-[calc(100dvh-48px)] rounded-xl p-0 max-tablet:h-dvh max-tablet:max-h-dvh max-tablet:w-full max-tablet:rounded-none max-tablet:border-0" : "w-[min(560px,calc(100%-32px))] max-h-[calc(100dvh-32px)] rounded-xl p-6 max-tablet:p-5"}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div
        className={`pos-dialog-heading flex items-center justify-between gap-4 [&_h2]:font-medium [&_h2]:tracking-tight ${editor ? "sticky top-0 z-30 border-b border-line bg-white px-6 py-4 [&_h2]:text-[22px] max-tablet:px-4 max-tablet:py-3" : "mb-6 [&_h2]:text-2xl"}`}
      >
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="pos-icon-button"
          aria-label="Cerrar"
          onClick={onClose}
          disabled={busy}
        >
          <X size={22} aria-hidden="true" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function SaleDetail({ sale }: { sale: Sale }) {
  return (
    <div className="sale-detail [&>p+p]:mt-2 [&>p+p]:text-sm">
      <p className="sale-reference font-medium text-ink">
        Venta #{sale.id.slice(0, 8).toUpperCase()}
      </p>
      <p>{saleDate(sale.createdAt, sale.timezone)}</p>
      <ul className="sale-detail-items my-6 list-none border-t border-line p-0 [&_li]:flex [&_li]:justify-between [&_li]:gap-6 [&_li]:border-b [&_li]:border-line [&_li]:py-4 [&_strong]:font-medium [&_strong]:[overflow-wrap:anywhere] [&_p]:mt-1 [&_p]:text-sm [&_li>span]:shrink-0 [&_li>span]:tabular-nums [&_li>div]:min-w-0">
        {sale.items.map((item, index) => (
          <li key={`${item.productId}:${index}`}>
            <div>
              <strong>{item.name}</strong>
              <p>{item.selectionLabel}</p>
              <p>
                {item.quantity} × {money(item.unitPriceCents)}
              </p>
            </div>
            <span>{money(item.totalCents)}</span>
          </li>
        ))}
      </ul>
      <dl className="sale-totals mb-3 flex flex-col gap-4">
        <VatSummary lines={sale.items} />
        <div className="sale-total">
          <dt>Total MXN</dt>
          <dd>{money(sale.totalCents)}</dd>
        </div>
        <div>
          <dt>Método de pago</dt>
          <dd>{paymentLabels[sale.paymentMethod]}</dd>
        </div>
        <div>
          <dt>Registró</dt>
          <dd>{sale.operatorName}</dd>
        </div>
      </dl>
    </div>
  );
}

export function BackToCatalog({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="back-button -mt-4 mb-4 flex min-h-12 items-center gap-2 self-start border-0 bg-transparent pt-0 pb-4 text-sm text-muted hover:text-ink"
      onClick={onClick}
    >
      <ArrowLeft size={20} aria-hidden="true" />
      Volver al catálogo
    </button>
  );
}
