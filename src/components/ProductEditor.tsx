import { useEffect, useRef, useState } from "react";
import { ImagePlus, Plus, Trash2 } from "lucide-react";
import { AccountClientError } from "../lib/account";
import type { PosCommand, Product, ProductDetails, VatTreatment } from "../lib/pos-contracts";
import { emptyDetails, productDetails, tileForegroundColor } from "../lib/product-details";
import { parsePrice, posRequest, priceInput, type PosAccess } from "../lib/pos";
import { PosDialog } from "./PosShared";
import MoneyInput from "./MoneyInput";
import { PendingIndicator } from "./LoadingPlaceholder";
import ProductVatFields from "./ProductVatFields";
import { productVat, vatRates } from "../lib/vat";
import { accessErrorCodes } from "./useCatalog";
import ProductIdentityFields from "./ProductIdentityFields";
import ProductNutritionFields from "./ProductNutritionFields";
import ProductVariationBuilder from "./ProductVariationBuilder";
import ProductCustomAttributes from "./ProductCustomAttributes";
import { copyModifierSets } from "../lib/product-modifier-copy";

const sections = [
  ["identity", "Información"],
  ["pricing", "Precio e IVA"],
  ["variations", "Tamaños"],
  ["modifiers", "Extras"],
  ["availability", "Disponibilidad"],
] as const;

