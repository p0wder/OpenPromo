/**
 * What OpenPromo answers, the same for every supplier. Money is in cents
 * (integers), dates are ISO 8601 strings as the supplier sent them (dates
 * trimmed to YYYY-MM-DD where the field is a day).
 */

export const PROMOSTANDARDS_SERVICES = ["productData", "inventory", "pricing", "orderStatus", "shipments", "invoices"] as const;
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

export interface ShipmentPackage {
  trackingNumber: string;
  carrier?: string;
  method?: string;
  shippedOn?: string;
  items: { productId?: string; partId?: string; quantity: number }[];
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
