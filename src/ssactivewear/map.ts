/**
 * S&S's answers in OpenPromo's shared shapes, so a caller reads S&S exactly
 * as it reads SanMar or any PromoStandards supplier. Pure functions: tested
 * on S&S's JSON, no network. A part is an S&S SKU; a product is an S&S style
 * (its numeric style id).
 */
import type { Inventory, Invoice, InvoiceLine, OrderLine, OrderState, OrderStatus, PriceType, Pricing, Product, SalesOrder, Shipment } from "../promostandards/types.js";
import type { SsOrder, SsOrderLine, SsProduct, SsStyle } from "./types.js";

const IMAGE_BASE = "https://www.ssactivewear.com/";
/** An S&S image path as a full URL. */
export const ssImage = (path?: string) => (path ? (/^https?:\/\//.test(path) ? path : IMAGE_BASE + path.replace(/^\//, "")) : undefined);

/** S&S's warehouses as people know them (from S&S's site). An abbreviation not listed shows as it is. */
export const SS_WAREHOUSES: Record<string, string> = {
  IL: "Lockport, IL",
  KS: "Olathe, KS",
  NV: "Reno, NV",
  TX: "Fort Worth, TX",
  GA: "McDonough, GA",
  NJ: "Robbinsville, NJ",
  OH: "West Chester, OH",
  FL: "Pompano Beach, FL",
  DS: "Drop ship",
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const cents = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n * 100);
};
const qty = (v: unknown) => Math.max(0, Math.floor(num(v) ?? 0));
const day = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s || undefined;
};
const str = (v: unknown): string | undefined => (v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim());
const same = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
const BACKORDER = /\bback ?-?order/i;

/* ---------------------------------------------------------------- Product, inventory, pricing */

/** A style and its SKUs as a product: one part per SKU, with color, size, hex, GTIN and pictures. */
export function ssProduct(style: SsStyle, products: readonly SsProduct[]): Product {
  return {
    productId: String(style.styleID),
    styleNumber: style.styleName,
    name: style.title,
    brand: style.brandName,
    description: style.description?.trim() ? [style.description.trim()] : [],
    categories: style.baseCategory?.trim() ? [{ category: style.baseCategory.trim() }] : [],
    keywords: [],
    primaryImageUrl: ssImage(style.styleImage),
    priceGroups: [],
    parts: products.map((p) => {
      const images = Object.fromEntries(
        Object.entries({ front: p.colorFrontImage, back: p.colorBackImage, side: p.colorSideImage, swatch: p.colorSwatchImage }).flatMap(([view, path]) => {
          const url = ssImage(path);
          return url ? [[view, url]] : [];
        }),
      );
      return {
        partId: p.sku,
        colorName: p.colorName,
        ...(p.color1 ? { colorHex: p.color1 } : {}),
        size: p.sizeName,
        labelSize: p.sizeName,
        ...(p.gtin ? { gtin: p.gtin } : {}),
        ...(Object.keys(images).length ? { images } : {}),
      };
    }),
  };
}

/** Stock per SKU and warehouse. `partIds` keeps it to those SKUs. */
export function ssInventory(styleId: string, products: readonly SsProduct[], partIds: readonly string[] = []): Inventory {
  const want = new Set(partIds.map((p) => p.toLowerCase()));
  return {
    productId: styleId,
    parts: products
      .filter((p) => !want.size || want.has(p.sku.toLowerCase()))
      .map((p) => {
        const locations = (p.warehouses ?? []).filter((w) => w?.warehouseAbbr).map((w) => ({ id: w.warehouseAbbr, name: SS_WAREHOUSES[w.warehouseAbbr.toUpperCase()] ?? w.warehouseAbbr, quantity: qty(w.qty) }));
        return { partId: p.sku, color: p.colorName, size: p.sizeName, available: p.qty !== undefined ? qty(p.qty) : locations.reduce((n, l) => n + l.quantity, 0), locations };
      }),
  };
}

