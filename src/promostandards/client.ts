/**
 * PromoStandards client: the standard SOAP services most promotional-product
 * and apparel suppliers expose, written once. A supplier needs only a
 * `PromoStandardsSupplier` (its endpoints, versions and any quirks), not new
 * code. Every call takes the login it should use, so one client serves one
 * account and many clients serve many.
 *
 * Built: Product Data 2.0.0 (getProduct, getProductSellable,
 * getProductDateModified), Inventory 2.0.0, Pricing and Configuration
 * 1.0.0, Order Status 1.0.0 and 2.0.0, Order Shipment Notification 1.0.0,
 * 2.0.0 and 2.1.0, Invoice 1.0.0, Media Content 1.1.0, Purchase Order 1.0.0
 * (Blank orders, from the official schema: see `order.ts`). Request and response
 * shapes follow the PromoStandards schemas as SanMar's Web Services
 * Integration Guide v24.7 (Oct 2026) prints them (Order Shipment
 * Notification 2.0.0 and 2.1.0, Media Content 1.1.0: the official schemas);
 * each parser reads both the 1.x and 2.x spellings where they differ.
 */
import { OpenPromoError, type OpenPromoErrorKind } from "../errors.js";
import { asArray, DEFAULT_TIMEOUT_MS, node, sendSoap, soapRequest, text, type SoapBody, type SoapCall, type XmlNode } from "../soap.js";
import { buildPurchaseOrder, PO_ORDER_TYPES, type PurchaseOrderInput, type PurchaseOrderPlaced, type PurchaseOrderType } from "./order.js";
import type {
  Inventory,
  Invoice,
  InvoiceQuery,
  ListedProduct,
  Media,
  MediaItem,
  MediaType,
  OrderLine,
  OrderQuery,
  OrderState,
  OrderStatus,
  PriceType,
  Pricing,
  Product,
  PromoStandardsService,
  SalesOrder,
  Shipment,
  ShipmentPackage,
  ShippingAddress,
} from "./types.js";

export interface PromoStandardsEndpoint {
  /** The service version the supplier runs ("1.0.0", "2.0.0"). */
  version: string;
  url: string;
  /** The supplier's test host, when it has one. */
  testUrl?: string;
}

/** One supplier's PromoStandards setup. */
export interface PromoStandardsSupplier {
  /** A short id ("sanmar"). */
  id: string;
  name: string;
  endpoints: Partial<Record<PromoStandardsService, PromoStandardsEndpoint>>;
  /** A service message code that means something other than the standard says. */
  messageKinds?: Record<string, OpenPromoErrorKind>;
  /** The FOB point Pricing and Configuration asks for when the caller doesn't say (else the first from getFobPoints). */
  defaultFobId?: string;
  timeoutMs?: number;
}

/** A PromoStandards login: `id` and `password` as the supplier issued them. */
export interface PromoStandardsLogin {
  id: string;
  password: string;
}

export interface PromoStandardsClientOptions {
  /** "test" uses each endpoint's `testUrl`. */
  environment?: "production" | "test";
  fetch?: typeof fetch;
}

/* ---------------------------------------------------------------- Service messages */

/**
 * PromoStandards service message codes (the guide's errors table). Anything
 * not listed is `refused` with the supplier's words.
 */
export const MESSAGE_KINDS: Record<string, OpenPromoErrorKind> = {
  "100": "auth", // ID (customerID) not found
  "104": "not_enabled", // Account not authorized to use this service
  "105": "auth", // Authentication credentials failed
  "110": "auth", // Authentication credentials required
  "115": "bad_response", // wsVersion not found
  "120": "invalid", // Required field(s) missing
  "125": "not_enabled", // Not supported
  "130": "not_found", // Product id not found
  "135": "not_found", // Product color not found
  "140": "not_found", // Part id not found
  "145": "not_found", // Part color not found
  "150": "not_found", // Part size not found
  "155": "invalid", // Invalid date format
  "160": "not_found", // No results found
  "200": "not_found", // Product data not found
  "300": "invalid", // queryType not found
  "301": "not_yet", // PO or invoice not found: not shipped and invoiced yet
  "302": "invalid", // shipmentDateTimeStamp invalid
  "303": "invalid", // Date older than 7 days
  "999": "refused", // General error
};

interface ServiceMessage {
  code: string;
  description: string;
  severity: string;
}

function serviceMessages(res: XmlNode, bareText = false): ServiceMessage[] {
  const list = asArray(node(res.ServiceMessageArray)?.ServiceMessage as XmlNode | XmlNode[] | undefined);
  // 1.x services answer one `errorMessage` instead.
  const legacy = asArray((res.errorMessage ?? res.ErrorMessage) as XmlNode | XmlNode[] | string | (XmlNode | string)[] | undefined);
  return [...list, ...legacy]
    .map((m) =>
      // `<errorMessage>words</errorMessage>` with no code, read only where the service's spec asks for it.
      typeof m === "string" ? { code: "", description: bareText ? text(m) : "", severity: "Error" } : { code: text(m.code), description: text(m.description), severity: text(m.severity) || "Error" },
    )
    .filter((m) => m.code || m.description);
}

/**
 * Media Content's wording for problems, for an `errorMessage` with no code, a
 * code the standard doesn't list, or the catch-all 999. First match wins;
 * anything else is `refused` with the supplier's words.
 */
