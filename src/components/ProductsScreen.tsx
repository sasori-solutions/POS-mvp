import { useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, Power } from "lucide-react";
import { AccountClientError } from "../lib/account";
import type { Product } from "../lib/pos-contracts";
import { filterProducts, money, posRequest, type PosAccess } from "../lib/pos";
import ProductEditor from "./ProductEditor";
import { productDetails, isSoldOut } from "../lib/product-details";
import { CatalogFilters, EmptyCatalog, PosDialog } from "./PosShared";
import { accessErrorCodes, type CatalogState } from "./useCatalog";

export default function ProductsScreen({
  access,
  catalog,
  canManage,
  onSessionError,
}: {
  access: PosAccess;
  catalog: CatalogState;
  canManage: boolean;
  onSessionError?: (error: AccountClientError) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("active");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [toggling, setToggling] = useState<Product | null>(null);
  const [message, setMessage] = useState("");
  const products = catalog.products.filter(
    (product) => status === "all" || product.active === (status === "active"),
  );
  const filtered = filterProducts(products, query, category);

  function saved(product: Product) {
    catalog.upsert(product);
    setMessage(
      product.active
        ? "Producto guardado."
        : "Producto desactivado. Sus ventas se conservan.",
    );
    setEditing(null);
    setToggling(null);
  }
  return (
    <div className="products-screen">
      {canManage && (
        <div className="catalog-toolbar my-6 flex items-center justify-end gap-4 max-tablet:flex-wrap">
          <button
            className="pos-button pos-primary compact"
            onClick={() => {
              setMessage("");
              setEditing("new");
            }}
          >
            <Plus size={20} aria-hidden="true" />
            Agregar producto
          </button>
        </div>
      )}
      {message && (
        <p className="pos-status my-4 text-sm text-muted" role="status">
          {message}
        </p>
      )}
      <CatalogFilters
        products={catalog.products}
        query={query}
        category={category}
        onQuery={setQuery}
        onCategory={setCategory}
      />
      {canManage && (
        <div className="catalog-status-filter mb-4 flex items-center gap-3 text-sm [&_select]:min-h-12 [&_select]:rounded-lg [&_select]:border [&_select]:border-line [&_select]:bg-white [&_select]:px-4 [&_select]:py-2 [&_select]:text-ink">
          <label htmlFor="product-status">Mostrar</label>
          <select
            id="product-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
            <option value="all">Todos</option>
          </select>
        </div>
      )}
      {catalog.error && (
        <div
          className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
          role="alert"
        >
          <p>{catalog.error}</p>
          <button
            className="pos-button pos-secondary compact"
            onClick={() => void catalog.refresh()}
            disabled={catalog.loading}
          >
            Reintentar
          </button>
        </div>
      )}
      {catalog.loading && !catalog.loaded && (
        <p className="pos-status my-4 text-sm text-muted" role="status">
          Cargando productos…
        </p>
      )}
      {catalog.loaded && !filtered.length ? (
        <EmptyCatalog
          title={
            catalog.products.length
              ? "Sin productos para esta búsqueda"
              : "Aún no hay productos"
          }
          description={
            catalog.products.length
              ? "Prueba otro nombre, categoría o estado."
              : canManage
                ? "Agrega tu primer producto para empezar a vender."
                : "Pide al dueño que agregue productos."
          }
        />
      ) : (
        <ul
          className="product-list m-0 list-none border-t border-line p-0"
          aria-label="Catálogo de productos"
        >
          {filtered.map((product) => {
            const d = productDetails(product);
            const prices = d.variations.map((v) => v.priceCents);
            const details = (
              <>
                <span
                  className="library-thumbnail grid size-13 shrink-0 place-items-center overflow-hidden rounded-md text-[17px] text-ink [&_img]:size-full [&_img]:object-cover max-[24.375rem]:size-10"
                  style={{ backgroundColor: d.tileColor }}
                >
                  {product.image ? (
                    <img width={240} height={240} src={product.image} alt="" />
                  ) : (
                    d.tileLabel ||
                    product.name.slice(0, 2).toLocaleUpperCase("es-MX")
                  )}
                </span>
                <div className="product-list-info min-w-0 flex-1 [overflow-wrap:anywhere] [&_strong]:font-medium [&_p]:mt-1 [&_p]:text-sm">
                  <strong>{product.name}</strong>
                  <p>
                    {product.category || "Sin categoría"}
                    {isSoldOut(product) && (
                      <span className="product-state ml-2 inline-block rounded border border-line px-1.5 py-0.5 text-xs text-muted">
                        Agotado
                      </span>
                    )}
                    {d.variations.length > 0 && (
                      <span className="product-state ml-2 inline-block rounded border border-line px-1.5 py-0.5 text-xs text-muted">
                        {d.variations.length} variantes
                      </span>
                    )}
                    {!product.active && (
                      <span className="product-state ml-2 inline-block rounded border border-line px-1.5 py-0.5 text-xs text-muted">
                        Inactivo
                      </span>
                    )}
                  </p>
                </div>
                <span className="product-price font-medium whitespace-nowrap tabular-nums">
                  {d.variablePrice
                    ? "Variable"
                    : `${prices.length ? "Desde " : ""}${money(prices.length ? Math.min(...prices) : product.priceCents)}`}
                </span>
              </>
            );
            return (
              <li
                key={product.id}
                className={product.active ? "" : "inactive-product"}
              >
                {canManage ? (
                  <button
                    className="product-edit flex min-h-22 min-w-0 flex-1 items-center gap-6 rounded-sm border-0 bg-transparent px-2 py-4 text-left hover:bg-surface [&>svg]:shrink-0 [&>svg]:text-muted max-tablet:gap-3 max-tablet:px-0"
                    aria-label={`Editar ${product.name}`}
                    onClick={() => {
                      setMessage("");
                      setEditing(product);
                    }}
                  >
                    {details}
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                ) : (
                  <div className="product-edit flex min-h-22 min-w-0 flex-1 items-center gap-6 rounded-sm border-0 bg-transparent px-2 py-4 text-left hover:bg-surface [&>svg]:shrink-0 [&>svg]:text-muted max-tablet:gap-3 max-tablet:px-0">
                    {details}
                  </div>
                )}
                {canManage && (
                  <button
                    className="pos-icon-button product-availability size-12 min-h-12"
                    title={
                      product.active
                        ? "Desactivar producto"
                        : "Activar producto"
                    }
                    aria-label={`${product.active ? "Desactivar" : "Activar"} ${product.name}`}
                    onClick={() => {
                      setMessage("");
                      setToggling(product);
                    }}
                  >
                    <Power size={19} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <ProductEditor
          product={editing === "new" ? null : editing}
          products={catalog.products}
          access={access}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onRefresh={() => {
            setEditing(null);
            void catalog.refresh();
          }}
          onSessionError={onSessionError}
        />
      )}
      {toggling && (
        <ProductActivation
          product={toggling}
          access={access}
          onClose={() => setToggling(null)}
          onSaved={saved}
          onRefresh={() => {
            setToggling(null);
            void catalog.refresh();
          }}
          onSessionError={onSessionError}
        />
      )}
    </div>
  );
}

function ProductActivation({
  product,
  access,
  onClose,
  onSaved,
  onRefresh,
  onSessionError,
}: {
  product: Product;
  access: PosAccess;
  onClose: () => void;
  onSaved: (product: Product) => void;
  onRefresh: () => void;
  onSessionError?: (error: AccountClientError) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function save() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await posRequest(access, {
        command: "set_product_active",
        productId: product.id,
        expectedVersion: product.version,
        active: !product.active,
        operationId: operationId.current,
      });
      if (mounted.current) onSaved(saved);
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "No pudimos cambiar el producto.",
      );
      if (caught instanceof AccountClientError) {
        setConflict(caught.code === "PRODUCT_CHANGED");
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <PosDialog
      title={product.active ? "Desactivar producto" : "Activar producto"}
      onClose={onClose}
      busy={busy}
    >
      <p>
        <strong>{product.name}</strong>
        {product.active
          ? " dejará de aparecer en nuevas ventas. Las ventas anteriores se conservan."
          : " volverá a estar disponible para vender."}
      </p>
      {error && (
        <p
          className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="dialog-actions mt-6 flex flex-col gap-3">
        {conflict ? (
          <button className="pos-button pos-primary" onClick={onRefresh}>
            Volver a productos
          </button>
        ) : (
          <button
            className="pos-button pos-primary"
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? "Guardando…" : product.active ? "Desactivar" : "Activar"}
          </button>
        )}
        <button
          className="pos-button pos-secondary"
          disabled={busy}
          onClick={onClose}
        >
          Cancelar
        </button>
      </div>
    </PosDialog>
  );
}
