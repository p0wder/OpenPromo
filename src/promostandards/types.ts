/**
 * What OpenPromo answers, the same for every supplier. Money is in cents
 * (integers), dates are ISO 8601 strings as the supplier sent them (dates
 * trimmed to YYYY-MM-DD where the field is a day).
 */

export const PROMOSTANDARDS_SERVICES = ["productData", "inventory", "pricing", "orderStatus", "shipments", "invoices", "media", "purchaseOrder"] as const;
export type PromoStandardsService = (typeof PROMOSTANDARDS_SERVICES)[number];

/* ---------------------------------------------------------------- Product Data */

export interface Product {
  productId: string;
  /** The style number people use ("PC54", "5000"), when the supplier's product id is something else. */
  styleNumber?: string;
  name: string;
  brand?: string;
  description: string[];
  categories: { category: string; subCategory?: string }[];
  keywords: string[];
  primaryImageUrl?: string;
  /** Price groups the supplier publishes on the product (e.g. MSRP), cents. */
  priceGroups: { name: string; currency?: string; prices: { minQuantity: number; maxQuantity?: number; price: number }[] }[];
  parts: ProductPart[];
  lastChangeDate?: string;
}

export interface ProductPart {
  partId: string;
  colorName?: string;
  /** The color as a hex code ("#1A2B3C"), when the supplier gives one. */
  colorHex?: string;
  /** The size as the supplier names it ("XL"); PromoStandards' `labelSize`, or the supplier's own size name. */
  size?: string;
  standardColorName?: string;
  approximatePms?: string;
  labelSize?: string;
  apparelStyle?: string;
  gtin?: string;
  isCloseout?: boolean;
  /** Pictures of this color, by view ("front", "back", "side", "swatch"). */
  images?: Record<string, string>;
}

/**
 * One product in a supplier's list: what it sells (Product Data's
 * getProductSellable) or what changed (getProductDateModified). Only ids:
 * ask `product` for the rest.
 */
export interface ListedProduct {
  productId: string;
  /** The parts the supplier named for it, each once, in its order. Empty when it lists products only (S&S's styles). */
  partIds: string[];
}

/** `GET /v1/{supplier}/products[?changedSince=]`: every product the supplier sells, or those changed since a time. */
export interface ProductList {
  /** Only with `?changedSince=`: the time asked, as sent. */
  changedSince?: string;
  count: number;
  products: ListedProduct[];
}

/* ---------------------------------------------------------------- Inventory */

export interface Inventory {
  productId: string;
  parts: InventoryPart[];
}

export interface InventoryPart {
  partId: string;
  color?: string;
  size?: string;
  description?: string;
  /** Total available across locations. */
  available: number;
  locations: { id: string; name?: string; postalCode?: string; quantity: number }[];
}

/* ---------------------------------------------------------------- Pricing and Configuration */

export type PriceType = "Net" | "List" | "Customer";

export interface PartPricing {
  partId: string;
  prices: { minQuantity: number; price: number; uom?: string; effectiveDate?: string; expiryDate?: string }[];
}

export interface Pricing {
  productId: string;
  priceType: PriceType;
  currency?: string;
  parts: PartPricing[];
}

/* ---------------------------------------------------------------- Order Status */

/**
 * Where an order stands, the same words for every supplier and service
 * version: received (taken, not accepted or started yet), in_production
 * (accepted: picking or making; Order Status 2.0.0 "Confirmed"),
 * partially_shipped, shipped (in full) or cancelled.
 */
export type OrderState = "received" | "in_production" | "partially_shipped" | "shipped" | "cancelled";

export interface OrderLine {
  productId?: string;
  partId?: string;
  lineNumber?: string;
  ordered?: number;
  shipped?: number;
  /** The supplier's words for the line. */
  status?: string;
}

/** One supplier order (sales order) filed under the customer's PO number. */
export interface SalesOrder {
  salesOrderNumber: string;
  state: OrderState;
  /** The supplier's own words ("Partially Shipped", "Back Order Hold"). */
  status: string;
  /** Shipped in full and invoiced, or cancelled: the supplier won't update it again (stop asking). */
  final: boolean;
  /** Something is on backorder. */
  backordered: boolean;
  /** On hold for another reason (credit, art, general). */
  onHold: boolean;
  expectedShipDate?: string;
  expectedDeliveryDate?: string;
  updatedAt?: string;
  note?: string;
  lines: OrderLine[];
}