/**
 * Prices per SKU, in cents. Customer and Net are the account's own price
 * (`customerPrice`); List is S&S's list price, with the dozen and case breaks
 * when S&S sends them. A SKU with no price of that kind is left out.
 */
export function ssPricing(styleId: string, products: readonly SsProduct[], priceType: PriceType, opts: { partId?: string } = {}): Pricing {
  const rows = opts.partId ? products.filter((p) => same(p.sku, opts.partId!)) : products;
  return {
    productId: styleId,
    priceType,
    parts: rows.flatMap((p) => {
      const breaks: { minQuantity: number; price: number }[] = [];
      if (priceType === "List") {
        const piece = cents(p.piecePrice);
        if (piece) breaks.push({ minQuantity: 1, price: piece });
        const dozen = cents(p.dozenPrice);
        if (dozen && dozen !== piece) breaks.push({ minQuantity: 12, price: dozen });
        const kase = cents(p.casePrice);
        const caseQty = qty(p.caseQty);
        if (kase && caseQty > 12 && kase !== dozen) breaks.push({ minQuantity: caseQty, price: kase });
      } else {
        const own = cents(p.customerPrice);
        if (own) breaks.push({ minQuantity: 1, price: own });
      }
      return breaks.length ? [{ partId: p.sku, prices: breaks }] : [];
    }),
  };
}

/* ---------------------------------------------------------------- Orders */

/** S&S's `orderStatus` words as the shared state (guessed wording: anything not recognised reads as received). */
export function ssOrderState(status: string | null | undefined): OrderState {
  const s = (status ?? "").toLowerCase();
  if (/cancel|void/.test(s)) return "cancelled";
  if (/partial/.test(s)) return "partially_shipped";
  if (/ship|complete|deliver|invoic|closed/.test(s)) return "shipped";
  if (/progress|process|pick|pack|production|released|warehouse|back ?-?order/.test(s)) return "in_production";
  return "received";
}

const orderNumberOf = (o: SsOrder) => str(o.orderNumber);
const trackingNumbers = (o: SsOrder) => [...new Set((o.trackingNumber ?? "").split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean))];
const lineIds = (l: SsOrderLine) => ({
  ...(str(l.styleName) ?? str(l.styleID) ? { productId: (str(l.styleName) ?? str(l.styleID))! } : {}),
  ...(str(l.sku) ?? str(l.identifier) ? { partId: (str(l.sku) ?? str(l.identifier))! } : {}),
});

/** One S&S order as a sales order. Final once shipped and invoiced, or cancelled. */
export function ssSalesOrder(o: SsOrder): SalesOrder {
  const state = ssOrderState(o.orderStatus);
  const lines: OrderLine[] = (o.lines ?? []).map((l) => ({ ...lineIds(l), ordered: qty(l.qtyOrdered), shipped: qty(l.qtyShipped) }));
  const done = state === "cancelled" || state === "shipped";
  return {
    salesOrderNumber: orderNumberOf(o) ?? str(o.guid) ?? "",
    state,
    status: str(o.orderStatus) ?? state,
    final: state === "cancelled" || (state === "shipped" && !!str(o.invoiceNumber)),
    backordered: !done && BACKORDER.test(o.orderStatus ?? ""),
    onHold: /\bhold\b/i.test(o.orderStatus ?? ""),
    ...(!done && day(o.expectedShipDate) ? { expectedShipDate: day(o.expectedShipDate) } : {}),
    lines,
  };
}

/** The orders under each PO among S&S's answer, grouped: one `OrderStatus` per PO number. */
export function ssOrderStatus(orders: readonly SsOrder[]): OrderStatus[] {
  const byPo = new Map<string, OrderStatus>();
  for (const o of orders) {
    if (!o || typeof o !== "object") continue;
    const po = str(o.poNumber) ?? "";
    const key = po.toLowerCase();
    let entry = byPo.get(key);
    if (!entry) byPo.set(key, (entry = { purchaseOrderNumber: po, orders: [] }));
    entry.orders.push(ssSalesOrder(o));
  }
  return [...byPo.values()];
}