export default function ProductEditor({
  product,
  defaultVatTreatment = 'vat_16',
  products,
  access,
  onClose,
  onSaved,
  onRefresh,
  onSessionError,
}: {
  product: Product | null;
  defaultVatTreatment?: VatTreatment;
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
          taxTreatment: productVat(productDetails(product)),
        }
      : { ...emptyDetails(), taxBps: vatRates[defaultVatTreatment], taxTreatment: defaultVatTreatment },
  );
  const [image, setImage] = useState(product?.image ?? "");
  const [imageDragging, setImageDragging] = useState(false);
  const [calories, setCalories] = useState(product?.details?.calories?.toString() ?? "");
  const [moneyDrafts, setMoneyDrafts] = useState<Record<string, string>>({});
  const [modifierSource, setModifierSource] = useState("");

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

  function moneyValue(id: string, cents: number) {
    return moneyDrafts[id] ?? priceInput(cents);
  }

  function changeMoney(id: string, value: string) {
    setMoneyDrafts((current) => ({ ...current, [id]: value }));
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
      const priceCents = details.variablePrice ? 0 : parsePrice(price);
      if (productVat(details) === "unconfigured") {
        setError("Selecciona el IVA del producto.");
        return;
      }
      if (!name.trim() || priceCents === null) {
        setError("Escribe el nombre y un precio válido.");
        return;
      }
      if (details.variablePrice && details.variations.length) {
        setError("El precio abierto no admite variantes. Quita las variantes o elige precio fijo.");
        return;
      }
      const calorieValue = calories === "" ? null : Number(calories);
      if (calorieValue !== null && (!/^\d+$/.test(calories) || !Number.isSafeInteger(calorieValue) || calorieValue > 100000)) {
        setError("Escribe las calorías como un número entero entre 0 y 100000.");
        return;
      }
      const variationPrices = details.variations.map(variation => parsePrice(moneyValue(variation.id, variation.priceCents)));
      const modifierPrices = details.modifierSets.flatMap(set => set.options.map(option => parsePrice(moneyValue(option.id, option.priceCents))));
      if ([...variationPrices, ...modifierPrices].some(value => value === null)) {
        setError("Revisa los precios de variantes y extras. Para una opción sin costo escribe 0.");
        return;
      }
      if (details.variations.some(variation => !variation.name.trim()) || details.modifierSets.some(set => !set.name.trim() || !Number.isInteger(set.min) || !Number.isInteger(set.max) || set.min < 0 || set.min > set.max || set.max < 1 || set.max > set.options.length || set.options.some(option => !option.name.trim()))) {
        setError("Revisa los nombres y las selecciones mínimas y máximas de las opciones.");
        return;
      }
      const customAttributes = (details.customAttributes ?? []).map(attribute => ({ name: attribute.name.trim(), value: attribute.value.trim() }));
      if (customAttributes.length > 8 || customAttributes.some(attribute => !attribute.name || !attribute.value) || new Set(customAttributes.map(attribute => attribute.name.normalize("NFC").toLocaleLowerCase("es-MX"))).size !== customAttributes.length) {
        setError("Completa cada atributo con un nombre y valor. Usa hasta 8 nombres diferentes.");
        return;
      }
      const nextDetails = {
        ...details,
        description: details.description.replace(/\s+/g, " ").trim(),
        customerName: details.customerName.trim(),
        kitchenName: details.kitchenName.trim(),
        tileLabel: details.tileLabel.trim(),
        sku: details.sku.trim(),
        barcode: details.barcode.trim(),
        dietary: details.dietary.trim(),
        allergens: details.allergens.trim(),
        calories: calorieValue,
        ...(details.customAttributes !== undefined ? { customAttributes } : {}),
        variations: details.variations.map((variation, index) => ({ ...variation, name: variation.name.trim(), sku: variation.sku.trim(), barcode: variation.barcode.trim(), priceCents: variationPrices[index]! })),
        modifierSets: details.modifierSets.map(set => ({ ...set, name: set.name.trim(), options: set.options.map(option => ({ ...option, name: option.name.trim(), priceCents: parsePrice(moneyValue(option.id, option.priceCents))! })) })),
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
        onInvalid={event => {
          const disclosure = (event.target as HTMLElement).closest("details");
          if (disclosure) disclosure.open = true;
        }}
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
                  style={{ backgroundColor: details.tileColor, color: tileForegroundColor(details.tileColor), outline: imageDragging ? "2px solid #006AFF" : undefined }}
                  onDragOver={event => { if (!locked && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setImageDragging(true); } }}
                  onDragLeave={() => setImageDragging(false)}
                  onDrop={event => { event.preventDefault(); setImageDragging(false); if (!locked) void chooseImage(event.dataTransfer.files[0]); }}
                >
                  {image ? (
                    <img
                      width={240}
                      height={240}
                      src={image}
                      alt="Imagen del producto"
                    />
                  ) : (
                    details.tileLabel ? <span className="px-2 text-center text-lg font-medium">{details.tileLabel}</span> : <ImagePlus size={36} strokeWidth={1.5} aria-hidden="true" />
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
                <p className="hidden text-center text-xs text-muted tablet:block">También puedes arrastrar una foto.</p>
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
            {products.some(item => item.id !== product?.id && item.image && item.details?.imageId) && (
              <div className="field">
                <label htmlFor="product-reuse-image">Usar imagen de otro producto</label>
                <select
                  id="product-reuse-image"
                  value=""
                  onChange={event => {
                    const source = products.find(item => item.id === event.target.value);
                    if (!source?.image || !source.details?.imageId) return;
                    imageUpload.current = null;
                    setImage(source.image);
                    change("imageId", source.details.imageId);
                  }}
                >
                  <option value="">Elegir una imagen guardada</option>
                  {products.filter(item => item.id !== product?.id && item.image && item.details?.imageId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </div>
            )}
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
            <ProductIdentityFields details={details} change={change} />
            <ProductNutritionFields details={details} calories={calories} setCalories={setCalories} change={change} />
            <ProductCustomAttributes attributes={details.customAttributes ?? []} onChange={attributes => change("customAttributes", attributes)} />
          </section>
          <section
            id="product-pricing"
            className="editor-section flex scroll-mt-24 flex-col gap-5 border-b border-line py-7 [&_h3]:text-[19px] [&_h3]:font-medium max-tablet:gap-4 max-tablet:py-6"
          >
            <h3>Precio e IVA</h3>
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm">Cómo defines el precio</legend>
              <div className="grid grid-cols-2 gap-3 max-[30rem]:grid-cols-1">
                {[
                  { variable: false, label: "Precio fijo", help: "Importe definido en el catálogo." },
                  { variable: true, label: "Precio abierto", help: "Escribe el importe en cada venta." },
                ].map(option => (
                  <label key={option.label} className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-line p-3">
                    <input
                      className="mt-1 size-5"
                      type="radio"
                      name="product-price-mode"
                      checked={details.variablePrice === option.variable}
                      disabled={option.variable && details.variations.length > 0}
                      onChange={() => change("variablePrice", option.variable)}
                    />
                    <span>
                      <span className="block font-medium">{option.label}</span>
                      <span className="mt-1 block text-sm text-muted">{option.help}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {details.variations.length > 0 && <p className="text-sm text-muted">Quita las variantes para activar el precio abierto.</p>}
            {details.variablePrice ? <p className="text-sm text-muted">El importe se solicita al añadir el producto a la venta. El IVA elegido se aplica al precio que captures.</p> : <div className="editor-two-columns grid grid-cols-2 gap-4 max-[30rem]:grid-cols-1">
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
            </div>}

            <ProductVatFields
              treatment={productVat(details)}
              priceCents={details.variablePrice ? null : parsePrice(price)}
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
            {details.variablePrice ? <p className="text-sm text-muted">Para ofrecer variantes con precios definidos, cambia a precio fijo.</p> : <ProductVariationBuilder variations={details.variations} priceCents={parsePrice(price)} onChange={variations => change("variations", variations)} />}
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
                      value={moneyValue(v.id, v.priceCents)}
                      required
                      onValueChange={(value) => changeMoney(v.id, value)}
                    />
                  </div>
                </div>

                <details className="rounded-lg border border-line px-3">
                  <summary className="min-h-12 cursor-pointer py-3.5 text-sm">Códigos de variante {index + 1}</summary>
                  <div className="grid grid-cols-2 gap-4 pb-4 max-[30rem]:grid-cols-1">
                    <div className="field">
                      <label htmlFor={`variation-sku-${v.id}`}>SKU de variante {index + 1}</label>
                      <input
                        id={`variation-sku-${v.id}`}
                        value={v.sku}
                        maxLength={60}
                        onChange={event => change("variations", details.variations.map(item => item.id === v.id ? { ...item, sku: event.target.value } : item))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`variation-barcode-${v.id}`}>Código de barras de variante {index + 1}</label>
                      <input
                        id={`variation-barcode-${v.id}`}
                        value={v.barcode}
                        maxLength={32}
                        onChange={event => change("variations", details.variations.map(item => item.id === v.id ? { ...item, barcode: event.target.value } : item))}
                      />
                    </div>
                  </div>
                </details>

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
              disabled={details.variablePrice || details.variations.length >= 20 || parsePrice(price) === null}
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
            {products.some(item => item.id !== product?.id && productDetails(item).modifierSets.length) && (
              <div className="flex flex-col gap-3 rounded-lg border border-line p-4">
                <div className="field">
                  <label htmlFor="product-copy-modifiers">Copiar extras de otro producto</label>
                  <select id="product-copy-modifiers" value={modifierSource} onChange={event => setModifierSource(event.target.value)}>
                    <option value="">Elegir producto</option>
                    {products.filter(item => item.id !== product?.id && productDetails(item).modifierSets.length).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </div>
                <p className="text-sm text-muted">Los grupos se copian con sus precios y límites. Los cambios que hagas aquí solo afectan a este producto.</p>
                <button
                  type="button"
                  className="pos-button pos-secondary self-start"
                  disabled={!modifierSource}
                  onClick={() => {
                    const source = products.find(item => item.id === modifierSource);
                    const sourceSets = source ? productDetails(source).modifierSets : [];
                    if (!sourceSets.length) return;
                    try {
                      change("modifierSets", copyModifierSets(details.modifierSets, sourceSets));
                      setModifierSource("");
                      setError("");
                    } catch (caught) {
                      setError((caught as Error).message);
                    }
                  }}
                >
                  Añadir grupos copiados
                </button>
              </div>
            )}
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
                        value={moneyValue(o.id, o.priceCents)}
                        required
                        onValueChange={(value) => changeMoney(o.id, value)}
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
            <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-line p-4">
              <input type="checkbox" className="mt-1 size-5" checked={details.skipCustomization ?? false} onChange={event => change("skipCustomization", event.target.checked)} />
              <span>
                <span className="block font-medium">Agregar directo cuando sea posible</span>
                <span className="mt-1 block text-sm text-muted">Los extras opcionales se pueden elegir desde el menú del producto. Siempre se solicitan las opciones obligatorias y el precio abierto.</span>
              </span>
            </label>
          </section>
          <section
            id="product-availability"
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
          </section>
        </fieldset>
        <footer className="editor-footer sticky bottom-0 z-30 col-span-full border-t border-line bg-white px-6 py-4 [&_.pos-error]:mt-0 [&_.pos-error]:mb-3 max-tablet:px-4 max-tablet:pt-3 max-tablet:pb-[calc(12px+env(safe-area-inset-bottom))]">
          {error && (
            <p
              className="pos-error mt-6 bg-danger-soft p-3 text-sm text-danger [&_p]:text-inherit [&_button]:mt-3"
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
                {busy && <PendingIndicator label="Guardando producto" />}
                {uncertain ? "Reintentar guardado" : "Guardar producto"}
              </button>
            )}
          </div>
        </footer>
      </form>
    </PosDialog>
  );
}