export const MEDIA_MESSAGE_WORDS: readonly [RegExp, OpenPromoErrorKind][] = [
  [/\bnot (?:been )?(?:authori[sz]ed|enabled|activated|permitted)\b.*\b(?:service|media)\b|\bservice (?:is )?not (?:available|enabled)\b|\bnot supported\b/i, "not_enabled"],
  [/\bauthenticat|\bcredential|\bpassword\b|\bunauthori[sz]ed\b|\blog ?in\b|\binvalid (?:customer ?)?id\b|\baccess denied\b/i, "auth"],
  [/\bno (?:media|results?|records?|data|images?|content)\b|\bnot found\b|\bdoes(?: not|n'?t) exist\b|\b(?:invalid|unknown) (?:product|part)\b/i, "not_found"],
  [/\btoo many\b|\brate limit|\bthrottl/i, "rate_limited"],
  [/\brequired\b|\bmissing\b|\binvalid\b|\bnot (?:a )?valid\b/i, "invalid"],
];

/* ---------------------------------------------------------------- Each service, by version */

interface ServiceSpec {
  namespace: (version: string) => string;
  request: string;
  response: string;
  soapAction?: string;
  /** Request fields in the operation's own namespace (`ns:`); every other field is a shared object (`shar:`). */
  ownFields?: readonly string[];
  /** Wording that names a problem when a message's code doesn't (Media Content); bare-text `errorMessage`s are read too. */
  messageWords?: readonly [RegExp, OpenPromoErrorKind][];
}

const PS = "http://www.promostandards.org/WSDL";

const SPECS: Record<PromoStandardsService, Record<string, ServiceSpec>> = {
  productData: {
    "2.0.0": { namespace: (v) => `${PS}/ProductDataService/${v}/`, request: "GetProductRequest", response: "GetProductResponse", soapAction: "getProduct" },
  },
  inventory: {
    "2.0.0": { namespace: (v) => `${PS}/Inventory/${v}/`, request: "GetInventoryLevelsRequest", response: "GetInventoryLevelsResponse", soapAction: "getInventoryLevels" },
  },
  pricing: {
    "1.0.0": { namespace: (v) => `${PS}/PricingAndConfiguration/${v}/`, request: "GetConfigurationAndPricingRequest", response: "GetConfigurationAndPricingResponse", soapAction: "getConfigurationAndPricing" },
  },
  orderStatus: {
    "1.0.0": { namespace: (v) => `${PS}/OrderStatusService/${v}/`, request: "GetOrderStatusDetailsRequest", response: "GetOrderStatusDetailsResponse", soapAction: "getOrderStatusDetails" },
    "2.0.0": { namespace: (v) => `${PS}/OrderStatus/${v}/`, request: "GetOrderStatusRequest", response: "GetOrderStatusResponse", soapAction: "getOrderStatus" },
  },
  shipments: {
    "1.0.0": {
      namespace: (v) => `${PS}/OrderShipmentNotificationService/${v}/`,
      request: "GetOrderShipmentNotificationRequest",
      response: "GetOrderShipmentNotificationResponse",
      soapAction: "getOrderShipmentNotification",
      ownFields: ["queryType", "referenceNumber", "shipmentDateTimeStamp"],
    },
    // The OSN 2.0.0 schema puts every request field in SharedObjects, and spells it `shipmentDateTimestamp`.
    "2.0.0": {
      namespace: (v) => `${PS}/OrderShipmentNotificationService/${v}/`,
      request: "GetOrderShipmentNotificationRequest",
      response: "GetOrderShipmentNotificationResponse",
      soapAction: "getOrderShipmentNotification",
    },
    // OSN 2.1.0 asks and answers getOrderShipmentNotification exactly as 2.0.0 does (the same request
    // fields and answer tree); its schema only moves the answer's elements into SharedObjects, which
    // reading ignores, and adds a package's `shipReferences`. Its other operations
    // (sendAdvanceShipmentNotification, getServiceMethods) aren't used: OpenPromo only reads.
    "2.1.0": {
      namespace: (v) => `${PS}/OrderShipmentNotificationService/${v}/`,
      request: "GetOrderShipmentNotificationRequest",
      response: "GetOrderShipmentNotificationResponse",
      soapAction: "getOrderShipmentNotification",
    },
  },
  invoices: {
    "1.0.0": { namespace: (v) => `${PS}/Invoice/${v}/`, request: "GetInvoicesRequest", response: "GetInvoicesResponse", soapAction: "getInvoices" },
  },
  // Media Content 1.1.0 keeps the 1.0.0 namespace (MediaContentService.wsdl). `classType` is the
  // request's one field declared in the operation's own schema; the rest are SharedObjects.
  media: {
    "1.1.0": {
      namespace: () => `${PS}/MediaService/1.0.0/`,
      request: "GetMediaContentRequest",
      response: "GetMediaContentResponse",
      soapAction: "getMediaContent",
      ownFields: ["classType"],
      messageWords: MEDIA_MESSAGE_WORDS,
    },
  },
  // PO 1.0.0 (POService.wsdl): `PO` is the request's one field in the service namespace; inside it,
  // buildPurchaseOrder prefixes the service's own elements and leaves the shared objects to `shar:`.
  purchaseOrder: {
    "1.0.0": { namespace: (v) => `${PS}/PO/${v}/`, request: "SendPORequest", response: "SendPOResponse", soapAction: "sendPO", ownFields: ["PO"] },
  },
};

/** Product Data 2.0.0's list of what the supplier sells (ProductDataService.wsdl, SOAP action getProductSellable). Every request field is a SharedObject. */
const PRODUCT_SELLABLE: ServiceSpec = {
  namespace: (v) => `${PS}/ProductDataService/${v}/`,
  request: "GetProductSellableRequest",
  response: "GetProductSellableResponse",
  soapAction: "getProductSellable",
};

/** Product Data 2.0.0's products changed since a time (SOAP action getProductDateModified). */
const PRODUCT_DATE_MODIFIED: ServiceSpec = {
  namespace: (v) => `${PS}/ProductDataService/${v}/`,
  request: "GetProductDateModifiedRequest",
  response: "GetProductDateModifiedResponse",
  soapAction: "getProductDateModified",
};

/** Media Content's other operation. The WSDL's SOAP action is `urn:getMediaDateModified`, unlike getMediaContent's. */
const MEDIA_DATE_MODIFIED: ServiceSpec = {
  namespace: () => `${PS}/MediaService/1.0.0/`,
  request: "GetMediaDateModifiedRequest",
  response: "GetMediaDateModifiedResponse",
  soapAction: "urn:getMediaDateModified",
  messageWords: MEDIA_MESSAGE_WORDS,
};

/** Purchase Order's other operation: wsVersion, id and password only. */
const SUPPORTED_ORDER_TYPES: ServiceSpec = { namespace: (v) => `${PS}/PO/${v}/`, request: "GetSupportedOrderTypesRequest", response: "GetSupportedOrderTypesResponse", soapAction: "getSupportedOrderTypes" };

/** The least time a sendPO is given to answer: a timeout leaves the order unknown, so it gets longer than a read. */
const SEND_PO_TIMEOUT_MS = 45_000;

const FOB_POINTS: ServiceSpec = { namespace: (v) => `${PS}/PricingAndConfiguration/${v}/`, request: "GetFobPointsRequest", response: "GetFobPointsResponse", soapAction: "getFobPoints" };

/** The versions of each service this client can talk. */
export const SUPPORTED_VERSIONS: Record<PromoStandardsService, string[]> = Object.fromEntries(Object.entries(SPECS).map(([s, v]) => [s, Object.keys(v)])) as Record<PromoStandardsService, string[]>;

/** Problems with a supplier config (unsupported versions, non-https URLs); empty when it's usable. */
export function checkSupplierConfig(config: PromoStandardsSupplier): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.id)) problems.push(`supplier id "${config.id}" must be lowercase letters, digits and dashes`);
  for (const [service, ep] of Object.entries(config.endpoints) as [PromoStandardsService, PromoStandardsEndpoint][]) {
    const built = SUPPORTED_VERSIONS[service];
    if (!built) problems.push(`unknown service ${service}`);
    else if (!built.includes(ep.version)) problems.push(`${service} ${ep.version} isn't supported (supported: ${built.join(", ")})`);
    for (const url of [ep.url, ep.testUrl]) if (url !== undefined && !/^https:\/\//.test(url)) problems.push(`${service} URL isn't https: ${url}`);
  }
  return problems;
}

