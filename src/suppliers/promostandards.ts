/**
 * Any PromoStandards supplier as a driver, from its endpoints alone: a
 * directory entry or a server's own config becomes a supplier with no code.
 */
import { OpenPromoError } from "../errors.js";
import { PromoStandardsClient, type PromoStandardsSupplier } from "../promostandards/client.js";
import { buildPurchaseOrder, type PurchaseOrderInput } from "../promostandards/order.js";
import type { Media, PromoStandardsService } from "../promostandards/types.js";
import { PURCHASE_ORDER_SCHEMA } from "../server/schemas.js";
import { errorAnswer, ID_PASSWORD_LOGIN, liveOrdersUnder, type Capability, type DriverRoute, type RouteAnswer, type RouteContext, type SupplierConnection, type SupplierDriver } from "./driver.js";
import { hasClassType, type MediaFilter } from "./media.js";

/** A PromoStandards supplier as the directory lists it. */
export interface PromoStandardsListing extends PromoStandardsSupplier {
  /** PromoStandards' own company code, when the supplier came from its directory. */
  code?: string;
  website?: string;
  notes?: string;
}

/** The shared questions each service answers. */
const CAPABILITY_OF: Record<PromoStandardsService, readonly Capability[]> = {
  // Product Data 2.0.0 answers one product (getProduct), what the supplier sells (getProductSellable) and what changed (getProductDateModified).
  productData: ["product", "productList", "productChanges"],
  inventory: ["inventory"],
  pricing: ["pricing"],
  orderStatus: ["orderStatus"],
  shipments: ["shipments"],
  invoices: ["invoices"],
  media: ["media", "mediaChanges"],
  // Purchase Order places something real: no shared read capability. Its routes are PURCHASE_ORDER_ROUTES (`orders` is a write route).
  purchaseOrder: [],
};

/** Media Content's `classType` is a number: a class type's name is matched on the answer instead. */
async function psMedia(client: PromoStandardsClient, productId: string, f: MediaFilter): Promise<Media> {
  const classType = f.classType?.trim();
  const media = await client.getMedia(productId, { mediaType: f.mediaType, partId: f.partId, classType: classType && /^\d+$/.test(classType) ? classType : undefined });
  return classType ? { ...media, items: media.items.filter((m) => hasClassType(m, classType)) } : media;
}

/** A connection that answers from these PromoStandards services, only those the supplier lists. */
export function promoStandardsConnection(client: PromoStandardsClient): SupplierConnection {
  const all: Required<SupplierConnection> = {
    product: (id) => client.getProduct(id),
    productList: () => client.getProductsSellable(),
    productChanges: (since) => client.getProductsChanged(since),
    inventory: (id, f) => client.getInventory(id, f.partIds?.length ? { partIds: f.partIds } : {}),
    pricing: (id, o) => client.getPricing(id, o),
    orderStatus: (q) => client.getOrderStatus(q),
    shipments: (q) => client.getShipments(q),
    invoices: (q) => client.getInvoices(q),
    media: (id, f) => psMedia(client, id, f),
    mediaChanges: (since) => client.getMediaChanges(since),
  };
  const out: SupplierConnection = {};
  for (const [service, capabilities] of Object.entries(CAPABILITY_OF) as [PromoStandardsService, readonly Capability[]][]) {
    if (client.has(service)) for (const capability of capabilities) (out as Record<Capability, unknown>)[capability] = all[capability];
  }
  return out;
}

/** The shared questions a PromoStandards supplier answers: the services it lists at versions OpenPromo talks. */
export function promoStandardsCapabilities(supplier: PromoStandardsSupplier): Capability[] {
  const probe = new PromoStandardsClient(supplier, { id: "", password: "" });
  return (Object.entries(CAPABILITY_OF) as [PromoStandardsService, readonly Capability[]][]).filter(([s]) => probe.has(s)).flatMap(([, c]) => c);
}

/** A PromoStandards supplier on one login: the shared questions it answers, and its client (for Purchase Order). */
export interface PromoStandardsConnection extends SupplierConnection {
  ps: PromoStandardsClient;
}

/** The body of `POST /v1/{supplier}/orders` and `/orders/check`: a Blank purchase order, and the one opt-out. */
export interface PurchaseOrderRequest extends PurchaseOrderInput {
  /** Only for a supplier without Order Status: send although OpenPromo can't look for an earlier order under the PO. */
  skipDuplicateCheck?: boolean;
}

/**
 * Everything placing an order checks, short of sending it: the order passes
 * `buildPurchaseOrder`, the duplicate check can be made (or the caller opted
 * out, for a supplier without Order Status), the supplier takes Blank orders,
 * and Order Status shows nothing live under the PO. An error answer (or a
 * thrown `OpenPromoError`) when any of it fails; nothing is ever sent here.
 */
