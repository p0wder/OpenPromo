/**
 * S&S Activewear answers for tests, in the shapes Inkline reads in production.
 * Where each shape comes from: "docs" (S&S's v2 API docs, or proved in
 * production) or "guessed" (field names as we read S&S's docs, unconfirmed).
 */
export const SS_FIXTURE_SOURCES = { styles: "docs", products: "docs", ordersByPo: "docs", orderTracking: "guessed", orderPost: "guessed", ordersInvoiced: "guessed" } as const;

export const SS_STYLE = { styleID: 39, partNumber: "00760", brandName: "Gildan", styleName: "5000", title: "Heavy Cotton T-Shirt", description: "5.3 oz., 100% cotton", baseCategory: "T-Shirts", styleImage: "Images/Style/39_fm.jpg" };
export const SS_STYLES = [SS_STYLE, { styleID: 4113, brandName: "BELLA + CANVAS", styleName: "3001", title: "Unisex Jersey Tee", baseCategory: "T-Shirts" }];

const sku = (sku: string, colorName: string, color1: string, sizeName: string, extra: Record<string, unknown>) => ({
  sku,
  gtin: `00821780${sku.slice(-5)}`,
  styleID: 39,
  brandName: "Gildan",
  styleName: "5000",
  colorName,
  color1,
  colorFrontImage: `Images/Color/${sku}_f.jpg`,
  colorBackImage: `Images/Color/${sku}_b.jpg`,
  colorSwatchImage: `Images/ColorSwatch/${sku}_s.jpg`,
  sizeName,
  customerPrice: 2.5,
  piecePrice: 3.12,
  dozenPrice: 2.98,
  casePrice: 2.75,
  caseQty: 72,
  ...extra,
});

/** Gildan 5000 in Black (L, XL) and White (L): stock per warehouse. */
export const SS_PRODUCTS = [
  sku("B00760003", "Black", "#000000", "L", { qty: 1200, warehouses: [{ warehouseAbbr: "IL", qty: 700 }, { warehouseAbbr: "NV", qty: 500 }] }),
  sku("B00760004", "Black", "#000000", "XL", { qty: 10, warehouses: [{ warehouseAbbr: "IL", qty: 6 }, { warehouseAbbr: "NV", qty: 4 }] }),
  sku("B00860003", "White", "#FFFFFF", "L", { customerPrice: 2.2, piecePrice: 2.8, dozenPrice: 2.8, qty: 0, warehouses: [{ warehouseAbbr: "ZZ", qty: -3 }] }),
];

export const SS_PO = "1042-9";

/** S&S split PO 1042-9 by warehouse: SS-8800 (IL) shipped 8 XL by UPS and is invoiced; SS-8801 (NV, 4 XL) is still being picked. */
export const SS_ORDERS = [
  {
    orderNumber: "SS-8800",
    poNumber: SS_PO,
    orderStatus: "Shipped",
    orderType: "Order",
    warehouseAbbr: "IL",
    shippingCarrier: "UPS",
    shippingMethod: "Ground",
    trackingNumber: "1Z5V1E750312345678, 1Z5V1E750312345679",
    shipDate: "2026-11-09T00:00:00",
    invoiceNumber: "SI-310045",
    invoiceDate: "2026-11-09",
    dueDate: "2026-12-09",
    terms: "Net 30",
    subtotal: 24.96,
    shipping: 8.95,
    tax: 0,
    total: 33.91,
    lines: [{ sku: "B00760004", styleName: "5000", brandName: "Gildan", title: "Heavy Cotton T-Shirt", colorName: "Black", sizeName: "XL", qtyOrdered: 8, qtyShipped: 8, price: 3.12 }],
  },
  {
    orderNumber: "SS-8801",
    poNumber: SS_PO,
    orderStatus: "In Progress",
    orderType: "Order",
    warehouseAbbr: "NV",
    expectedShipDate: "2026-11-14",
    lines: [{ sku: "B00760004", styleName: "5000", colorName: "Black", sizeName: "XL", qtyOrdered: 4, qtyShipped: 0, price: 3.12 }],
  },
];
