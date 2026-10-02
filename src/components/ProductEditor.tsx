import { useEffect, useRef, useState } from "react";
import { ImagePlus, Plus, Trash2 } from "lucide-react";
import { AccountClientError } from "../lib/account";
import type { PosCommand, Product, ProductDetails } from "../lib/pos-contracts";
import { emptyDetails, productDetails } from "../lib/product-details";
import { parsePrice, posRequest, priceInput, type PosAccess } from "../lib/pos";
import { PosDialog } from "./PosShared";
import MoneyInput from "./MoneyInput";
import ProductVatFields from "./ProductVatFields";
import { productVat, vatRates } from "../lib/vat";
import { accessErrorCodes } from "./useCatalog";

const sections = [
  ["identity", "Información"],
  ["pricing", "Precio e IVA"],
  ["variations", "Tamaños"],
  ["modifiers", "Extras"],
  ["inventory", "Disponibilidad"],
] as const;

export default function ProductEditor({
  product,
  products,
  access,
  onClose,
  onSaved,
  onRefresh,
  onSessionError,
}: {
  product: Product | null;
  products: Product[];
  access: PosAccess;
  onClose: () => void;
  onSaved: (product: Product) => void;
  onRefresh: () => void;
  onSessionError?: (error: AccountClientError) => void;
}) {
  const [name, setName] = useState(product?.name ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [price, setPrice] = useState(
    product && !productDetails(product).variablePrice
      ? priceInput(product.priceCents)
      : "",
  );
  const [details, setDetails] = useState<ProductDetails>(
    product
      ? {
          ...productDetails(product),
          variablePrice: false,
          taxTreatment: productVat(productDetails(product)),
        }
      : { ...emptyDetails(), taxBps: 1600, taxTreatment: "vat_16" },
  );
  const [image, setImage] = useState(product?.image ?? "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const productId = useRef(product?.id ?? crypto.randomUUID());
  const request = useRef<Extract<
    PosCommand,
    { command: "save_product" }
  > | null>(null);
  const imageUpload = useRef<{
    id: string;
    data: string;
    operations: string[];
    uploaded: boolean;
  } | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const locked = busy || uncertain || conflict;
  function change<K extends keyof ProductDetails>(
    key: K,
    value: ProductDetails[K],
  ) {
    setDetails((d) => ({ ...d, [key]: value }));
  }

  async function chooseImage(file?: File) {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 8 * 1024 * 1024
      )
        throw new Error("Elige una imagen JPG, PNG o WebP de hasta 8 MB.");
      const bitmap = await createImageBitmap(file);
      const ratio = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * ratio);
      canvas.height = Math.round(bitmap.height * ratio);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#FFFFFF";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      let dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      if (dataUrl.length > 245783)
        dataUrl = canvas.toDataURL("image/jpeg", 0.5);
      if (dataUrl.length > 245783)
        throw new Error(
          "La imagen es demasiado compleja. Elige una foto más pequeña.",
        );
      if (!mounted.current) return;
      const data = dataUrl.split(",")[1],
        id = crypto.randomUUID();
      imageUpload.current = {
        id,
        data,
        operations: Array.from({ length: Math.ceil(data.length / 4096) }, () =>
          crypto.randomUUID(),
        ),
        uploaded: false,
      };
      setImage(dataUrl);
      change("imageId", id);
    } catch (caught) {
      if (mounted.current) setError((caught as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || conflict) return;
    if (!request.current) {
      const priceCents = parsePrice(price);
      if (productVat(details) === "unconfigured") {
        setError("Selecciona el IVA del producto.");
        return;
      }
      if (!name.trim() || priceCents === null) {
        setError("Escribe el nombre y un precio válido.");
        return;
      }
      const nextDetails = {
        ...details,
        description: details.description.replace(/\s+/g, " ").trim(),
      };
      if (details.modifierSets.reduce((sum, set) => sum + set.min, 0) > 24) {
        setError(
          "Los grupos pueden exigir como máximo 24 selecciones en total. Reduce las selecciones mínimas.",
        );
        return;
      }
      request.current = {
        command: "save_product",
        productId: productId.current,
        expectedVersion: product?.version ?? null,
        name: name.trim(),
        category: category.trim(),
        priceCents,
        details: nextDetails,
        operationId: crypto.randomUUID(),
      };
      // Leave room for the signed browser proof and access envelope within the HTTP limit.
      if (
        new TextEncoder().encode(JSON.stringify(request.current)).length > 6800
      ) {
        request.current = null;
        setError(
          "Este producto tiene demasiadas opciones o texto. Reduce el contenido antes de guardar.",
        );
        return;
      }
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const upload = imageUpload.current;
      if (upload && !upload.uploaded) {
        for (let part = 0; part < upload.operations.length; part++) {
          if (!mounted.current) return;
          await posRequest(access, {
            command: "upload_product_image",
            imageId: upload.id,
            part,
            parts: upload.operations.length,
            data: upload.data.slice(part * 4096, (part + 1) * 4096),
            operationId: upload.operations[part],
          });
        }
        upload.uploaded = true;
      }
      if (!mounted.current) return;
      const saved = await posRequest(access, request.current);
      if (mounted.current) onSaved(saved);
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof Error
          ? caught.message
          : "No pudimos guardar el producto.",
      );
      const unknown =
        !(caught instanceof AccountClientError) ||
        ["NETWORK_ERROR", "SERVER_ERROR"].includes(caught.code);
      setUncertain(unknown);
      if (!unknown) request.current = null;
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
      title={product ? "Editar producto" : "Agregar producto"}
      onClose={onClose}
      busy={busy}
      className="product-editor-dialog"
    >
      <form
        onSubmit={(event) => void save(event)}
        className="product-editor-form grid grid-cols-[200px_minmax(0,1fr)] max-[60rem]:grid-cols-1"
      >
        <nav
          className="editor-sections sticky top-22 flex flex-col gap-1 self-start bg-surface px-4 py-7 [&_a]:min-h-12 [&_a]:rounded-lg [&_a]:px-3 [&_a]:py-3.5 [&_a]:text-sm [&_a]:text-muted [&_a]:no-underline [&_a:hover]:bg-brand-soft [&_a:hover]:text-brand-hover max-[60rem]:static max-[60rem]:flex-row max-[60rem]:gap-2 max-[60rem]:overflow-x-auto max-[60rem]:py-2 max-[60rem]:[&_a]:shrink-0 max-[60rem]:[&_a]:whitespace-nowrap max-[60rem]:[&_a]:px-2 max-[60rem]:[&_a]:py-3"
          aria-label="Secciones del producto"
        >
          {sections.map(([id, label]) => (
            <a key={id} href={`#product-${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <fieldset
          disabled={locked}
          className="editor-fields m-0 min-w-0 border-0 px-8 max-[60rem]:px-6 max-tablet:px-4 [&_label]:text-sm"
        >
          <section
            id="product-identity"
            className="editor-section flex scroll-mt-24 flex-col gap-5 border-b border-line py-7 [&_h3]:text-[19px] [&_h3]:font-medium max-tablet:gap-4 max-tablet:py-6"
          >
            <h3>Información</h3>
            <div className="product-identity-layout grid grid-cols-[144px_minmax(0,1fr)] gap-6 max-tablet:grid-cols-[96px_minmax(0,1fr)] max-tablet:gap-4">
              <div className="image-editor flex flex-col items-center gap-2 max-tablet:items-start">
                <div
                  className="product-image-preview grid size-36 place-items-center overflow-hidden rounded-lg border border-line text-muted [&_img]:size-full [&_img]:object-cover max-tablet:size-24"
                  style={{ backgroundColor: details.tileColor }}
                >
                  {image ? (
                    <img
                      width={240}
                      height={240}
                      src={image}
                      alt="Imagen del producto"
                    />
                  ) : (
                    <ImagePlus size={36} strokeWidth={1.5} aria-hidden="true" />
                  )}
                </div>
                <label className="image-upload relative grid min-h-12 w-full cursor-pointer place-items-center font-medium text-brand-hover focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand [&_input]:absolute [&_input]:inset-0 [&_input]:size-full [&_input]:cursor-pointer [&_input]:opacity-0 max-tablet:w-24 max-tablet:text-center">
                  {image ? "Cambiar imagen" : "Añadir imagen"}
                  <input
                    type="file"
                    aria-label="Imagen del producto"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => void chooseImage(e.target.files?.[0])}
                  />
                </label>
                {image && (
                  <button
                    type="button"
                    className="editor-text-button inline-flex min-h-12 items-center gap-2 border-0 bg-transparent py-2 text-left text-sm font-medium text-brand-hover hover:text-brand"
                    onClick={() => {
                      setImage("");
                      imageUpload.current = null;
                      change("imageId", null);
                    }}
                  >
                    Quitar imagen
                  </button>
                )}
              </div>
              <div className="editor-field-stack flex flex-col gap-4">
                <div className="field">
                  <label htmlFor="product-name">Nombre</label>
                  <input
                    id="product-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    required
                    autoFocus
                    data-dialog-autofocus
                    placeholder="Ej. Latte"
                  />
                </div>

                <div className="field">
                  <label htmlFor="product-category">Categoría (opcional)</label>
                  <input
                    id="product-category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    maxLength={60}
                    list="product-categories"
                    placeholder="Ej. Café"
                  />
                  <datalist id="product-categories">
                    {[
                      ...new Set(
                        products.map((p) => p.category).filter(Boolean),
                      ),
                    ].map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </div>
              </div>
            </div>
            <div className="field">
              <label htmlFor="product-description">Descripción</label>
              <textarea
                id="product-description"
                value={details.description}
                onChange={(e) => change("description", e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="Ej. Café con leche"
              />
            </div>
            <div className="field">
              <label htmlFor="product-allergens">Alérgenos (opcional)</label>
              <input
                id="product-allergens"
                value={details.allergens}
                maxLength={200}
                onChange={(e) => change("allergens", e.target.value)}
                placeholder="Ej. Leche, nueces"
              />
            </div>
          </section>
          <section
            id="product-pricing"
            className="editor-section flex scroll-mt-24 flex-col gap-5 border-b border-line py-7 [&_h3]:text-[19px] [&_h3]:font-medium max-tablet:gap-4 max-tablet:py-6"
          >
            <h3>Precio e IVA</h3>
            {product?.details?.variablePrice && (
              <p className="text-sm text-muted">
                Este producto tenía precio abierto. Define un precio final para
                guardar.
              </p>
            )}
            <div className="editor-two-columns grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
              <div className="field">
                <label htmlFor="product-price">Precio final MXN</label>
                <MoneyInput
                  id="product-price"
                  value={price}
                  onValueChange={setPrice}
                  required
                  placeholder="$0.00"
                />
                <p className="product-help text-sm">
                  IVA incluido.
                </p>
              </div>
            </div>

            <ProductVatFields
              treatment={productVat(details)}
              priceCents={parsePrice(price)}
              confirmedBorder={product?.details?.taxTreatment === "border_8"}
              onChange={(value) =>
                setDetails((d) => ({
                  ...d,
                  taxTreatment: value,
                  taxBps: vatRates[value],
                }))
              }
            />
          </section>
          <section
            id="product-variations"
            className="editor-section flex scroll-mt-24 flex-col gap-5 border-b border-line py-7 [&_h3]:text-[19px] [&_h3]:font-medium max-tablet:gap-4 max-tablet:py-6"
          >
            <h3>Tamaños y presentaciones</h3>

            {details.variations.map((v, index) => (
              <div
                className="editor-option-row flex flex-col gap-4 rounded-lg border border-line p-5 max-tablet:p-4"
                key={v.id}
              >
                <div className="editor-two-columns grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
                  <div className="field">
                    <label htmlFor={`variation-${v.id}`}>
                      Variante {index + 1}
                    </label>
                    <input
                      id={`variation-${v.id}`}
                      value={v.name}
                      placeholder="Ej. Chico"
                      maxLength={60}
                      required
                      onChange={(e) =>
                        change(
                          "variations",
                          details.variations.map((item) =>
                            item.id === v.id
                              ? { ...item, name: e.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`variation-price-${v.id}`}>
                      Precio de variante {index + 1}
                    </label>
                    <MoneyInput
                      id={`variation-price-${v.id}`}
                      value={priceInput(v.priceCents)}
                      required
                      onValueChange={(value) =>
                        change(
                          "variations",
                          details.variations.map((item) =>
                            item.id === v.id
                              ? { ...item, priceCents: parsePrice(value) ?? 0 }
                              : item,
                          ),
                        )
                      }
                    />
                  </div>
                </div>

                <div className="editor-row-actions flex items-center justify-between gap-4">
                  <label className="editor-check flex min-h-12 cursor-pointer items-center gap-3 [&_input]:size-5 [&_small]:mt-1 [&_small]:block [&_small]:text-[13px] [&_small]:text-muted">
                    <input
                      type="checkbox"
                      checked={v.soldOut}
                      onChange={(e) =>
                        change(
                          "variations",
                          details.variations.map((item) =>
                            item.id === v.id
                              ? { ...item, soldOut: e.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                    Agotada
                  </label>
                  <button
                    type="button"
                    className="pos-icon-button"
                    aria-label={`Quitar variante ${index + 1}`}
                    onClick={() =>
                      change(
                        "variations",
                        details.variations.filter((item) => item.id !== v.id),
                      )
                    }
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="editor-add inline-flex min-h-12 w-full items-center gap-2 rounded-lg border border-dashed border-brand/40 bg-transparent px-4 py-3 text-left text-sm font-medium text-brand-hover hover:bg-brand-soft"
              disabled={details.variations.length >= 20}
              onClick={() =>
                change("variations", [
                  ...details.variations,
                  {
                    id: crypto.randomUUID(),
                    name: "",
                    priceCents: parsePrice(price) ?? 0,
                    sku: "",
                    barcode: "",
                    soldOut: false,
                  },
                ])
              }
            >
              <Plus size={18} />
              Añadir variante
            </button>
          </section>
          <section
            id="product-modifiers"
            className="editor-section flex scroll-mt-24 flex-col gap-5 border-b border-line py-7 [&_h3]:text-[19px] [&_h3]:font-medium max-tablet:gap-4 max-tablet:py-6"
          >
            <h3>Modificadores</h3>
            {details.modifierSets.map((set, index) => (
              <div
                className="editor-option-row flex flex-col gap-4 rounded-lg border border-line p-5 max-tablet:p-4"
                key={set.id}
              >
                <div className="field">
                  <label htmlFor={`modifier-set-${set.id}`}>
                    Grupo {index + 1}
                  </label>
                  <input
                    id={`modifier-set-${set.id}`}
                    value={set.name}
                    placeholder="Ej. Leche"
                    maxLength={60}
                    required
                    onChange={(e) =>
                      change(
                        "modifierSets",
                        details.modifierSets.map((s) =>
                          s.id === set.id ? { ...s, name: e.target.value } : s,
                        ),
                      )
                    }
                  />
                </div>
                <div className="editor-two-columns grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
                  {(["min", "max"] as const).map((k) => (
                    <div className="field" key={k}>
                      <label htmlFor={`${k}-${set.id}`}>
                        {k === "min"
                          ? "Selecciones mínimas"
                          : "Selecciones máximas"}
                      </label>
                      <input
                        id={`${k}-${set.id}`}
                        type="number"
                        min={k === "min" ? 0 : 1}
                        max={set.options.length}
                        value={set[k]}
                        onChange={(e) =>
                          change(
                            "modifierSets",
                            details.modifierSets.map((s) =>
                              s.id === set.id
                                ? { ...s, [k]: Number(e.target.value) }
                                : s,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                {set.options.map((o, oi) => (
                  <div
                    className="modifier-input-row grid grid-cols-[minmax(0,1fr)_130px_48px] items-end gap-2 max-tablet:grid-cols-[minmax(0,1fr)_100px] max-tablet:[&>button]:col-start-2 max-tablet:[&>button]:justify-self-end"
                    key={o.id}
                  >
                    <div className="field">
                      <label htmlFor={`modifier-${o.id}`}>
                        Opción {oi + 1} de grupo {index + 1}
                      </label>
                      <input
                        id={`modifier-${o.id}`}
                        value={o.name}
                        maxLength={60}
                        required
                        placeholder="Ej. Leche de avena"
                        onChange={(e) =>
                          change(
                            "modifierSets",
                            details.modifierSets.map((s) =>
                              s.id === set.id
                                ? {
                                    ...s,
                                    options: s.options.map((item) =>
                                      item.id === o.id
                                        ? { ...item, name: e.target.value }
                                        : item,
                                    ),
                                  }
                                : s,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`modifier-price-${o.id}`}>
                        Precio extra {oi + 1}
                      </label>
                      <MoneyInput
                        id={`modifier-price-${o.id}`}
                        value={priceInput(o.priceCents)}
                        onValueChange={(v) =>
                          change(
                            "modifierSets",
                            details.modifierSets.map((s) =>
                              s.id === set.id
                                ? {
                                    ...s,
                                    options: s.options.map((item) =>
                                      item.id === o.id
                                        ? {
                                            ...item,
                                            priceCents: parsePrice(v) ?? 0,
                                          }
                                        : item,
                                    ),
                                  }
                                : s,
                            ),
                          )
                        }
                      />
                    </div>
                    <button
                      type="button"
                      className="pos-icon-button"
                      disabled={set.options.length <= 1}
                      aria-label={`Quitar opción ${oi + 1} de grupo ${index + 1}`}
                      onClick={() =>
                        change(
                          "modifierSets",
                          details.modifierSets.map((s) =>
                            s.id === set.id
                              ? {
                                  ...s,
                                  max: Math.min(s.max, s.options.length - 1),
                                  min: Math.min(s.min, s.options.length - 1),
                                  options: s.options.filter(
                                    (item) => item.id !== o.id,
                                  ),
                                }
                              : s,
                          ),
                        )
                      }
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                ))}
                <div className="editor-row-actions flex items-center justify-between gap-4">
                  <button
                    type="button"
                    className="editor-text-button inline-flex min-h-12 items-center gap-2 border-0 bg-transparent py-2 text-left text-sm font-medium text-brand-hover hover:text-brand"
                    disabled={set.options.length >= 12}
                    onClick={() =>
                      change(
                        "modifierSets",
                        details.modifierSets.map((s) =>
                          s.id === set.id
                            ? {
                                ...s,
                                options: [
                                  ...s.options,
                                  {
                                    id: crypto.randomUUID(),
                                    name: "",
                                    priceCents: 0,
                                  },
                                ],
                              }
                            : s,
                        ),
                      )
                    }
                  >
                    Añadir opción
                  </button>
                  <button
                    type="button"
                    className="editor-text-button inline-flex min-h-12 items-center gap-2 border-0 bg-transparent py-2 text-left text-sm font-medium text-brand-hover hover:text-brand"
                    onClick={() =>
                      change(
                        "modifierSets",
                        details.modifierSets.filter((s) => s.id !== set.id),
                      )
                    }
                  >
                    Quitar grupo
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="editor-add inline-flex min-h-12 w-full items-center gap-2 rounded-lg border border-dashed border-brand/40 bg-transparent px-4 py-3 text-left text-sm font-medium text-brand-hover hover:bg-brand-soft"
              disabled={details.modifierSets.length >= 6}
              onClick={() =>
                change("modifierSets", [
                  ...details.modifierSets,
                  {
                    id: crypto.randomUUID(),
                    name: "",
                    min: 0,
                    max: 1,
                    options: [
                      { id: crypto.randomUUID(), name: "", priceCents: 0 },
                    ],
                  },
                ])
              }
            >
              <Plus size={18} />
              Añadir grupo de modificadores
            </button>
          </section>
          <section
            id="product-inventory"
            className="editor-section flex scroll-mt-24 flex-col gap-5 border-b border-line py-7 [&_h3]:text-[19px] [&_h3]:font-medium max-tablet:gap-4 max-tablet:py-6"
          >
            <h3>Disponibilidad</h3>
            <label className="editor-check flex min-h-12 cursor-pointer items-center gap-3 [&_input]:size-5">
              <input
                type="checkbox"
                checked={details.soldOut}
                onChange={(e) => change("soldOut", e.target.checked)}
              />
              <span>Marcar como agotado</span>
            </label>
            <label className="editor-check flex min-h-12 cursor-pointer items-center gap-3 [&_input]:size-5">
              <input
                type="checkbox"
                checked={details.favorite}
                onChange={(e) => change("favorite", e.target.checked)}
              />
              <span>Mostrar en favoritos</span>
            </label>
            <label className="editor-check flex min-h-12 cursor-pointer items-center gap-3 [&_input]:size-5 [&_small]:mt-1 [&_small]:block [&_small]:text-[13px] [&_small]:text-muted">
              <input
                type="checkbox"
                checked={details.trackStock}
                onChange={(e) => change("trackStock", e.target.checked)}
              />
              <span>
                Controlar existencias
                <small>
                  Cada unidad vendida descuenta existencias compartidas entre variantes.
                </small>
              </span>
            </label>
            {details.trackStock && (
              <div className="editor-two-columns grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
                <div className="field">
                  <label htmlFor="product-stock">Existencias actuales</label>
                  <input
                    id="product-stock"
                    type="number"
                    min={0}
                    max={999999}
                    step={1}
                    value={details.stock}
                    onChange={(e) => change("stock", Number(e.target.value))}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="product-low-stock">
                    Aviso de pocas existencias
                  </label>
                  <input
                    id="product-low-stock"
                    type="number"
                    min={0}
                    max={999999}
                    value={details.lowStockAlert}
                    onChange={(e) =>
                      change("lowStockAlert", Number(e.target.value))
                    }
                  />
                </div>
              </div>
            )}
          </section>
        </fieldset>
        <footer className="editor-footer sticky bottom-0 z-30 col-span-full border-t border-line bg-white px-6 py-4 [&_.pos-error]:mt-0 [&_.pos-error]:mb-3 max-tablet:px-4 max-tablet:pt-3 max-tablet:pb-[calc(12px+env(safe-area-inset-bottom))]">
          {error && (
            <p
              className="pos-error mt-6 border-l-3 border-danger pl-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
              role="alert"
            >
              {error}
            </p>
          )}
          {uncertain && (
            <p className="product-help text-sm">
              Reintenta para confirmar el guardado.
            </p>
          )}
          <div className="editor-footer-actions flex justify-end gap-3">
            <button
              type="button"
              className="pos-button pos-secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancelar
            </button>
            {conflict ? (
              <button
                type="button"
                className="pos-button pos-primary"
                onClick={onRefresh}
              >
                Revisar cambios
              </button>
            ) : (
              <button
                className="pos-button pos-primary"
                disabled={busy}
                aria-busy={busy}
              >
                {busy
                  ? "Guardando…"
                  : uncertain
                    ? "Reintentar guardado"
                    : "Guardar producto"}
              </button>
            )}
          </div>
        </footer>
      </form>
    </PosDialog>
  );
}
