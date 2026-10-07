import { useEffect, useRef, useState } from "react";
import { ChevronRight, Ellipsis, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { AccountClientError } from "../lib/account";
import type { Product, VatTreatment } from "../lib/pos-contracts";
import { filterProducts, money, posRequest, type PosAccess } from "../lib/pos";
import ProductEditor from "./ProductEditor";
import { productDetails, isSoldOut } from "../lib/product-details";
import { CatalogFilters, EmptyCatalog, PosDialog } from "./PosShared";
import { accessErrorCodes, type CatalogState } from "./useCatalog";
import LoadingPlaceholder, { PendingIndicator } from "./LoadingPlaceholder";
import ModifierLibrary from "./ModifierLibrary";
import CatalogBulkPanel from "./CatalogBulkPanel";

export default function ProductsScreen({
  access,
  catalog,
  canManage,
  actorId = 'owner',
  defaultVatTreatment,
  canAvailability = false,
  onSessionError,
}: {
  access: PosAccess;
  catalog: CatalogState;
  canManage: boolean;
  actorId?: string;
  defaultVatTreatment?: VatTreatment;
  canAvailability?: boolean;
  onSessionError?: (error: AccountClientError) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("active");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [toggling, setToggling] = useState<Product | null>(null);
  const [availability, setAvailability] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [message, setMessage] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  const focusAfterDeletion = useRef(false);
  useEffect(() => {
    if (!deleting && focusAfterDeletion.current) {
      focusAfterDeletion.current = false;
      screen.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }
  }, [deleting]);
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
    <div className="products-screen" ref={screen}>
      {canManage && <nav aria-label="Herramientas de catálogo" className="mb-5 flex flex-wrap gap-3"><button className="pos-button pos-secondary" aria-pressed={!libraryOpen} onClick={() => setLibraryOpen(false)}>Productos</button><button className="pos-button pos-secondary" aria-pressed={libraryOpen} onClick={() => setLibraryOpen(true)}>Biblioteca de extras</button><button className="pos-button pos-secondary" onClick={() => setBulkOpen(true)}>Gestionar catálogo</button></nav>}
      {bulkOpen && <CatalogBulkPanel access={access} actorId={actorId} products={catalog.products} defaultVatTreatment={defaultVatTreatment} onClose={() => setBulkOpen(false)} onSessionError={onSessionError} onSaved={products => { products.forEach(catalog.upsert); void catalog.refresh(); }} />}
      {libraryOpen ? <ModifierLibrary access={access} onSessionError={onSessionError} onProductsChanged={products => { products.forEach(catalog.upsert); void catalog.refresh(); }} /> : <>
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
        action={canManage && (
          <button className="pos-button pos-primary compact max-tablet:w-full" onClick={() => { setMessage(""); setEditing("new"); }}>
            <Plus size={20} aria-hidden="true" /> Agregar producto
          </button>
        )}
        trailingFilter={canManage && (
        <div className="catalog-status-filter flex shrink-0 items-center gap-3 text-sm [&_select]:min-h-12 [&_select]:rounded-lg [&_select]:border [&_select]:border-line [&_select]:bg-white [&_select]:px-4 [&_select]:py-2 [&_select]:text-ink">
          <label htmlFor="product-status" className="max-tablet:sr-only">Mostrar</label>
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
      />
      {catalog.loaded && (
        <p className="mb-3 text-sm text-muted">{filtered.length} {filtered.length === 1 ? "producto" : "productos"}</p>
      )}
      {catalog.error && (
        <div
          className="pos-error mt-6 bg-danger-soft p-4 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
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
        <LoadingPlaceholder variant="list" rows={5} label="Cargando productos" />
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
            const priceLabel = d.variablePrice ? "Variable" : `${prices.length ? "Desde " : ""}${money(prices.length ? Math.min(...prices) : product.priceCents)}`;
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
                    {d.variations.length > 0 && (
                      <span className="product-state">
                        {" · "}{d.variations.length} {d.variations.length === 1 ? "tamaño" : "tamaños"}
                      </span>
                    )}
                  {" · "}<span className={product.active && !isSoldOut(product) ? "text-success" : "text-muted"}>
                    {!product.active ? "Inactivo" : isSoldOut(product) ? "Agotado" : "Activo"}
                  </span>
                  </p>
                  <span className="mt-2 block font-medium tabular-nums tablet:hidden">{priceLabel}</span>
                </div>
                <span className="product-price w-40 shrink-0 text-right font-medium whitespace-nowrap tabular-nums max-tablet:hidden">{priceLabel}</span>
              </>
            );
            return (
              <li
                key={product.id}
                className={product.active ? "" : "inactive-product"}
              >
                {canManage ? (
                  <button
                    className="product-edit flex min-h-22 min-w-0 flex-1 items-center gap-4 rounded-lg border-0 bg-transparent px-2 py-4 text-left hover:bg-surface [&>svg]:shrink-0 [&>svg]:text-muted max-tablet:gap-3 max-tablet:px-0 max-tablet:[&>svg]:hidden"
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
                  <div className="product-edit flex min-h-22 min-w-0 flex-1 items-center gap-4 px-2 py-4 text-left max-tablet:gap-3 max-tablet:px-0">
                    {details}
                  </div>
                )}
                {canAvailability && product.active && <button className="pos-button pos-secondary compact" aria-label={`Disponibilidad de ${product.name}`} onClick={() => setAvailability(product)}>Disponibilidad</button>}
                {canManage && (
                  <ProductActions
                    product={product}
                    onEdit={() => { setMessage(""); setEditing(product); }}
                    onToggle={() => { setMessage(""); setToggling(product); }}
                    onDelete={() => { setMessage(""); setDeleting(product); }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      </>}
      {availability && <ProductAvailability product={availability} access={access} onClose={() => setAvailability(null)} onSaved={products => { products.forEach(catalog.upsert); setAvailability(products.find(product => product.id === availability.id) ?? availability); void catalog.refresh(); }} onSessionError={onSessionError} />}
      {editing && (
        <ProductEditor
          defaultVatTreatment={defaultVatTreatment}
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
      {deleting && (
        <ProductDeletion
          product={deleting}
          access={access}
          onClose={() => setDeleting(null)}
          onDeleted={(id) => {
            catalog.remove(id);
            focusAfterDeletion.current = true;
            setDeleting(null);
            if (category && !catalog.products.some(product => product.id !== id && product.category === category)) setCategory("");
            setMessage("Producto eliminado.");
          }}
          onRefresh={() => { setDeleting(null); void catalog.refresh(); }}
          onSessionError={onSessionError}
        />
      )}
    </div>
  );
}

function ProductActions({ product, onEdit, onToggle, onDelete }: {
  product: Product; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && ref.current) ref.current.open = false;
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function choose(action: () => void) {
    if (ref.current) {
      ref.current.open = false;
      ref.current.querySelector("summary")?.focus();
    }
    action();
  }
  return (
    <details ref={ref} name="product-actions" className="product-actions relative shrink-0"
      onToggle={(event) => {
        const details = event.currentTarget;
        setOpen(details.open);
        if (details.open) {
          const height = details.querySelector<HTMLElement>('[data-product-menu]')?.offsetHeight ?? 164;
          setAbove(details.getBoundingClientRect().bottom + height + 8 > window.innerHeight - 96);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && ref.current) {
          event.preventDefault();
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary className="pos-icon-button list-none [&::-webkit-details-marker]:hidden" aria-label={`Acciones de ${product.name}`} title="Acciones del producto">
        <Ellipsis size={22} aria-hidden="true" />
      </summary>
      <div data-product-menu className={`absolute right-0 z-20 w-56 rounded-lg border border-line bg-white p-1 shadow-lg ${above ? "bottom-full mb-2" : "top-full mt-2"}`}>
        <button className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-surface" aria-label={`Editar ${product.name} desde acciones`} onClick={() => choose(onEdit)}>
          <Pencil size={18} aria-hidden="true" /> Editar
        </button>
        <button className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-surface" aria-label={`${product.active ? "Desactivar" : "Activar"} ${product.name}`} onClick={() => choose(onToggle)}>
          <Power size={18} aria-hidden="true" /> {product.active ? "Desactivar" : "Activar"}
        </button>
        <button className="flex min-h-12 w-full items-center gap-3 rounded-md border-t border-line px-3 text-left text-sm text-danger hover:bg-danger-soft" aria-label={`Eliminar ${product.name}`} onClick={() => choose(onDelete)}>
          <Trash2 size={18} aria-hidden="true" /> Eliminar
        </button>
      </div>
    </details>
  );
}

function ProductDeletion({ product, access, onClose, onDeleted, onRefresh, onSessionError }: {
  product: Product; access: PosAccess; onClose: () => void; onDeleted: (id: string) => void;
  onRefresh: () => void; onSessionError?: (error: AccountClientError) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function close() {
    if (uncertain) onRefresh();
    else onClose();
  }
  async function remove() {
    if (submitting.current || conflict) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await posRequest(access, { command: "delete_product", productId: product.id, expectedVersion: product.version, operationId: operationId.current });
      if (mounted.current) onDeleted(result.id);
    } catch (caught) {
      if (!mounted.current) return;
      const changed = caught instanceof AccountClientError && caught.code === "PRODUCT_CHANGED";
      setConflict(changed);
      setUncertain(!(caught instanceof AccountClientError) || ["NETWORK_ERROR", "SERVER_ERROR"].includes(caught.code));
      setError(changed ? "El producto cambió. Actualiza la lista y vuelve a intentarlo." : caught instanceof Error ? caught.message : "No pudimos eliminar el producto.");
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <PosDialog title="Eliminar producto" onClose={close} busy={busy}>
      <p className="text-ink">¿Eliminar <strong className="font-medium [overflow-wrap:anywhere]">{product.name}</strong>?</p>
      <p className="mt-3 text-sm">Se quitará del catálogo y no podrás recuperarlo. Las ventas anteriores se conservan.</p>
      {error && <p className="mt-4 text-sm text-danger" role="alert">{error}</p>}
      {uncertain && <p className="mt-3 text-sm">Reintenta para confirmar la eliminación.</p>}
      <div className="mt-6 flex gap-3 max-tablet:flex-col">
        <button className="pos-button pos-secondary" disabled={busy} onClick={close} data-dialog-autofocus>Cancelar</button>
        {conflict ? (
          <button className="pos-button pos-primary" onClick={onRefresh}>Actualizar productos</button>
        ) : (
          <button className="pos-button border-danger bg-danger text-white enabled:hover:brightness-90" disabled={busy} onClick={() => void remove()}>
            {busy && <PendingIndicator label="Eliminando producto" />}{uncertain ? "Reintentar eliminación" : "Eliminar producto"}
          </button>
        )}
      </div>
    </PosDialog>
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
            {busy && <PendingIndicator label="Guardando disponibilidad" />}{product.active ? "Desactivar" : "Activar"}
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

function ProductAvailability({product, access, onClose, onSaved, onSessionError}: {product: Product; access: PosAccess; onClose: () => void; onSaved: (products: Product[]) => void; onSessionError?: (error: AccountClientError) => void}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<Extract<import('../lib/pos-contracts').PosCommand, {command: 'set_product_sold_out' | 'set_modifier_option_sold_out'}> | null>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function toggle(soldOut: boolean, variationId?: string, modifierId?: string) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    const command = pending.current ?? (modifierId ? {command: 'set_modifier_option_sold_out' as const, operationId: crypto.randomUUID(), productId: product.id, expectedVersion: product.version, modifierId, soldOut} : {command: 'set_product_sold_out' as const, operationId: crypto.randomUUID(), productId: product.id, expectedVersion: product.version, soldOut, ...(variationId ? {variationId} : {})});
    pending.current = command;
    try { const products = command.command === 'set_modifier_option_sold_out' ? (await posRequest(access, command)).products : [await posRequest(access, command)]; pending.current = null; if (alive.current) onSaved(products); }
    catch (caught) {
      if (!alive.current) return;
      setError(caught instanceof Error ? caught.message : 'No pudimos cambiar la disponibilidad.');
      if (caught instanceof AccountClientError) {
        if (!['NETWORK_ERROR','SERVER_ERROR'].includes(caught.code)) pending.current = null;
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
      }
    } finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  const details = productDetails(product);
  return <PosDialog title="Disponibilidad" busy={busy || Boolean(pending.current)} onClose={onClose}>
    <p><strong>{product.name}</strong></p>
    <div className="ops-form"><button className="pos-button pos-secondary" disabled={busy || Boolean(pending.current)} onClick={() => void toggle(!details.soldOut)}>Producto · {details.soldOut ? 'Agotado' : 'Disponible'}</button>
      {details.variations.map(variation => <button key={variation.id} className="pos-button pos-secondary" disabled={busy || Boolean(pending.current)} onClick={() => void toggle(!variation.soldOut, variation.id)}>{variation.name} · {variation.soldOut ? 'Agotado' : 'Disponible'}</button>)}
      {details.modifierSets.map(group => <fieldset key={group.id} className="flex flex-col gap-3 rounded-lg border border-line p-4"><legend className="px-2 text-sm font-medium">{group.name}</legend>{group.libraryId && <p className="text-sm text-muted">Grupo compartido: el cambio aplica a todos los productos enlazados.</p>}{group.options.map(option => <button key={option.id} className="pos-button pos-secondary" disabled={busy || Boolean(pending.current)} onClick={() => void toggle(!option.soldOut, undefined, option.id)}>{option.name} · {option.soldOut ? 'No disponible' : 'Disponible'}</button>)}</fieldset>)}
      {error && <p role="alert">{error}</p>}
      {pending.current && !busy && <button className="pos-button pos-primary" onClick={() => { const command = pending.current!; void toggle(command.soldOut, command.command === 'set_product_sold_out' ? command.variationId : undefined, command.command === 'set_modifier_option_sold_out' ? command.modifierId : undefined); }}>Reintentar cambio</button>}
    </div>
  </PosDialog>;
}