async function preparePurchaseOrder({ connection, body }: RouteContext<PromoStandardsConnection>) {
  const { ps } = connection;
  const supplier = ps.supplier.id;
  const raw = await body<PurchaseOrderRequest>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OpenPromoError("invalid", "The body must be a JSON object: a purchase order (see the PurchaseOrder schema at /openapi.json).", { supplier });
  const { skipDuplicateCheck, ...order } = raw;
  if (skipDuplicateCheck !== undefined && typeof skipDuplicateCheck !== "boolean") throw new OpenPromoError("invalid", "skipDuplicateCheck must be true or false.", { supplier });
  const built = buildPurchaseOrder(order, { supplier });
  if (!connection.orderStatus && skipDuplicateCheck !== true) {
    throw new OpenPromoError(
      "invalid",
      `${ps.supplier.name} doesn't list Order Status, so OpenPromo can't check whether an order under PO ${built.poNumber} was already placed. Nothing was sent. Make sure it wasn't (ask ${ps.supplier.name}), then send it again with "skipDuplicateCheck": true.`,
      { supplier },
    );
  }
  const types = await ps.getSupportedOrderTypes();
  if (!types.includes("Blank")) {
    const takes = types.length ? `it takes ${types.join(", ")}` : "it lists no order types";
    throw new OpenPromoError("not_enabled", `${ps.supplier.name} doesn't take Blank orders through PromoStandards (${takes}). Nothing was sent.`, { supplier });
  }
  const duplicateCheck = connection.orderStatus ? ("orderStatus" as const) : ("skipped" as const);
  const existing = connection.orderStatus ? await liveOrdersUnder(connection, built.poNumber) : [];
  const duplicate: RouteAnswer | null = existing.length ? errorAnswer(409, "duplicate", `${ps.supplier.name} already has an order under PO ${built.poNumber}. Nothing was sent.`, { supplier, orders: existing }) : null;
  return { order, built, duplicateCheck, duplicate };
}

/**
 * The order routes of a PromoStandards supplier that lists Purchase Order
 * 1.0.0: the same two routes for every such supplier. `orders` is a write
 * route, so the handler refuses it with `403 orders_off` unless the supplier
 * is in OPENPROMO_ORDERS, before anything reaches the supplier.
 */
export const PURCHASE_ORDER_ROUTES: readonly DriverRoute<PromoStandardsConnection>[] = [
  {
    method: "POST",
    path: "orders/check",
    summary:
      "Check a Blank purchase order (PromoStandards PO 1.0.0) without sending it: everything placing it would check (the order, Blank orders taken, Order Status for a live order under the PO), and the lines, total and changes as they would be sent. Never calls sendPO.",
    requestSchema: PURCHASE_ORDER_SCHEMA,
    async handle(ctx) {
      const { built, duplicateCheck, duplicate } = await preparePurchaseOrder(ctx);
      if (duplicate) return duplicate;
      const { poNumber, total, currency, lines, changes } = built;
      return { status: 200, body: { ok: true, poNumber, total, currency, lines, changes, duplicateCheck } };
    },
  },
  {
    method: "POST",
    path: "orders",
    summary:
      "Place a Blank purchase order (PromoStandards PO 1.0.0 sendPO), once. Refused with 409 when Order Status shows a live order under the PO; for a supplier without Order Status, refused unless the body says \"skipDuplicateCheck\": true.",
    write: true,
    requestSchema: PURCHASE_ORDER_SCHEMA,
    async handle(ctx) {
      const { order, duplicateCheck, duplicate } = await preparePurchaseOrder(ctx);
      if (duplicate) return duplicate;
      return { status: 201, body: { ...(await ctx.connection.ps.sendPurchaseOrder(order)), duplicateCheck } };
    },
  },
];

/** A PromoStandards supplier as a driver: `X-Supplier-Id` and `X-Supplier-Password`, production or test, and the order routes when it lists Purchase Order 1.0.0. */
export function promoStandardsDriver(listing: PromoStandardsListing): SupplierDriver<PromoStandardsConnection> {
  const hasTest = Object.values(listing.endpoints).some((ep) => ep?.testUrl);
  const takesOrders = new PromoStandardsClient(listing, { id: "", password: "" }).has("purchaseOrder");
  return {
    id: listing.id,
    name: listing.name,
    kind: "promostandards",
    capabilities: promoStandardsCapabilities(listing),
    login: ID_PASSWORD_LOGIN,
    environments: hasTest ? ["production", "test"] : ["production"],
    website: listing.website,
    notes: listing.notes,
    ...(takesOrders ? { routes: PURCHASE_ORDER_ROUTES } : {}),
    connect(login, opts) {
      const ps = new PromoStandardsClient(listing, { id: login.id ?? "", password: login.password ?? "" }, { environment: opts.environment === "test" ? "test" : "production", fetch: opts.fetch });
      return { ...promoStandardsConnection(ps), ps };
    },
  };
}