/**
 * What S&S has shipped: one shipment per S&S order that carries a tracking
 * number or reads shipped. S&S gives the order's tracking numbers but not
 * which items went in which box, so the shipped lines sit on the first package.
 */
export function ssShipments(orders: readonly SsOrder[]): Shipment[] {
  const out: Shipment[] = [];
  for (const o of orders) {
    if (!o || typeof o !== "object") continue;
    const state = ssOrderState(o.orderStatus);
    const numbers = trackingNumbers(o);
    if (state === "cancelled" || (!numbers.length && state !== "shipped" && state !== "partially_shipped")) continue;
    const items = (o.lines ?? []).filter((l) => qty(l.qtyShipped) > 0).map((l) => ({ ...lineIds(l), quantity: qty(l.qtyShipped) }));
    const base = { ...(str(o.shippingCarrier) ? { carrier: str(o.shippingCarrier) } : {}), ...(str(o.shippingMethod) ? { method: str(o.shippingMethod) } : {}), ...(day(o.shipDate) ? { shippedOn: day(o.shipDate) } : {}) };
    out.push({
      purchaseOrderNumber: str(o.poNumber) ?? "",
      salesOrderNumber: orderNumberOf(o) ?? "",
      complete: state === "shipped",
      packages: (numbers.length ? numbers : [""]).map((trackingNumber, i) => ({ trackingNumber, ...base, items: i === 0 ? items : [] })),
    });
  }
  return out;
}

/**
 * S&S's invoices: each S&S order with an invoice number is one invoice (S&S
 * invoices each warehouse's order on its own). Lines are what shipped (else
 * what was ordered) at the price billed. S&S doesn't say what's been paid,
 * so `amountDue` is left out. A return or credit reads as a credit, in positive amounts.
 */
export function ssInvoices(orders: readonly SsOrder[]): Invoice[] {
  return orders
    .filter((o) => o && typeof o === "object" && str(o.invoiceNumber) && ssOrderState(o.orderStatus) !== "cancelled")
    .map((o) => {
      const lines: InvoiceLine[] = (o.lines ?? []).flatMap((l) => {
        const quantity = qty(l.qtyShipped) || qty(l.qtyOrdered);
        if (!quantity) return [];
        const unitPrice = Math.abs(cents(l.price) ?? 0);
        const description = [l.brandName, l.styleName, l.title, l.colorName, l.sizeName].map(str).filter(Boolean).join(" ") || undefined;
        return [{ ...lineIds(l), ...(description ? { description } : {}), quantity, unitPrice, extendedPrice: unitPrice * quantity }];
      });
      const subtotal = cents(o.subtotal);
      const shipping = cents(o.shipping);
      const tax = cents(o.tax);
      const total = cents(o.total) ?? (subtotal ?? lines.reduce((n, l) => n + (l.extendedPrice ?? 0), 0)) + (shipping ?? 0) + (tax ?? 0);
      const credit = /credit|return/i.test(o.orderType ?? "") || (num(o.total) ?? 0) < 0;
      const salesOrder = orderNumberOf(o);
      return {
        invoiceNumber: str(o.invoiceNumber)!,
        kind: credit ? ("credit" as const) : ("invoice" as const),
        ...(str(o.poNumber) ? { purchaseOrderNumber: str(o.poNumber) } : {}),
        salesOrderNumbers: salesOrder ? [salesOrder] : [],
        ...(day(o.invoiceDate) ? { invoiceDate: day(o.invoiceDate) } : {}),
        ...(day(o.dueDate) ? { dueDate: day(o.dueDate) } : {}),
        ...(str(o.terms) ? { paymentTerms: str(o.terms) } : {}),
        ...(subtotal !== undefined ? { subtotal: Math.abs(subtotal) } : {}),
        ...(shipping !== undefined ? { shipping: Math.abs(shipping) } : {}),
        ...(tax !== undefined ? { tax: Math.abs(tax) } : {}),
        total: Math.abs(total),
        lines,
      };
    });
}