export interface OrderStatus {
  purchaseOrderNumber: string;
  orders: SalesOrder[];
}

/** Look an order up by the customer's PO number, the supplier's order number, or everything changed since a time. */
export type OrderQuery = { poNumber: string } | { salesOrderNumber: string } | { since: string };

/* ---------------------------------------------------------------- Shipment Notification */

/** A ship-from or ship-to address, as Order Shipment Notification 2.x gives it. */
export interface ShippingAddress {
  attentionTo?: string;
  companyName?: string;
  address1: string;
  address2?: string;
  address3?: string;
  city: string;
  /** State or province ("TX"). */
  region: string;
  postalCode: string;
  /** ISO 3166 two-letter code. */
  country?: string;
  email?: string;
  phone?: string;
}

export interface ShipmentItem {
  productId?: string;
  partId?: string;
  quantity: number;
  /** The unit the quantity counts ("EA", "DZ"), when the supplier says (OSN 2.x). */
  uom?: string;
  /** The line of the customer's PO this is, when the supplier says (OSN 2.x). */
  lineNumber?: string;
}

/**
 * One package. Everything after `items` is optional and given only by
 * services that send it (Order Shipment Notification 2.x): left out, not
 * empty, when the supplier doesn't say.
 */
export interface ShipmentPackage {
  trackingNumber: string;
  carrier?: string;
  /** The carrier's service ("Ground"). */
  method?: string;
  shippedOn?: string;
  items: ShipmentItem[];
  shipFrom?: ShippingAddress;
  shipTo?: ShippingAddress;
  /** "Commercial", "Residential" or "Other". */
  destinationType?: string;
  /** The customer collects it rather than a carrier delivering it. */
  customerPickup?: boolean;
  weight?: { value: number; uom: string };
  dimensions?: { uom: string; length?: number; width?: number; height?: number };
  /** The freight account the package shipped on. */
  shippingAccount?: string;
  /** Freight terms ("Prepaid", "Collect"), the supplier's words. */
  shipmentTerms?: string;
}

export interface Shipment {
  purchaseOrderNumber: string;
  salesOrderNumber: string;
  complete: boolean;
  packages: ShipmentPackage[];
}

/* ---------------------------------------------------------------- Invoice */

export interface InvoiceLine {
  productId?: string;
  partId?: string;
  description?: string;
  quantity: number;
  unitPrice?: number;
  extendedPrice?: number;
}

export interface Invoice {
  invoiceNumber: string;
  /** "invoice" or "credit" (credit memo). */
  kind: "invoice" | "credit";
  purchaseOrderNumber?: string;
  salesOrderNumbers: string[];
  invoiceDate?: string;
  dueDate?: string;
  paymentTerms?: string;
  currency?: string;
  subtotal?: number;
  shipping?: number;
  handling?: number;
  tax?: number;
  total?: number;
  amountDue?: number;
  lines: InvoiceLine[];
}

export type InvoiceQuery = { poNumber: string } | { invoiceNumber: string } | { invoiceDate: string } | { availableSince: string };

/* ---------------------------------------------------------------- Media Content */

/** What kind of file a media item is (Media Content's `mediaType`). */
export type MediaType = "Image" | "Video" | "Audio" | "Document";

/** One picture, video, sound or document of a product. Optional fields are left out, not empty, when the supplier doesn't say. */
export interface MediaItem {
  url: string;
  /** The supplier's word: "Image", "Video", "Audio" or "Document". */
  mediaType: string;
  /** The part (color, size) the file shows, when it's of one part. */
  partId?: string;
  /** The color, the supplier's words. */
  color?: string;
  /** What the file is (the schema's `ClassType`: an id and a short name such as "Primary" or "Front"), every one the supplier sends. */
  classTypes: { id: string; name: string }[];
  description?: string;
  /** Pixels, as the supplier gives them. */
  width?: number;
  height?: number;
  dpi?: number;
  /** As the supplier gives it (the schema doesn't name the unit). */
  fileSize?: number;
  /** The file shows exactly this one part (the schema's `singlePart`). */
  singlePart?: boolean;
  /** When the supplier last changed it. */
  changedAt?: string;
  /** Decoration methods the file shows ("Screen Print"). */
  decorations?: { id: string; name: string }[];
  /** Decoration locations the file shows ("Front Chest"). */
  locations?: { id: string; name: string }[];
}

export interface Media {
  productId: string;
  items: MediaItem[];
}
