/**
 * S&S Activewear's answers as its REST API v2 sends them. Style and product
 * fields are the ones Inkline reads in production. Order fields are named as
 * we read S&S's Orders docs and are unconfirmed: a field S&S doesn't send is
 * left out of what OpenPromo answers, never guessed.
 */

export interface SsStyle {
  styleID: number;
  partNumber?: string;
  brandName: string;
  /** The style number ("5000"). */
  styleName: string;
  title: string;
  description?: string;
  baseCategory?: string;
  categories?: string;
  styleImage?: string;
  brandImage?: string;
}

/** One SKU: a color and size of a style. Prices in dollars. */
export interface SsProduct {
  sku: string;
  gtin?: string;
  styleID: number;
  brandName?: string;
  styleName: string;
  colorName: string;
  color1?: string;
  colorSwatchImage?: string;
  colorFrontImage?: string;
  colorBackImage?: string;
  colorSideImage?: string;
  sizeName: string;
  sizeOrder?: string;
  /** The account's own price. */
  customerPrice?: number;
  /** The list price for one piece. */
  piecePrice?: number;
  dozenPrice?: number;
  casePrice?: number;
  caseQty?: number;
  salePrice?: number;
  mapPrice?: number;
  /** Total stock. */
  qty?: number;
  /** Stock per S&S warehouse ("IL", "NV", …). */
  warehouses?: { warehouseAbbr: string; skuID?: number; qty?: number }[];
}

/** One S&S order. S&S may split one PO across warehouses into several, each with its own invoice and tracking. */
export interface SsOrder {
  guid?: string;
  orderNumber?: string | number;
  invoiceNumber?: string | number;
  poNumber?: string;
  orderStatus?: string;
  orderType?: string;
  orderDate?: string;
  invoiceDate?: string;
  dueDate?: string;
  terms?: string;
  warehouseAbbr?: string;
  shippingCarrier?: string;
  shippingMethod?: string;
  /** One tracking number, or several separated by commas. */
  trackingNumber?: string;
  shipDate?: string;
  expectedShipDate?: string;
  subtotal?: number | string;
  shipping?: number | string;
  tax?: number | string;
  total?: number | string;
  lines?: SsOrderLine[];
}

export interface SsOrderLine {
  identifier?: string;
  sku?: string;
  styleID?: number | string;
  styleName?: string;
  brandName?: string;
  title?: string;
  colorName?: string;
  sizeName?: string;
  qtyOrdered?: number | string;
  qtyShipped?: number | string;
  price?: number | string;
}
