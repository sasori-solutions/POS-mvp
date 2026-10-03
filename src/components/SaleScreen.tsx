import VatSummary from "./VatSummary";
import { productVat } from "../lib/vat";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Minus,
  Plus,
  MoreHorizontal,
  ShoppingBag,
  Star,
  Trash2,
} from "lucide-react";
import { AccountClientError } from "../lib/account";
import type { PaymentMethod } from "../lib/contracts";
import type { OperationalOrder } from "../lib/operations-contracts";
import { checkoutTotals } from "../lib/checkout-selection";
import type {
  CartLine,
  ItemSelection,
  PosCommand,
  Product,
  Sale,
} from "../lib/pos-contracts";
import {
  cartTotal,
  filterProducts,
  maxQuantity,
  maxSaleLines,
  money,
  posRequest,
  type PosAccess,
} from "../lib/pos";
import {
  clearPendingSale,
  pendingSaleKey,
  readPendingSale,
  writePendingSale,
  type PendingSale,
} from "../lib/pending-sale";
import {
  productDetails,
  isSoldOut,
  lineKey,
  selectedPrice,
  selectionLabel,
} from "../lib/product-details";
import ProductSelection from "./ProductSelection";
import SaleAccountPanel from "./SaleAccountPanel";
import CheckoutPanel from "./CheckoutPanel";
import PaymentMethodPicker from "./PaymentMethodPicker";
import {
  CatalogFilters,
  EmptyCatalog,
  SaleDetail,
  PosDialog,
} from "./PosShared";
import { accessErrorCodes, type CatalogState } from "./useCatalog";

function saleCommand(
  cart: CartLine[],
  paymentMethod: PaymentMethod,
  totalCents: number,
  operationId: string,
): PendingSale {
  return {
    command: "complete_sale",
    operationId,
    paymentMethod,
    totalCents,
    items: cart.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      unitPriceCents: selectedPrice(line.product, line.selection),
      version: line.product.version,
      ...(line.selection ? { selection: line.selection } : {}),
    })),
  };
}