/* ---------------------------------------------------------------- Reading values */

const cents = (v: unknown): number | undefined => {
  const s = text(v).replace(/[$,\s]/g, "");
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
};
const num = (v: unknown): number | undefined => {
  const s = text(v);
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const opt = (v: unknown): string | undefined => text(v) || undefined;
const yes = (v: unknown) => text(v).toLowerCase() === "true";
const child = (v: unknown, key: string): XmlNode | undefined => node(node(v)?.[key]);
const list = (parent: unknown, arrayKey: string, itemKey: string): XmlNode[] => asArray(node(node(parent)?.[arrayKey])?.[itemKey] as XmlNode | XmlNode[] | undefined);
const texts = (v: unknown): string[] => asArray(v as unknown).map(text).filter(Boolean);
/** `Quantity { value, uom }`, or a bare number. */
const quantity = (v: unknown): number | undefined => num(child(v, "Quantity")?.value) ?? num(node(v)?.value) ?? num(v);
const day = (v: unknown): string | undefined => {
  const s = text(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : opt(v);
};

/* ---------------------------------------------------------------- Order Status */

/** Order Status 1.0.0 status ids, as the spec names them, with the shared state each means. */
export const ORDER_STATUS_IDS: Record<string, { name: string; state: OrderState }> = {
  "10": { name: "Order Received", state: "received" },
  "11": { name: "Order Entry Hold", state: "received" },
  "20": { name: "Order Confirmed", state: "received" },
  "30": { name: "Pre-Production", state: "in_production" },
  "40": { name: "General Hold", state: "in_production" },
  "41": { name: "Credit Hold", state: "in_production" },
  "42": { name: "Proof Hold", state: "in_production" },
  "43": { name: "Art Hold", state: "in_production" },
  "44": { name: "Back Order Hold", state: "in_production" },
  "60": { name: "In Production", state: "in_production" },
  "70": { name: "In Storage", state: "in_production" },
  "75": { name: "Partial Shipment", state: "partially_shipped" },
  "80": { name: "Complete", state: "shipped" },
  "99": { name: "Canceled", state: "cancelled" },
};
const HOLD_IDS = new Set(["11", "40", "41", "42", "43"]);
const BACKORDER_WORDS = /\bback ?-?order/i;

/** An Order Status 2.0.0 status word in the shared model; unknown words read as received. */
export function orderStateOf(status: string): OrderState {
  const s = status.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (s === "partially shipped" || s === "partial shipment") return "partially_shipped";
  if (s === "shipped" || s === "complete" || s === "completed") return "shipped";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  // "Confirmed": received, entered and accepted (SanMar's guide p88): the supplier is working on it.
  if (s === "confirmed" || s === "in production" || s === "in storage" || s === "pre production") return "in_production";
  return "received";
}

function orderLines(d: XmlNode): OrderLine[] {
  return list(d, "ProductArray", "Product").map((p) => ({
    productId: opt(p.productId) ?? opt(p.productID),
    partId: opt(p.partId) ?? opt(p.partID),
    lineNumber: opt(p.salesOrderLineNumber),
    ordered: quantity(p.QuantityOrdered),
    shipped: quantity(p.QuantityShipped),
    status: opt(p.status),
  }));
}

/** Order Status 1.0.0 (`OrderStatusDetail` with a numeric `statusID`). */
export function parseOrderStatusV1(res: XmlNode): OrderStatus[] {
  return list(res, "OrderStatusArray", "OrderStatus").map((o) => ({
    purchaseOrderNumber: text(o.purchaseOrderNumber),
    orders: list(o, "OrderStatusDetailArray", "OrderStatusDetail").map((d): SalesOrder => {
      const id = text(d.statusID);
      const known = ORDER_STATUS_IDS[id];
      const status = text(d.statusName) || known?.name || id;
      const note = opt(d.additionalExplanation);
      const state = known?.state ?? orderStateOf(status);
      return {
        salesOrderNumber: text(d.factoryOrderNumber) || text(d.salesOrderNumber),
        state,
        status,
        final: id === "80" || id === "99" || state === "cancelled",
        backordered: id === "44" || BACKORDER_WORDS.test(status) || BACKORDER_WORDS.test(note ?? ""),
        onHold: HOLD_IDS.has(id),
        expectedShipDate: day(d.expectedShipDate),
        expectedDeliveryDate: day(d.expectedDeliveryDate),
        updatedAt: opt(d.validTimestamp),
        note,
        lines: [],
      };
    }),
  }));
}

/** Order Status 2.0.0 (`status` words, holds as `issueCategory` and `IssueArray`, lines in `ProductArray`). */
export function parseOrderStatusV2(res: XmlNode): OrderStatus[] {
  return list(res, "OrderStatusArray", "OrderStatus").map((o) => ({
    purchaseOrderNumber: text(o.purchaseOrderNumber),
    orders: list(o, "OrderStatusDetailArray", "OrderStatusDetail").map((d): SalesOrder => {
      const status = text(d.status) || "Received";
      const issues = list(d, "IssueArray", "Issue").filter((i) => !/^(closed|resolved)$/i.test(text(i.issueStatus)));
      const categories = [text(d.issueCategory), ...issues.map((i) => text(i.issueCategory))].filter(Boolean).map((c) => c.toLowerCase());
      const word = status.trim().toLowerCase();
      const state = orderStateOf(status);
      const lines = orderLines(d);
      return {
        salesOrderNumber: text(d.salesOrderNumber),
        state,
        status,
        final: word === "complete" || state === "cancelled",
        backordered: categories.some((c) => c.includes("backorder")),
        onHold: categories.some((c) => !c.includes("backorder")),
        expectedShipDate: day(d.expectedShipDate),
        expectedDeliveryDate: day(d.expectedDeliveryDate),
        updatedAt: opt(d.validTimestamp),
        note: opt(d.additionalExplanation) ?? opt(d.comment),
        lines,
      };
    }),
  }));
}

/* ---------------------------------------------------------------- Other services */

/** Order Shipment Notification 1.0.0 (packages under `ShipmentLocationArray`). */
export function parseShipments(res: XmlNode): Shipment[] {
  return list(res, "OrderShipmentNotificationArray", "OrderShipmentNotification").flatMap((n) =>
    list(n, "SalesOrderArray", "SalesOrder").map((so) => ({
      purchaseOrderNumber: text(n.purchaseOrderNumber),
      salesOrderNumber: text(so.salesOrderNumber),
      complete: yes(so.complete),
      packages: list(so, "ShipmentLocationArray", "ShipmentLocation").flatMap((loc) =>
        list(loc, "PackageArray", "Package").map((p) => ({
          trackingNumber: text(p.trackingNumber),
          carrier: opt(p.carrier),
          method: opt(p.shipmentMethod),
          shippedOn: day(p.shipmentDate),
          items: list(p, "ItemArray", "Item").map((i) => ({ productId: opt(i.supplierProductId), partId: opt(i.supplierPartId), quantity: num(i.quantity) ?? 0 })),
        })),
      ),
    })),
  );
}

/** An OSN 2.x `ShippingContactDetails`, or undefined when it has no street, city or postal code. */
function shippingAddress(v: unknown): ShippingAddress | undefined {
  const a = node(v);
  if (!a || !(text(a.address1) || text(a.city) || text(a.postalCode))) return undefined;
  const out: ShippingAddress = { address1: text(a.address1), city: text(a.city), region: text(a.region), postalCode: text(a.postalCode) };
  for (const k of ["attentionTo", "companyName", "address2", "address3", "country", "email", "phone"] as const) {
    const s = opt(a[k]);
    if (s) out[k] = s;
  }
  return out;
}

/**
 * Order Shipment Notification 2.0.0 and 2.1.0: `SalesOrderArray` → `ShipmentArray`
 * (one per destination, with its addresses) → `PackageArray` → `ItemArray`.
 * Carrier and service come from `FreightDetails`, quantities from
 * `Quantity { value, uom }`. The optional fields are set only when sent.
 */
export function parseShipmentsV2(res: XmlNode): Shipment[] {
  return list(res, "OrderShipmentNotificationArray", "OrderShipmentNotification").flatMap((n) =>
    list(n, "SalesOrderArray", "SalesOrder").map((so) => ({
      purchaseOrderNumber: text(n.purchaseOrderNumber),
      salesOrderNumber: text(so.salesOrderNumber),
      complete: yes(so.salesOrderShippedInFull),
      packages: list(so, "ShipmentArray", "Shipment").flatMap((sh) => {
        const shipFrom = shippingAddress(sh.shipFromAddress);
        const shipTo = shippingAddress(sh.shipToAddress);
        const destinationType = opt(sh.shipmentDestinationType);
        const pickup = text(sh.customerPickup);
        return list(sh, "PackageArray", "Package").map((p): ShipmentPackage => {
          const freight = child(p, "FreightDetails");
          const size = child(child(p, "Dimension"), "DimensionSize");
          const weight = child(child(p, "Dimension"), "DimensionWeight");
          const weightValue = num(weight?.weight);
          const dims = { length: num(size?.length), width: num(size?.width), height: num(size?.height) };
          const pkg: ShipmentPackage = {
            trackingNumber: text(p.trackingNumber),
            carrier: opt(freight?.carrier),
            method: opt(freight?.service),
            shippedOn: day(p.shipmentDate),
            items: list(p, "ItemArray", "Item").map((i) => {
              const uom = opt(child(i, "Quantity")?.uom);
              const lineNumber = opt(i.purchaseOrderLineNumber);
              return { productId: opt(i.supplierProductId), partId: opt(i.supplierPartId), quantity: quantity(i) ?? 0, ...(uom ? { uom } : {}), ...(lineNumber ? { lineNumber } : {}) };
            }),
          };
          if (shipFrom) pkg.shipFrom = shipFrom;
          if (shipTo) pkg.shipTo = shipTo;
          if (destinationType) pkg.destinationType = destinationType;
          if (pickup) pkg.customerPickup = yes(pickup);
          if (weightValue !== undefined) pkg.weight = { value: weightValue, uom: text(weight?.weightUOM) };
          if (size && Object.values(dims).some((d) => d !== undefined)) {
            pkg.dimensions = { uom: text(size.dimUOM) };
            for (const [k, d] of Object.entries(dims) as [keyof typeof dims, number | undefined][]) if (d !== undefined) pkg.dimensions[k] = d;
          }
          const account = opt(p.shippingAccount);
          const terms = opt(p.shipmentTerms);
          if (account) pkg.shippingAccount = account;
          if (terms) pkg.shipmentTerms = terms;
          return pkg;
        });
      }),
    })),
  );
}

export function parseInvoices(res: XmlNode): Invoice[] {
  return list(res, "InvoiceArray", "Invoice").map((i) => ({
    invoiceNumber: text(i.invoiceNumber),
    kind: /credit/i.test(text(i.invoiceType)) ? ("credit" as const) : ("invoice" as const),
    purchaseOrderNumber: opt(i.purchaseOrderNumber),
    salesOrderNumbers: texts(node(i.SalesOrderNumbersArray)?.salesOrderNumber),
    invoiceDate: day(i.invoiceDate),
    dueDate: day(i.paymentDueDate),
    paymentTerms: opt(i.paymentTerms),
    currency: opt(i.currency),
    subtotal: cents(i.salesAmount),
    shipping: cents(i.shippingAmount),
    handling: cents(i.handlingAmount),
    tax: cents(i.taxAmount),
    total: cents(i.invoiceAmount),
    amountDue: cents(i.invoiceAmountDue),
    lines: list(i, "InvoiceLineItemsArray", "InvoiceLineItem").map((l) => ({
      productId: opt(l.productId),
      partId: opt(l.partId),
      description: opt(l.lineItemDescription) ?? opt(l.partDescription),
      quantity: num(l.invoiceQuantity) ?? quantity(l.InvoiceQuantity) ?? 0,
      unitPrice: cents(l.unitPrice),
      extendedPrice: cents(l.extendedPrice),
    })),
  }));
}

/** Media Content 1.1.0: every `MediaContent` in `MediaContentArray` (those with a URL), in the shared shape; empty when there's none. */
export function parseMedia(res: XmlNode, productId: string): Media {
  const pairs = (m: XmlNode, arrayKey: string, itemKey: string, idKey: string, nameKey: string) => list(m, arrayKey, itemKey).map((x) => ({ id: text(x[idKey]), name: text(x[nameKey]) })).filter((x) => x.id || x.name);
  const items = list(res, "MediaContentArray", "MediaContent")
    .filter((m) => text(m.url))
    .map((m): MediaItem => {
      const item: MediaItem = { url: text(m.url), mediaType: text(m.mediaType), classTypes: pairs(m, "ClassTypeArray", "ClassType", "classTypeId", "classTypeName") };
      const strings = { partId: opt(m.partId), color: opt(m.color), description: opt(m.description), changedAt: opt(m.changeTimeStamp) };
      const numbers = { width: num(m.width), height: num(m.height), dpi: num(m.dpi), fileSize: num(m.fileSize) };
      for (const [k, v] of Object.entries(strings) as [keyof typeof strings, string | undefined][]) if (v !== undefined) item[k] = v;
      for (const [k, v] of Object.entries(numbers) as [keyof typeof numbers, number | undefined][]) if (v !== undefined) item[k] = v;
      if (text(m.singlePart)) item.singlePart = yes(m.singlePart);
      const decorations = pairs(m, "DecorationArray", "Decoration", "decorationId", "decorationName");
      const locations = pairs(m, "LocationArray", "Location", "locationId", "locationName");
      if (decorations.length) item.decorations = decorations;
      if (locations.length) item.locations = locations;
      return item;
    });
  return { productId, items };
}

/** Media Content 1.1.0 getMediaDateModified: the product ids in `MediaDateModifiedArray`, each once, in the order sent. */
export function parseMediaChanges(res: XmlNode): string[] {
  return [...new Set(list(res, "MediaDateModifiedArray", "MediaDateModified").map((m) => text(m.productId)).filter(Boolean))];
}

/** Product ids and part ids, as Product Data lists them, as one entry per product with its parts, each once, in the order sent. */
function listedProducts(items: XmlNode[]): ListedProduct[] {
  const byId = new Map<string, ListedProduct>();
  for (const item of items) {
    const productId = text(item.productId);
    if (!productId) continue;
    const entry = byId.get(productId) ?? { productId, partIds: [] };
    byId.set(productId, entry);
    const partId = text(item.partId);
    if (partId && !entry.partIds.includes(partId)) entry.partIds.push(partId);
  }
  return [...byId.values()];
}

/** Product Data 2.0.0 getProductSellable: every `ProductSellable` in `ProductSellableArray`, grouped by product; empty when there's none. */
export function parseProductSellable(res: XmlNode): ListedProduct[] {
  return listedProducts(list(res, "ProductSellableArray", "ProductSellable"));
}

/** Product Data 2.0.0 getProductDateModified: every `ProductDateModified` in `ProductDateModifiedArray`, grouped by product; empty when none changed. */
export function parseProductDateModified(res: XmlNode): ListedProduct[] {
  return listedProducts(list(res, "ProductDateModifiedArray", "ProductDateModified"));
}

export function parseInventory(res: XmlNode): Inventory | null {
  const inv = child(res, "Inventory");
  if (!inv) return null;
  return {
    productId: text(inv.productId),
    parts: list(inv, "PartInventoryArray", "PartInventory").map((p) => ({
      partId: text(p.partId),
      color: opt(p.partColor),
      size: opt(p.labelSize),
      description: opt(p.partDescription),
      available: quantity(p.quantityAvailable) ?? 0,
      locations: list(p, "InventoryLocationArray", "InventoryLocation").map((l) => ({
        id: text(l.inventoryLocationId),
        name: opt(l.inventoryLocationName),
        postalCode: opt(l.postalCode),
        quantity: quantity(l.inventoryLocationQuantity) ?? 0,
      })),
    })),
  };
}

export function parseProduct(res: XmlNode): Product | null {
  const p = child(res, "Product");
  if (!p) return null;
  return {
    productId: text(p.productId),
    name: text(p.productName),
    brand: opt(p.productBrand),
    description: texts(p.description),
    categories: list(p, "ProductCategoryArray", "ProductCategory").map((c) => ({ category: text(c.category), subCategory: opt(c.subCategory) })),
    keywords: list(p, "ProductKeywordArray", "ProductKeyword").map((k) => text(k.keyword)).filter(Boolean),
    primaryImageUrl: opt(p.primaryImageUrl),
    priceGroups: list(p, "ProductPriceGroupArray", "ProductPriceGroup").map((g) => ({
      name: text(g.groupName),
      currency: opt(g.currency),
      prices: list(g, "ProductPriceArray", "ProductPrice").map((x) => ({ minQuantity: num(x.quantityMin) ?? 1, maxQuantity: num(x.quantityMax), price: cents(x.price) ?? 0 })),
    })),
    parts: list(p, "ProductPartArray", "ProductPart").map((part) => {
      const color = child(child(part, "ColorArray"), "Color") ?? child(child(part, "primaryColor"), "Color");
      const size = child(part, "ApparelSize");
      return {
        partId: text(part.partId),
        colorName: opt(color?.colorName),
        colorHex: opt(color?.hex),
        size: opt(size?.labelSize),
        standardColorName: opt(color?.standardColorName),
        approximatePms: opt(color?.approximatePms),
        labelSize: opt(size?.labelSize),
        apparelStyle: opt(size?.apparelStyle),
        gtin: opt(part.gtin),
        isCloseout: part.isCloseout === undefined ? undefined : yes(part.isCloseout),
      };
    }),
    lastChangeDate: opt(p.lastChangeDate),
  };
}

export function parsePricing(res: XmlNode, priceType: PriceType): Pricing | null {
  const c = child(res, "Configuration");
  if (!c) return null;
  return {
    productId: text(c.productId),
    priceType: (opt(c.priceType) as PriceType | undefined) ?? priceType,
    currency: opt(c.currency),
    parts: list(c, "PartArray", "Part").map((p) => ({
      partId: text(p.partId),
      prices: list(p, "PartPriceArray", "PartPrice").map((x) => ({ minQuantity: num(x.minQuantity) ?? 1, price: cents(x.price) ?? 0, uom: opt(x.priceUom), effectiveDate: opt(x.priceEffectiveDate), expiryDate: opt(x.priceExpiryDate) })),
    })),
  };
}

/* ---------------------------------------------------------------- The client */

/** One supplier's PromoStandards services on one login. */
export class PromoStandardsClient {
  constructor(
    readonly supplier: PromoStandardsSupplier,
    private readonly login: PromoStandardsLogin,
    private readonly options: PromoStandardsClientOptions = {},
  ) {}

  /** Whether the supplier lists this service at a version this client can talk. */
  has(service: PromoStandardsService): boolean {
    const ep = this.supplier.endpoints[service];
    return !!ep && !!SPECS[service][ep.version];
  }

  /** The error for a service message, or null for warnings and information. */
  messageError(m: ServiceMessage, words?: readonly [RegExp, OpenPromoErrorKind][]): OpenPromoError | null {
    if (!/^error$/i.test(m.severity)) return null;
    // Wording only where the code says nothing (none, not in the standard's table, or 999 "General error").
    const byWords = words && (!m.code || !MESSAGE_KINDS[m.code] || m.code === "999") ? words.find(([re]) => re.test(m.description))?.[1] : undefined;
    const kind = this.supplier.messageKinds?.[m.code] ?? byWords ?? MESSAGE_KINDS[m.code] ?? "refused";
    return new OpenPromoError(kind, undefined, { supplier: this.supplier.id, code: m.code, detail: m.description || `code ${m.code}` });
  }

  private endpoint(service: PromoStandardsService): { ep: PromoStandardsEndpoint; spec: ServiceSpec; url: string } {
    const ep = this.supplier.endpoints[service];
    if (!ep) throw new OpenPromoError("not_enabled", `${this.supplier.name} has no ${service} service configured.`, { supplier: this.supplier.id });
    const spec = SPECS[service][ep.version];
    if (!spec) throw new OpenPromoError("invalid", `PromoStandards ${service} ${ep.version} isn't supported (supported: ${SUPPORTED_VERSIONS[service].join(", ")}).`, { supplier: this.supplier.id });
    const url = this.options.environment === "test" ? ep.testUrl : ep.url;
    if (!url) throw new OpenPromoError("invalid", `${this.supplier.name} has no ${this.options.environment === "test" ? "test" : "production"} URL for ${service}.`, { supplier: this.supplier.id });
    return { ep, spec, url };
  }

  /** The SOAP call for a service's operation: wsVersion, id and password, then the fields (own fields as `ns:`). */
  private soapCall(service: PromoStandardsService, fields: SoapBody, spec?: ServiceSpec): { call: SoapCall; use: ServiceSpec } {
    const target = this.endpoint(service);
    const use = spec ?? target.spec;
    const namespace = use.namespace(target.ep.version);
    const own = new Set(use.ownFields ?? []);
    const body: SoapBody = { wsVersion: target.ep.version, id: this.login.id, password: this.login.password };
    for (const [k, v] of Object.entries(fields)) body[own.has(k) ? `ns:${k}` : k] = v;
    return {
      use,
      call: {
        supplier: this.supplier.id,
        url: target.url,
        namespace,
        operation: use.request,
        prefix: "ns",
        namespaces: { shar: `${namespace}SharedObjects/` },
        childPrefix: "shar",
        body,
        soapAction: use.soapAction,
        timeoutMs: this.supplier.timeoutMs,
        fetch: this.options.fetch,
      },
    };
  }

  private async call(service: PromoStandardsService, fields: SoapBody, spec?: ServiceSpec): Promise<XmlNode> {
    const { call, use } = this.soapCall(service, fields, spec);
    const answer = await soapRequest(call);
    const raw = answer[use.response];
    const res = node(raw) ?? (raw === "" ? {} : undefined);
    if (!res) throw new OpenPromoError("bad_response", undefined, { supplier: this.supplier.id, detail: `no ${use.response} in the answer` });
    for (const m of serviceMessages(res, !!use.messageWords)) {
      const err = this.messageError(m, use.messageWords);
      if (err) throw err;
    }
    return res;
  }

  /** Product Data (2.0.0): one product with its parts (colors, sizes, GTINs). Null when the supplier has none. */
  async getProduct(productId: string, filter: { partId?: string; colorName?: string } = {}): Promise<Product | null> {
    try {
      return parseProduct(await this.call("productData", { localizationCountry: "US", localizationLanguage: "EN", productId, partId: filter.partId, colorName: filter.colorName }));
    } catch (e) {
      if (e instanceof OpenPromoError && e.kind === "not_found") return null;
      throw e;
    }
  }

  /**
   * Product Data (2.0.0) getProductSellable: every product (and its parts)
   * the supplier sells today (`isSellable` true). One call for the whole
   * catalog, so ask it rarely (once a day at most), never per search. Empty
   * when the supplier lists none.
   */
  async getProductsSellable(): Promise<ListedProduct[]> {
    try {
      return parseProductSellable(await this.call("productData", { localizationCountry: "US", localizationLanguage: "EN", isSellable: true }, PRODUCT_SELLABLE));
    } catch (e) {
      if (e instanceof OpenPromoError && e.kind === "not_found") return [];
      throw e;
    }
  }

  /**
   * Product Data (2.0.0) getProductDateModified: the products (and parts)
   * changed since a time (ISO 8601; sent as an xsd:dateTime in UTC). Empty
   * when none did.
   */
  async getProductsChanged(since: string): Promise<ListedProduct[]> {
    const at = Date.parse(since);
    if (Number.isNaN(at)) throw new OpenPromoError("invalid", "Say since when as an ISO time, e.g. 2026-11-01T00:00:00Z.", { supplier: this.supplier.id });
    try {
      return parseProductDateModified(await this.call("productData", { changeTimeStamp: new Date(at).toISOString() }, PRODUCT_DATE_MODIFIED));
    } catch (e) {
      if (e instanceof OpenPromoError && e.kind === "not_found") return [];
      throw e;
    }
  }

  /** Inventory (2.0.0): stock by part and location for one product, optionally only some parts. Null when the supplier has no such product. */
  async getInventory(productId: string, filter: { partIds?: string[]; colors?: string[]; sizes?: string[] } = {}): Promise<Inventory | null> {
    const hasFilter = !!(filter.partIds?.length || filter.colors?.length || filter.sizes?.length);
    const Filter = hasFilter
      ? {
          partIdArray: filter.partIds?.length ? { partId: filter.partIds } : undefined,
          LabelSizeArray: filter.sizes?.length ? { labelSize: filter.sizes } : undefined,
          PartColorArray: filter.colors?.length ? { partColor: filter.colors } : undefined,
        }
      : undefined;
    try {
      return parseInventory(await this.call("inventory", { productId, Filter }));
    } catch (e) {
      if (e instanceof OpenPromoError && e.kind === "not_found") return null;
      throw e;
    }
  }

  /** Pricing and Configuration (1.0.0): the FOB points (warehouses) a product ships from. */
  async getFobPoints(productId: string): Promise<{ fobId: string; city?: string; state?: string; postalCode?: string }[]> {
    const res = await this.call("pricing", { productId, localizationCountry: "US", localizationLanguage: "EN" }, FOB_POINTS);
    return list(res, "FobPointArray", "FobPoint").map((f) => ({ fobId: text(f.fobId), city: opt(f.fobCity), state: opt(f.fobState), postalCode: opt(f.fobPostalCode) }));
  }

  /**
   * Pricing and Configuration (1.0.0): blank-goods prices for a product (or
   * one part) as Net (the account's cost), List (suggested retail) or
   * Customer (special) pricing. Null when the supplier has no such product.
   */
  async getPricing(productId: string, opts: { priceType?: PriceType; partId?: string; fobId?: string; currency?: string } = {}): Promise<Pricing | null> {
    const priceType = opts.priceType ?? "Net";
    try {
      const fobId = opts.fobId ?? this.supplier.defaultFobId ?? (await this.getFobPoints(productId))[0]?.fobId;
      if (!fobId) return null;
      const res = await this.call("pricing", {
        productId,
        partId: opts.partId,
        currency: opts.currency ?? "USD",
        fobId,
        priceType,
        localizationCountry: "US",
        localizationLanguage: "EN",
        configurationType: "Blank",
      });
      return parsePricing(res, priceType);
    } catch (e) {
      if (e instanceof OpenPromoError && e.kind === "not_found") return null;
      throw e;
    }
  }

  /**
   * Order Status: the supplier's orders under a PO number or its own order
   * number, or every order changed since a time (2.0.0 also takes "allOpen").
   * Empty when the supplier has no such order. Call it sparingly: suppliers
   * ask for at most a few calls a day per order (SanMar: three, and not in
   * the first two hours after placing).
   */
  async getOrderStatus(query: OrderQuery | { allOpen: true }): Promise<OrderStatus[]> {
    const { ep } = this.endpoint("orderStatus");
    try {
      if (ep.version === "1.0.0") {
        if ("allOpen" in query) throw new OpenPromoError("invalid", "Order Status 1.0.0 can't list all open orders.", { supplier: this.supplier.id });
        const q = "poNumber" in query ? { queryType: 1, referenceNumber: query.poNumber } : "salesOrderNumber" in query ? { queryType: 2, referenceNumber: query.salesOrderNumber } : { queryType: 3, statusTimeStamp: query.since };
        return parseOrderStatusV1(await this.call("orderStatus", q));
      }
      const q =
        "allOpen" in query
          ? { queryType: "allOpen" }
          : "poNumber" in query
            ? { queryType: "poSearch", referenceNumber: query.poNumber }
            : "salesOrderNumber" in query
              ? { queryType: "soSearch", referenceNumber: query.salesOrderNumber }
              : { queryType: "lastUpdate", statusTimeStamp: query.since };
      return parseOrderStatusV2(await this.call("orderStatus", { ...q, returnIssueDetailType: "openIssues", returnProductDetail: true }));
    } catch (e) {
      if (e instanceof OpenPromoError && (e.kind === "not_found" || e.kind === "not_yet")) return [];
      throw e;
    }
  }

  /**
   * Order Shipment Notification (1.0.0, 2.0.0 and 2.1.0): packages and
   * tracking, by PO number, order number, or shipped since a time (7 days at
   * most). Empty when nothing has shipped yet. 2.x also gives addresses,
   * weight, dimensions and freight terms per package.
   */
  async getShipments(query: OrderQuery): Promise<Shipment[]> {
    const { ep } = this.endpoint("shipments");
    const v1 = ep.version === "1.0.0";
    const since = v1 ? "shipmentDateTimeStamp" : "shipmentDateTimestamp";
    const q = "poNumber" in query ? { queryType: 1, referenceNumber: query.poNumber } : "salesOrderNumber" in query ? { queryType: 2, referenceNumber: query.salesOrderNumber } : { queryType: 3, [since]: query.since };
    try {
      const res = await this.call("shipments", q);
      // 2.0.0 and 2.1.0 answer the same tree.
      return v1 ? parseShipments(res) : parseShipmentsV2(res);
    } catch (e) {
      if (e instanceof OpenPromoError && (e.kind === "not_found" || e.kind === "not_yet")) return [];
      throw e;
    }
  }

  /**
   * Invoice (1.0.0): by PO number, invoice number, invoice date, or made
   * available since a time. Empty when there's no invoice yet (a PO shows up
   * once it has shipped and been invoiced).
   */
  async getInvoices(query: InvoiceQuery): Promise<Invoice[]> {
    const q =
      "poNumber" in query
        ? { queryType: 1, referenceNumber: query.poNumber }
        : "invoiceNumber" in query
          ? { queryType: 2, referenceNumber: query.invoiceNumber }
          : "invoiceDate" in query
            ? { queryType: 3, requestedDate: query.invoiceDate }
            : { queryType: 4, availableTimeStamp: query.availableSince };
    try {
      return parseInvoices(await this.call("invoices", q));
    } catch (e) {
      if (e instanceof OpenPromoError && (e.kind === "not_found" || e.kind === "not_yet")) return [];
      throw e;
    }
  }

  /**
   * Media Content (1.1.0): a product's pictures (or videos, sound, documents:
   * one `mediaType` per call, "Image" by default), optionally for one part, of
   * one class type, or in one culture ("en-US"). No media is an empty list.
   */
  async getMedia(productId: string, opts: { mediaType?: MediaType; partId?: string; classType?: number | string; cultureName?: string } = {}): Promise<Media> {
    try {
      const res = await this.call("media", { cultureName: opts.cultureName, mediaType: opts.mediaType ?? "Image", productId, partId: opts.partId, classType: opts.classType });
      return parseMedia(res, productId);
    } catch (e) {
      if (e instanceof OpenPromoError && e.kind === "not_found") return { productId, items: [] };
      throw e;
    }
  }

  /** Media Content (1.1.0) getMediaDateModified: the product ids whose media changed since a time (ISO 8601). Empty when none did. */
  async getMediaChanges(since: string): Promise<string[]> {
    try {
      return parseMediaChanges(await this.call("media", { changeTimeStamp: since }, MEDIA_DATE_MODIFIED));
    } catch (e) {
      if (e instanceof OpenPromoError && e.kind === "not_found") return [];
      throw e;
    }
  }

  /** Purchase Order (1.0.0) getSupportedOrderTypes: the order types the supplier takes (Blank, Sample, Simple, Configured), each once. */
  async getSupportedOrderTypes(): Promise<PurchaseOrderType[]> {
    const res = await this.call("purchaseOrder", {}, SUPPORTED_ORDER_TYPES);
    const said = texts(res.supportedOrderTypes).map((t) => t.toLowerCase());
    return PO_ORDER_TYPES.filter((t) => said.includes(t.toLowerCase()));
  }

  /**
   * Purchase Order (1.0.0) sendPO: places a Blank order, once (never
   * retried), and answers the supplier's `transactionId`. Throws `invalid`
   * before sending (see `buildPurchaseOrder`); `auth`, `not_enabled`,
   * `not_found`, `invalid`, `rate_limited` or `refused` when the supplier
   * turned it down (nothing placed); `unreachable` or `bad_response` when the
   * answer didn't clearly say either way: then the order may have gone
   * through, so look the PO up (Order Status) before sending again. Check
   * that ordering is allowed for the supplier before calling this.
   */
  async sendPurchaseOrder(order: PurchaseOrderInput): Promise<PurchaseOrderPlaced> {
    const supplier = this.supplier.id;
    const built = buildPurchaseOrder(order, { supplier });
    const { call, use } = this.soapCall("purchaseOrder", { PO: built.request });
    call.timeoutMs = Math.max(this.supplier.timeoutMs ?? DEFAULT_TIMEOUT_MS, SEND_PO_TIMEOUT_MS);
    const unknown = (why: string) => `${this.supplier.name} ${why}, so the order may or may not have been placed. Look PO ${built.poNumber} up (Order Status) before sending it again.`;
    let reply;
    try {
      reply = await sendSoap(call);
    } catch (e) {
      const detail = e instanceof OpenPromoError ? e.detail : (e as Error)?.message;
      throw new OpenPromoError("unreachable", unknown("didn't answer"), { supplier, detail });
    }
    if (reply.fault) throw new OpenPromoError("refused", undefined, { supplier, detail: reply.fault.message, code: reply.fault.code, status: reply.status });
    const raw = reply.body?.[use.response];
    const res = node(raw) ?? (raw === "" ? {} : undefined);
    if (!res) {
      if (reply.status === 401 || reply.status === 403) throw new OpenPromoError("auth", `${this.supplier.name} rejected the login; the order wasn't placed.`, { supplier, status: reply.status });
      if (reply.status === 429) throw new OpenPromoError("rate_limited", `${this.supplier.name} is busy (rate limit); the order wasn't placed.`, { supplier, status: 429 });
      if (reply.status >= 500) throw new OpenPromoError("unreachable", unknown(`answered HTTP ${reply.status}`), { supplier, status: reply.status, detail: `HTTP ${reply.status}` });
      throw new OpenPromoError("bad_response", unknown(`answered without a ${use.response}`), { supplier, status: reply.status, detail: `HTTP ${reply.status}: no ${use.response}` });
    }
    const messages = serviceMessages(res);
    const errors = messages.filter((m) => /^error$/i.test(m.severity));
    const transactionId = text(res.transactionId);
    if (errors.length && transactionId) throw new OpenPromoError("bad_response", unknown(`answered both a transaction id (${transactionId}) and an error`), { supplier, status: reply.status, code: errors[0]!.code, detail: errors.map((m) => m.description || `code ${m.code}`).join("; ") });
    if (errors.length) {
      const first = this.messageError(errors[0]!)!;
      // A service message is the supplier's clear answer: nothing was placed, so never a kind that means "unknown".
      const kind = first.kind === "bad_response" || first.kind === "unreachable" || first.kind === "not_yet" ? "refused" : first.kind;
      throw new OpenPromoError(kind, undefined, { supplier, status: reply.status, code: first.code, detail: errors.map((m) => m.description || `code ${m.code}`).join("; ") });
    }
    if (!transactionId) throw new OpenPromoError("bad_response", unknown("answered without a transaction id"), { supplier, status: reply.status });
    if (!reply.ok) throw new OpenPromoError("bad_response", unknown(`answered HTTP ${reply.status} with a transaction id (${transactionId})`), { supplier, status: reply.status });
    return { accepted: true, poNumber: built.poNumber, transactionId, total: built.total, messages, changes: built.changes };
  }
}