export default function SaleScreen({
  access,
  employeeId,
  catalog,
  onProducts,
  onHistory,
  onSessionError,
  canAvailability = true,
  canFavorite = false,
  onAccount,
  collectionReady = true,
  collectionAllowed = true,
  activationRequired = false,
  savedCounter,
  onAccountAdd,
  onAccountQuantity,
  onAccountClear,
}: {
  access: PosAccess;
  employeeId: string;
  catalog: CatalogState;
  onProducts: () => void;
  onHistory: () => void;
  onSessionError?: (error: AccountClientError) => void;
  canAvailability?: boolean;
  canFavorite?: boolean;
  onAccount?: (cart: CartLine[]) => Promise<void>;
  collectionReady?: boolean;
  collectionAllowed?: boolean;
  activationRequired?: boolean;
  savedCounter?: OperationalOrder;
  onAccountAdd?: (product: Product, selection?: ItemSelection) => Promise<void>;
  onAccountQuantity?: (lineId: string, change: number | 'remove') => Promise<void>;
  onAccountClear?: () => Promise<void>;
}) {
  const [choosing, setChoosing] = useState<Product | null>(null);
  const [availability, setAvailability] = useState<Product | null>(null);
  const [favorites, setFavorites] = useState(false);
  const availabilityRequest = useRef<{
    product: Product;
    soldOut: boolean;
    operationId: string;
  } | null>(null);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");
  const favoriteRequests = useRef(
    new Map<string, Extract<PosCommand, { command: "save_product" }>>(),
  );
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [showCart, setShowCart] = useState(false);
  const cartButton = useRef<HTMLButtonElement>(null);
  const [checkout, setCheckout] = useState(false);
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [pending, setPending] = useState<PendingSale | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [confirmClearAccount, setConfirmClearAccount] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const pendingRef = useRef<PendingSale | null>(null);
  const completedOperation = useRef<string | null>(null);
  const storageKey = pendingSaleKey(access.businessId, employeeId);
  const activeProducts = catalog.products.filter((product) => product.active);
  const filtered = filterProducts(
    activeProducts.filter((p) => !favorites || p.details?.favorite),
    query,
    category,
  );
  const account = savedCounter?.status === 'open' ? savedCounter : undefined;
  const remainingAccountLines = account?.items.filter(line => line.quantity > line.paidQuantity) ?? [];
  const remainingAccountTotals = account ? remainingAccountLines.map(line => ({ ...line, ...checkoutTotals(account, [{ lineId: line.lineId, quantity: line.quantity - line.paidQuantity }]) })) : [];
  const accountEditable = Boolean(account && account.phase === 'service' && !account.frozen && onAccountAdd && onAccountQuantity);
  const frozen = busy || Boolean(pending) || storageError || Boolean(account && (!accountEditable || !collectionReady));
  useEffect(() => {
    if (savedCounter && savedCounter.status !== 'open') {
      setCart([]);
      setCheckout(false);
      setShowCart(false);
      setConfirmClearAccount(false);
      setNotice("");
    }
  }, [savedCounter?.id, savedCounter?.status]);

  async function clearStoredOperation(operationId: string) {
    if (navigator.locks)
      await navigator.locks.request(storageKey, () =>
        clearPendingSale(storageKey, operationId),
      );
    else clearPendingSale(storageKey, operationId);
  }

  function restorePending() {
    try {
      const command = readPendingSale(storageKey);
      pendingRef.current = command;
      setPending(command);
      setStorageError(false);
      setError("");
      if (command) {
        setCheckout(true);
        setShowCart(true);
        setPayment(command.paymentMethod);
        setNotice(
          "Hay una venta por confirmar. Reintenta el registro sin volver a cobrar.",
        );
      }
    } catch (caught) {
      setStorageError(true);
      setError(
        caught instanceof Error
          ? caught.message
          : "No pudimos leer el registro pendiente de este dispositivo.",
      );
    }
  }

  useEffect(() => {
    mounted.current = true;
    restorePending();
    const connected = () => setOnline(navigator.onLine);
    const stored = (event: StorageEvent) => {
      if (event.key === storageKey && event.newValue && !submitting.current)
        restorePending();
    };
    window.addEventListener("online", connected);
    window.addEventListener("offline", connected);
    window.addEventListener("storage", stored);
    return () => {
      mounted.current = false;
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", connected);
      window.removeEventListener("storage", stored);
    };
  }, [storageKey]);

  useEffect(() => {
    if (
      !pending &&
      !checkout &&
      catalog.paymentMethods.length &&
      !catalog.paymentMethods.includes(payment)
    )
      setPayment(catalog.paymentMethods[0]);
  }, [catalog.paymentMethods, payment, pending, checkout]);

  const displayCart: CartLine[] = pending
    ? pending.items.map((item) => ({
        product: {
          id: item.productId,
          name:
            catalog.products.find((product) => product.id === item.productId)
              ?.name ?? "Producto de la venta pendiente",
          category: "",
          active: true,
          priceCents: item.unitPriceCents,
          version: item.version,
        },
        quantity: item.quantity,
        selection: item.selection,
      }))
    : account
      ? remainingAccountLines.map((line) => ({
          product: { id: line.productId, name: line.name, category: line.category,
            active: true, priceCents: line.unitPriceCents, version: line.version },
          quantity: line.quantity - line.paidQuantity,
        }))
      : cart;
  let total = pending?.totalCents ?? account?.balanceCents ?? 0;
  let totalError = "";
  if (!pending && !account) {
    try {
      total = cartTotal(cart);
    } catch (caught) {
      totalError =
        caught instanceof Error ? caught.message : "Revisa la venta.";
    }
  }
  if (
    !pending &&
    !account &&
    !totalError &&
    new TextEncoder().encode(
      JSON.stringify(
        saleCommand(
          cart,
          "card_external",
          total,
          "00000000-0000-4000-8000-000000000000",
        ),
      ),
    ).length > 6800
  )
    totalError =
      "La cuenta tiene demasiadas opciones. Divídela en dos ventas antes de cobrar.";
  const outdated =
    !pending &&
    !account &&
    catalog.loaded &&
    cart.some((line) => {
      const current = catalog.products.find(
        (product) => product.id === line.product.id,
      );
      return (
        !current?.active ||
        isSoldOut(current) ||
        current.version !== line.product.version
      );
    });
  const canCheckout =
    !activationRequired &&
    collectionAllowed &&
    collectionReady &&
    cart.length > 0 &&
    !outdated &&
    !totalError &&
    catalog.loaded &&
    !catalog.error &&
    online &&
    !frozen;
  const canResumeAccount = Boolean(account?.items.length && onAccount) && collectionAllowed && collectionReady && online && !busy && !pending && !storageError;

  function add(product: Product, selection?: ItemSelection) {
    if (frozen || checkout || isSoldOut(product)) return;
    if (account && onAccountAdd) {
      void editAccount(() => onAccountAdd(product, selection));
      return;
    }
    const key = lineKey({ product, selection });
    const existing = cart.find((line) => lineKey(line) === key);
    if (existing && existing.quantity >= maxQuantity) {
      setError(`Máximo ${maxQuantity} unidades por producto.`);
      return;
    }
    if (!existing && cart.length >= maxSaleLines) {
      setError(`Máximo ${maxSaleLines} productos distintos por venta.`);
      return;
    }
    const next = existing
      ? cart.map((line) =>
          lineKey(line) === key
            ? { ...line, quantity: line.quantity + 1 }
            : line,
        )
      : [...cart, { product, quantity: 1, selection }];
    try {
      cartTotal(next);
    } catch (caught) {
      setError((caught as Error).message);
      return;
    }
    setCart(next);
    setError("");
    setNotice("");
  }
  function quantity(key: string, change: number) {
    if (frozen) return;
    if (account && onAccountQuantity) {
      void editAccount(() => onAccountQuantity(key, change));
      return;
    }
    const next = cart
      .map((line) =>
        lineKey(line) === key
          ? { ...line, quantity: line.quantity + change }
          : line,
      )
      .filter((line) => line.quantity > 0);
    try {
      cartTotal(next);
    } catch (caught) {
      setError((caught as Error).message);
      return;
    }
    setCart(next);
    setError("");
  }
  useEffect(() => {
    if (account || pending || busy || !catalog.loaded || catalog.error) return;
    const changed = cart.some((line) => {
      const current = catalog.products.find((p) => p.id === line.product.id);
      return (
        !current ||
        current.version !== line.product.version ||
        isSoldOut(current)
      );
    });
    if (!changed) return;
    setCart((previous) =>
      previous.flatMap((line) => {
        const product = catalog.products.find(
          (p) => p.id === line.product.id && p.active && !isSoldOut(p),
        );
        if (!product) return [];
        const d = productDetails(product),
          selection = line.selection;
        if (
          d.variations.length &&
          !d.variations.some(
            (v) => v.id === selection?.variationId && !v.soldOut,
          )
        )
          return [];
        if (
          selection?.variationId &&
          !d.variations.some((v) => v.id === selection.variationId)
        )
          return [];
        if (d.variablePrice && selection?.variablePriceCents == null) return [];
        if (!d.variablePrice && selection?.variablePriceCents != null)
          return [];
        if (
          selection?.modifierIds.some(
            (id) =>
              !d.modifierSets.some((s) => s.options.some((o) => o.id === id)),
          )
        )
          return [];
        if (
          d.modifierSets.some((s) => {
            const n = s.options.filter((o) =>
              selection?.modifierIds.includes(o.id),
            ).length;
            return n < s.min || n > s.max;
          })
        )
          return [];
        return [{ ...line, product }];
      }),
    );
    setCheckout(false);
    setNotice((previous) =>
      previous.includes("La venta no se registró")
        ? previous
        : "El catálogo cambió. Revisamos precios y disponibilidad. Comprueba la cuenta antes de cobrar.",
    );
  }, [catalog.products, catalog.loaded, catalog.error, cart, account, pending, busy]);

  async function toggleAvailability(product: Product) {
    if (availabilityBusy || !canAvailability) return;
    const command = availabilityRequest.current ?? {
      product,
      soldOut: !productDetails(product).soldOut,
      operationId: crypto.randomUUID(),
    };
    availabilityRequest.current = command;
    setAvailabilityBusy(true);
    setAvailabilityError("");
    try {
      const saved = await posRequest(access, {
        command: "set_product_sold_out",
        operationId: command.operationId,
        productId: command.product.id,
        expectedVersion: command.product.version,
        soldOut: command.soldOut,
      });
      if (!mounted.current) return;
      catalog.upsert(saved);
      setAvailability(null);
      availabilityRequest.current = null;
      setNotice(
        command.soldOut
          ? `${saved.name} marcado como agotado.`
          : isSoldOut(saved)
            ? `${saved.name} sigue agotado. Revisa sus variantes en Productos.`
            : `${saved.name} disponible de nuevo.`,
      );
    } catch (caught) {
      if (!mounted.current) return;
      setAvailabilityError(
        caught instanceof Error
          ? caught.message
          : "No pudimos cambiar la disponibilidad.",
      );
      if (caught instanceof AccountClientError) {
        if (!["NETWORK_ERROR", "SERVER_ERROR"].includes(caught.code))
          availabilityRequest.current = null;
        if (caught.code === "PRODUCT_CHANGED") {
          setAvailability(null);
          void catalog.refresh();
          setError(
            "El producto cambió. Revisa su disponibilidad e intenta de nuevo.",
          );
        }
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
      }
    } finally {
      if (mounted.current) setAvailabilityBusy(false);
    }
  }

  async function toggleFavorite(product: Product) {
    if (availabilityBusy || favoriteBusy || !canFavorite) return;
    const currentDetails = productDetails(product);
    const command = favoriteRequests.current.get(product.id) ?? {
      command: "save_product" as const,
      operationId: crypto.randomUUID(),
      productId: product.id,
      expectedVersion: product.version,
      name: product.name,
      category: product.category,
      priceCents: product.priceCents,
      details: { ...currentDetails, favorite: !currentDetails.favorite },
    };
    favoriteRequests.current.set(product.id, command);
    setFavoriteBusy(true);
    setFavoriteError("");
    try {
      const saved = await posRequest(access, command);
      if (!mounted.current) return;
      catalog.upsert(saved);
      setAvailability(saved);
      favoriteRequests.current.delete(product.id);
      setNotice(
        command.details?.favorite
          ? `${saved.name} añadido a favoritos.`
          : `${saved.name} quitado de favoritos.`,
      );
    } catch (caught) {
      if (!mounted.current) return;
      setFavoriteError(
        caught instanceof Error
          ? caught.message
          : "No pudimos actualizar los favoritos.",
      );
      if (caught instanceof AccountClientError) {
        if (!["NETWORK_ERROR", "SERVER_ERROR"].includes(caught.code))
          favoriteRequests.current.delete(product.id);
        if (caught.code === "PRODUCT_CHANGED") {
          setAvailability(null);
          void catalog.refresh();
          setError("El producto cambió. Revisa sus detalles e intenta de nuevo.");
        }
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
      }
    } finally {
      if (mounted.current) setFavoriteBusy(false);
    }
  }

  async function register() {
    if (submitting.current || storageError || !online) return;
    let command = pendingRef.current;
    if (!command && (!collectionAllowed || !canCheckout || !catalog.paymentMethods.includes(payment)))
      return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!command) {
        if (!navigator.locks) {
          setError(
            "Este navegador no puede proteger el registro entre pestañas. Abre el POS en un navegador actualizado.",
          );
          return;
        }
        let alreadyPending = false;
        try {
          command = await navigator.locks.request(storageKey, () => {
            const stored = readPendingSale(storageKey);
            if (stored) {
              alreadyPending = true;
              return stored;
            }
            const next = saleCommand(cart, payment, total, crypto.randomUUID());
            writePendingSale(storageKey, next);
            return next;
          });
        } catch (caught) {
          setError(
            caught instanceof Error && caught.message.includes("pendiente")
              ? caught.message
              : "No pudimos conservar el registro en este dispositivo. Revisa el almacenamiento y reintenta el registro sin volver a cobrar.",
          );
          return;
        }
        if (!mounted.current) return;
        pendingRef.current = command;
        setPending(command);
        setPayment(command.paymentMethod);
        if (alreadyPending) {
          setNotice(
            "Hay una venta por confirmar en otra pestaña. Reintenta ese registro sin volver a cobrar.",
          );
          setCheckout(true);
          setShowCart(true);
          return;
        }
      }
      const sale = await posRequest(access, command);
      if (!mounted.current) return;
      completedOperation.current = command.operationId;
      setReceipt(sale);
      setCart([]);
      void catalog.refresh();
      setCheckout(false);
      setShowCart(false);
      try {
        await clearStoredOperation(command.operationId);
        pendingRef.current = null;
        setPending(null);
      } catch {
        setStorageError(true);
        setError(
          "La venta está registrada. No pudimos limpiar el reintento local. Reintenta la limpieza antes de iniciar otra venta.",
        );
      }
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "No pudimos confirmar el registro.",
      );
      if (
        caught instanceof AccountClientError &&
        [
          "PRODUCT_CHANGED",
          "PRODUCT_UNAVAILABLE",
          "PAYMENT_METHOD_DISABLED",
          "VALIDATION_ERROR",
        ].includes(caught.code)
      ) {
        // The server definitively refused the transaction; review the draft with current catalog.
        try {
          if (command) await clearStoredOperation(command.operationId);
          pendingRef.current = null;
          setPending(null);
        } catch {
          setStorageError(true);
        }
        if (command)
          setCart(
            command.items.map((item) => ({
              product: {
                id: item.productId,
                name:
                  catalog.products.find(
                    (product) => product.id === item.productId,
                  )?.name ?? "Producto de la venta pendiente",
                category: "",
                active: true,
                priceCents: item.unitPriceCents,
                version: item.version,
              },
              quantity: item.quantity,
              selection: item.selection,
            })),
          );
        setCheckout(false);
        setNotice(
          "La venta no se registró. Revisa los productos, el cobro recibido y el total antes de continuar.",
        );
        void catalog.refresh();
      } else {
        setNotice(
          "El resultado aún no está confirmado. Reintenta este registro sin volver a cobrar.",
        );
        if (
          caught instanceof AccountClientError &&
          accessErrorCodes.includes(caught.code)
        )
          onSessionError?.(caught);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function saveAccount() {
    if (!onAccount || !(canCheckout || canResumeAccount) || submitting.current) return;
    setConfirmClearAccount(false);
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onAccount(cart);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : "No pudimos guardar la cuenta.");
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function editAccount(action: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "No pudimos actualizar la cuenta."); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  function clearAccount() {
    if (frozen || !displayCart.length) return;
    if (account) {
      if (!onAccountClear || !accountEditable) return;
      void editAccount(async () => {
        await onAccountClear();
        setConfirmClearAccount(false);
      });
    } else {
      setCart([]);
      setNotice("");
      setError("");
      setConfirmClearAccount(false);
    }
  }

  if (receipt)
    return (
      <div className="sale-result mx-auto my-8 flex w-full max-w-140 flex-col gap-4 [&_h2]:text-[28px] max-tablet:mt-6">
        <div className="sale-success-mark mb-2 grid size-14 place-items-center rounded-full bg-success-soft text-success">
          <Check size={28} aria-hidden="true" />
        </div>
        <h2>Venta registrada</h2>
        <SaleDetail sale={receipt} />
        {error && (
          <p
            className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
            role="alert"
          >
            {error}
          </p>
        )}
        {storageError ? (
          <button
            className="pos-button pos-primary"
            onClick={() => {
              void (async () => {
                try {
                  if (completedOperation.current)
                    await clearStoredOperation(completedOperation.current);
                  pendingRef.current = null;
                  setPending(null);
                  setStorageError(false);
                  setError("");
                } catch {
                  setError(
                    "No pudimos limpiar el reintento. Conserva este dispositivo y pide ayuda.",
                  );
                }
              })();
            }}
          >
            Reintentar limpieza
          </button>
        ) : (
          <button
            className="pos-button pos-primary"
            onClick={() => {
              setReceipt(null);
              setError("");
              setNotice("");
              setQuery("");
              setCategory("");
              restorePending();
            }}
          >
            Nueva venta
          </button>
        )}
        <button className="pos-button pos-secondary" onClick={onHistory}>
          Ver ventas
        </button>
      </div>
    );

  return (
    <div
      data-cart={showCart}
      className={`sale-workspace group/sale mt-2 grid grid-cols-[minmax(0,1fr)_360px] items-start gap-8 max-desktop:grid-cols-[minmax(0,1fr)_320px] max-desktop:gap-6 max-tablet:mt-0 max-tablet:block ${showCart ? "show-cart" : ""}`}
    >
      <div className="sale-catalog min-w-0 max-tablet:pb-20">
        <div
          className="sale-library-tabs flex gap-6 border-b border-line [&_button]:flex [&_button]:min-h-13 [&_button]:items-center [&_button]:gap-2 [&_button]:border-0 [&_button]:border-b-3 [&_button]:border-transparent [&_button]:bg-transparent [&_button]:py-2 [&_button]:text-[15px] [&_button]:text-muted [&_button[aria-pressed=true]]:border-brand [&_button[aria-pressed=true]]:font-medium [&_button[aria-pressed=true]]:text-ink max-tablet:gap-5 max-tablet:[&_button]:text-sm"
          role="group"
          aria-label="Vista del catálogo"
        >
          <button aria-pressed={!favorites} onClick={() => setFavorites(false)}>
            Todos los productos
          </button>
          <button aria-pressed={favorites} onClick={() => setFavorites(true)}>
            <Star size={17} aria-hidden="true" />
            Favoritos
          </button>
        </div>
        <CatalogFilters
          products={activeProducts}
          query={query}
          category={category}
          onQuery={setQuery}
          onCategory={setCategory}
        />
        {!online && (
          <p
            className="pos-warning my-4 rounded-lg border border-line border-l-3 border-l-warning bg-warning-soft p-4 text-sm text-warning [&_p]:text-inherit [&_button]:mt-3"
            role="status"
          >
            Sin conexión. Conéctate para registrar la venta.
          </p>
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
        {catalog.loaded && !activeProducts.length ? (
          <EmptyCatalog description="Agrega productos activos para empezar a vender.">
            <button
              className="pos-button pos-secondary compact"
              onClick={onProducts}
            >
              Ver productos
            </button>
          </EmptyCatalog>
        ) : catalog.loaded && !filtered.length ? (
          <EmptyCatalog
            title="No encontramos productos"
            description="Prueba otro nombre o categoría."
          />
        ) : (
          <div className="touch-catalog grid grid-cols-4 gap-4 max-desktop:grid-cols-3 max-[60rem]:grid-cols-2 max-tablet:gap-3 max-tablet:pb-19">
            {filtered.map((product) => {
              const amount = displayCart
                .filter((line) => line.product.id === product.id)
                .reduce((sum, line) => sum + line.quantity, 0);
              const d = productDetails(product),
                soldOut = isSoldOut(product);
              const prices = d.variations
                .filter((v) => !v.soldOut)
                .map((v) => v.priceCents);
              const shownPrice = prices.length
                ? Math.min(...prices)
                : product.priceCents;
              return (
                <div
                  data-sold-out={soldOut}
                  className={`touch-product-wrap group/product relative min-w-0 ${soldOut ? "sold-out-tile" : ""}`}
                  key={product.id}
                >
                  <button
                    className="touch-product relative flex h-full w-full flex-col overflow-hidden rounded-lg border border-line bg-white p-0 text-left [overflow-wrap:anywhere] enabled:hover:border-brand enabled:active:bg-surface group-data-[sold-out=true]/product:opacity-100 [&_strong]:text-base [&_strong]:leading-snug [&_strong]:font-medium [&_b]:text-sm [&_b]:font-medium [&_b]:text-muted [&_b]:tabular-nums max-tablet:[&_strong]:text-[15px]"
                    onClick={() =>
                      d.variations.length ||
                      d.modifierSets.length ||
                      d.allergens ||
                      d.variablePrice
                        ? setChoosing(product)
                        : add(product)
                    }
                    disabled={frozen || checkout || soldOut}
                    aria-label={`Agregar ${product.name}, ${money(shownPrice)}`}
                  >
                    <span
                      className="tile-visual grid aspect-[1.15] w-full place-items-center overflow-hidden group-data-[sold-out=true]/product:opacity-55 group-data-[sold-out=true]/product:grayscale [&_img]:size-full [&_img]:object-cover"
                      style={{ backgroundColor: d.tileColor }}
                    >
                      {product.image ? (
                        <img
                          width={240}
                          height={240}
                          src={product.image}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <span className="tile-monogram text-[32px] leading-none font-medium text-ink max-tablet:text-[28px]">
                          {d.tileLabel ||
                            product.name.slice(0, 2).toLocaleUpperCase("es-MX")}
                        </span>
                      )}
                    </span>
                    <span className="tile-copy flex w-full flex-1 flex-col items-start gap-1.5 px-3 py-3.5 text-ink max-tablet:p-3">
                      <strong>{product.name}</strong>
                      <b>
                        {d.variablePrice
                          ? "Precio variable"
                          : `${prices.length ? "Desde " : ""}${money(shownPrice)}`}
                      </b>
                      {soldOut ? (
                        <small className="tile-stock text-xs text-muted group-data-[sold-out=true]/product:font-semibold group-data-[sold-out=true]/product:text-ink">
                          Agotado
                        </small>
                      ) : null}
                    </span>
                    {amount > 0 && (
                      <span
                        className="touch-product-quantity absolute top-2 left-2 z-10 grid h-6.5 min-w-6.5 place-items-center rounded-full bg-brand px-1 text-xs font-medium text-white"
                        aria-hidden="true"
                      >
                        {amount}
                      </span>
                    )}
                  </button>
                  {canAvailability && <button
                    className="tile-menu absolute! top-1 right-1 size-12! min-h-12! rounded-lg! bg-white/95! enabled:hover:bg-white! pos-icon-button"
                    aria-label={`Disponibilidad de ${product.name}`}
                    disabled={frozen || checkout || availabilityBusy}
                    onClick={() => {
                      setAvailability(product);
                      setAvailabilityError("");
                    }}
                  >
                    <MoreHorizontal size={20} aria-hidden="true" />
                  </button>}
                </div>
              );
            })}
          </div>
        )}
        <div className="mobile-cart-action fixed bottom-[calc(76px+env(safe-area-inset-bottom))] left-1/2 z-30 w-full -translate-x-1/2 border-t border-line bg-white px-4 py-3 tablet:hidden">
          <button
            ref={cartButton}
            className="pos-button pos-primary"
            aria-expanded={showCart}
            aria-controls="current-sale-account"
            onClick={() => setShowCart(true)}
            disabled={!displayCart.length && !storageError}
          >
            {displayCart.length
              ? `Ver cuenta (${displayCart.reduce((sum, line) => sum + line.quantity, 0)}) ${money(total)}`
              : "Ver cuenta"}
          </button>
        </div>
      </div>
      <SaleAccountPanel open={showCart} canClose returnFocus={cartButton} onClose={() => { setShowCart(false); if (!pending) setCheckout(false); }}>
        <div data-account-drag className="mx-auto mb-1 h-1.5 w-14 shrink-0 touch-pan-x rounded-full bg-line tablet:hidden" aria-hidden="true" />
        <div className="current-sale-heading mb-1 flex min-h-12 shrink-0 items-center justify-between gap-3 [&_h2]:font-medium [&_span]:text-[13px] [&_span]:text-muted">
          <h2 className="sr-only" data-account-focus tabIndex={-1}>{checkout ? "Registrar pago" : "Venta actual"}</h2>
          {displayCart.length > 0 && (!account || accountEditable && onAccountClear) && (
            <button type="button" className="min-h-12 p-0 text-left text-sm font-normal text-black no-underline disabled:opacity-100" disabled={frozen} onClick={() => setConfirmClearAccount(true)}>Borrar cuenta</button>
          )}
          <span>
            {displayCart.reduce((sum, line) => sum + line.quantity, 0)}{" "}
            artículos
          </span>
        </div>
        <div className="current-sale-body min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] [@media(min-width:47.5rem)_and_(max-height:759px)]:max-h-75 max-tablet:flex-auto max-tablet:max-h-[20dvh] max-tablet:p-0 max-tablet:[scrollbar-gutter:auto]">
          {notice && (
            <p className="pos-status my-4 text-sm text-muted" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p
              className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
              role="alert"
            >
              {error}
            </p>
          )}
          {storageError && (
            <button
              className="pos-button pos-secondary"
              onClick={restorePending}
            >
              Revisar registro pendiente
            </button>
          )}
          {!displayCart.length && !storageError && (
            <div className="empty-cart flex min-h-65 flex-col items-center justify-center gap-3 px-4 py-10 text-center [&>svg]:text-muted [&_h3]:mt-2 [&_h3]:text-lg [&_h3]:font-medium">
              <ShoppingBag size={40} strokeWidth={1.2} aria-hidden="true" />
              <h3>Tu cuenta está vacía</h3>
            </div>
          )}
          <ul className="cart-lines m-0 list-none p-0 [&_li]:py-2 [&_li>p]:mt-1 [&_li>p]:text-sm">
            {displayCart.map((line, index) => {
              const { product, quantity: amount, selection } = line,
                savedLine = pending ? undefined : remainingAccountLines[index],
                key = savedLine?.lineId ?? lineKey(line),
                price = savedLine?.unitPriceCents ?? selectedPrice(product, selection),
                label = savedLine?.selectionLabel ?? selectionLabel(product, selection);
              return (
                <li key={key}>
                  <div className="cart-line-heading flex items-baseline justify-between gap-4 [&_strong]:min-w-0 [&_strong]:font-medium [&_strong]:[overflow-wrap:anywhere] [&_span]:whitespace-nowrap [&_span]:tabular-nums">
                    <strong>{amount} × {product.name}</strong>
                    <span>{money((!pending ? remainingAccountTotals[index]?.totalCents : undefined) ?? price * amount)}</span>
                  </div>
                  {label && (
                    <p>{label}</p>
                  )}
                  {!checkout && !pending && (!account || accountEditable) ? (
                    <div className="quantity-controls mt-1 flex items-center gap-0 [&_span]:min-w-6 [&_span]:text-center [&_span]:tabular-nums [&_button]:size-12 [&_button]:min-h-12 [&_button]:rounded-lg [&_button]:border-0! [&_button]:bg-transparent!">
                      <button
                        className="pos-icon-button"
                        aria-label={`Disminuir ${product.name}`}
                        disabled={frozen || Boolean(savedLine && amount <= savedLine.sentQuantity)}
                        onClick={() => quantity(key, -1)}
                      >
                        <Minus size={18} aria-hidden="true" />
                      </button>
                      <span aria-label={`Cantidad de ${product.name}`}>
                        {amount}
                      </span>
                      <button
                        className="pos-icon-button"
                        aria-label={`Aumentar ${product.name}`}
                        disabled={frozen || amount >= maxQuantity}
                        onClick={() => quantity(key, 1)}
                      >
                        <Plus size={18} aria-hidden="true" />
                      </button>
                      <button
                        className="pos-icon-button cart-remove ml-auto border-transparent! bg-transparent!"
                        aria-label={`Quitar ${product.name}`}
                        disabled={frozen || Boolean(savedLine && savedLine.sentQuantity > 0)}
                        onClick={() => {
                          if (savedLine && onAccountQuantity) {
                            void editAccount(() => onAccountQuantity(savedLine.lineId, 'remove'));
                            return;
                          }
                          setCart((previous) =>
                            previous.filter((l) => lineKey(l) !== key),
                          );
                          setError("");
                        }}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <p>Cantidad: {amount}</p>
                  )}
                </li>
              );
            })}
          </ul>
          {outdated && (
            <p
              className="pos-warning my-4 rounded-lg border border-line border-l-3 border-l-warning bg-warning-soft p-4 text-sm text-warning [&_p]:text-inherit [&_button]:mt-3"
              role="status"
            >
              Revisando disponibilidad y precios…
            </p>
          )}
          {totalError && (
            <p
              className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
              role="alert"
            >
              {totalError}
            </p>
          )}
        </div>
        <div className="cart-checkout mt-2 flex shrink-0 flex-col gap-2 border-t border-line bg-white pt-3 [&_.pos-primary]:min-h-15 [&_.pos-primary]:text-lg max-tablet:max-h-[32dvh] max-tablet:overflow-y-auto max-tablet:pt-2">
          <dl className="sale-totals mb-3 flex flex-col gap-2 tablet:gap-4">
            {!pending && displayCart.length > 0 && (
              <VatSummary
                lines={account ? remainingAccountTotals : cart.map((line) => {
                  const d = productDetails(line.product);
                  return {
                    totalCents:
                      selectedPrice(line.product, line.selection) *
                      line.quantity,
                    taxBps: d.taxBps,
                    taxTreatment: productVat(d),
                  };
                })}
              />
            )}
            <div className="sale-total">
              <dt>{account && account.paidCents > 0 ? 'Por cobrar MXN' : 'Total MXN'}</dt>
              <dd>{money(total)}</dd>
            </div>
            {account && account.paidCents > 0 && (
              <div><dt>Pagado</dt><dd>{money(account.paidCents)}</dd></div>
            )}
          </dl>
          {account ? (
            <>
              <button className="pos-button pos-primary" disabled={!canResumeAccount} onClick={() => void saveAccount()}>
                Cobrar
              </button>
            </>
          ) : (
            <button
              className="pos-button pos-primary"
              disabled={!canCheckout}
              onClick={() => {
                if (onAccount) { void saveAccount(); return; }
                setCheckout(true);
                setShowCart(true);
                setNotice("");
                setError("");
              }}
            >
              Cobrar
            </button>
          )}
        </div>
      </SaleAccountPanel>
      {(checkout || pending) && <CheckoutPanel busy={busy || Boolean(pending)} onClose={() => setCheckout(false)}>
        <div className="checkout-layout">
          <aside className="checkout-summary">
            <div className="checkout-amount"><p>Total a cobrar · MXN</p><strong>{money(total)}</strong></div>
            <h3 className="checkout-section-title">Resumen de la venta</h3>
            <ul className="checkout-items">{displayCart.map((line, index) => <li key={index}>
              <span><strong>{line.quantity} × {line.product.name}</strong>{selectionLabel(line.product, line.selection) && <small>{selectionLabel(line.product, line.selection)}</small>}</span>
              <span>{money(selectedPrice(line.product, line.selection) * line.quantity)}</span>
            </li>)}</ul>
            {!pending && <dl className="sale-totals"><VatSummary lines={cart.map(line => {
              const details = productDetails(line.product);
              return { totalCents: selectedPrice(line.product, line.selection) * line.quantity, taxBps: details.taxBps, taxTreatment: productVat(details) };
            })} /></dl>}
          </aside>
          <div className="checkout-controls">
            {!online && <p role="alert">Sin conexión. Vuelve a conectarte para registrar el pago.</p>}
            {notice && <p role="status">{notice}</p>}
            {error && <p className="checkout-error" role="alert">{error}</p>}

              <PaymentMethodPicker name="sale-payment" methods={pending ? [pending.paymentMethod] : catalog.paymentMethods}
                value={payment} onChange={setPayment} disabled={frozen} />
              {payment === "card_external" ? (
                <p className="payment-instructions py-2 text-sm">
                  Cobra en tu terminal y registra el pago.
                </p>
              ) : payment === "transfer" ? (
                <p className="payment-instructions py-2 text-sm">
                  Verifica que recibiste la transferencia antes de registrar el
                  pago.
                </p>
              ) : (
                <p className="payment-instructions py-2 text-sm">
                  Recibe el efectivo antes de confirmar la venta.
                </p>
              )}
              <button
                className="pos-button pos-primary checkout-confirm"
                disabled={
                  busy ||
                  storageError ||
                  !online ||
                  (!pending &&
                    (!canCheckout || !catalog.paymentMethods.includes(payment)))
                }
                aria-busy={busy}
                onClick={() => void register()}
              >
                {busy
                  ? "Registrando…"
                  : pending
                    ? "Reintentar registro"
                    : payment === "cash"
                      ? "Confirmar venta"
                      : "Registrar pago"}
              </button>
          </div>
        </div>
      </CheckoutPanel>}

      {confirmClearAccount && displayCart.length > 0 && (!account || accountEditable && onAccountClear) && (
        <PosDialog title="Borrar cuenta" onClose={() => setConfirmClearAccount(false)} busy={busy}>
          <p className="text-ink">¿Eliminar todos los artículos de esta cuenta?</p>
          <p className="mt-2 text-sm">Se eliminarán {displayCart.reduce((sum, line) => sum + line.quantity, 0)} artículos. Esta acción no se puede deshacer.</p>
          {error && <p className="mt-4 text-sm text-danger" role="alert">{error}</p>}
          <div className="mt-6 flex gap-3 max-tablet:flex-col">
            <button className="pos-button pos-secondary" disabled={busy} onClick={() => setConfirmClearAccount(false)} data-dialog-autofocus>Cancelar</button>
            <button className="pos-button border-ink bg-ink text-white enabled:hover:border-ink-hover enabled:hover:bg-ink-hover" disabled={frozen} onClick={clearAccount}>Borrar cuenta</button>
          </div>
        </PosDialog>
      )}

      {choosing && (
        <ProductSelection
          product={choosing}
          onClose={() => setChoosing(null)}
          onAdd={(selection) => add(choosing, selection)}
        />
      )}
      {availability && (
        <PosDialog
          title={availability.name}
          onClose={() => {
            setAvailability(null);
            availabilityRequest.current = null;
          }}
          busy={availabilityBusy || favoriteBusy}
        >
          {productDetails(availability).variations.length > 0 &&
            productDetails(availability).variations.every((v) => v.soldOut) && (
              <p className="pos-warning my-4 rounded-lg border border-line border-l-3 border-l-warning bg-warning-soft p-4 text-sm text-warning [&_p]:text-inherit [&_button]:mt-3">
                Sus variantes están agotadas. Revisa su disponibilidad en
                Productos.
              </p>
            )}
          {availabilityError && (
            <p
              className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
              role="alert"
            >
              {availabilityError}
            </p>
          )}
          {favoriteError && (
            <p
              className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
              role="alert"
            >
              {favoriteError}
            </p>
          )}
          <div className="dialog-actions mt-6 flex flex-col gap-3">
            {canFavorite && (
              <button
                className="pos-button pos-secondary"
                type="button"
                aria-pressed={productDetails(availability).favorite}
                disabled={availabilityBusy || favoriteBusy}
                onClick={() => void toggleFavorite(availability)}
              >
                <Star
                  aria-hidden="true"
                  size={18}
                  fill={productDetails(availability).favorite ? "currentColor" : "none"}
                />
                {favoriteBusy
                  ? "Guardando…"
                  : productDetails(availability).favorite
                    ? "Quitar de favoritos"
                    : "Añadir a favoritos"}
              </button>
            )}
            <button
              className="pos-button pos-primary"
              disabled={availabilityBusy || favoriteBusy}
              onClick={() => void toggleAvailability(availability)}
            >
              {availabilityBusy
                ? "Guardando…"
                : productDetails(availability).soldOut
                  ? "Marcar disponible"
                  : "Marcar agotado"}
            </button>
          </div>
        </PosDialog>
      )}
      <div
        className="catalog-announcement sr-only tablet:hidden"
        role="status"
        aria-live="polite"
      >
        {!showCart && !checkout ? notice : ""}
        {!showCart && !checkout && error ? ` ${error}` : ""}
      </div>
    </div>
  );
}
