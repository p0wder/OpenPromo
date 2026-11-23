/**
 * The one contract every supplier meets, so the API, the docs and the
 * supplier list are written once and a new supplier is only a driver (or,
 * for a PromoStandards supplier, only a directory entry: no code).
 *
 * A driver says who the supplier is, which login fields it takes (and the
 * headers they come in), and how to connect on one login. A connection
 * answers the shared questions in the shared shapes (`../promostandards/types`)
 * and leaves out what the supplier can't answer. Anything only one supplier
 * does (SanMar's own price list, placing an order) is a driver route.
 */
import type { Inventory, Invoice, InvoiceQuery, OrderQuery, OrderStatus, PriceType, Pricing, Product, Shipment } from "../promostandards/types.js";

/** The shared questions, the same paths and shapes for every supplier. */
export const CAPABILITIES = ["product", "inventory", "pricing", "orderStatus", "shipments", "invoices"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** One field of a supplier login, and the request header it comes in. */
export interface LoginField {
  /** The field's name in the login the driver receives ("account_number"). */
  key: string;
  /** The header it comes in ("X-Supplier-Id"). */
  header: string;
  /** What the supplier calls it ("Account number"). */
  label: string;
}

/** One supplier account, as the driver's login fields: `{ id: "…", password: "…" }`. */
export type SupplierLogin = Record<string, string>;

export interface ConnectOptions {
  /** One of the driver's `environments`; the first is the default. */
  environment: string;
  fetch?: typeof fetch;
}

/** One supplier on one login. Every method is optional: a supplier that can't answer leaves it out. */
export interface SupplierConnection {
  product?(productId: string): Promise<Product | null>;
  inventory?(productId: string, filter: { partIds?: string[] }): Promise<Inventory | null>;
  pricing?(productId: string, opts: { priceType: PriceType; partId?: string; fobId?: string }): Promise<Pricing | null>;
  orderStatus?(query: OrderQuery): Promise<OrderStatus[]>;
  shipments?(query: OrderQuery): Promise<Shipment[]>;
  invoices?(query: InvoiceQuery): Promise<Invoice[]>;
}

/** What a driver route is handed. */
export interface RouteContext<C extends SupplierConnection = SupplierConnection> {
  connection: C;
  request: Request;
  url: URL;
  /** The values of the route's `:name` segments. */
  params: Record<string, string>;
  /** The server's environment variables, for a driver's own settings. Never logins: those come in `connection`. */
  env: Record<string, string | undefined>;
  /** The request body as JSON (throws `invalid` when it isn't). */
  body<T>(): Promise<T>;
}

/** An answer from a driver route: a status and a JSON body. */
export interface RouteAnswer {
  status: number;
  body: unknown;
}

/** Something only this supplier does, at `/v1/{supplier}/{path}`. */
export interface DriverRoute<C extends SupplierConnection = SupplierConnection> {
  method: "GET" | "POST";
  /** Relative to `/v1/{supplier}/`, with `:name` segments ("native/pricing/:style", "orders/preview"). */
  path: string;
  summary: string;
  /** Places something real with the supplier (an order): refused unless the server allows writes. */
  write?: boolean;
  /** For the OpenAPI document: the JSON schema of the body. */
  requestSchema?: Record<string, unknown>;
  handle(ctx: RouteContext<C>): Promise<RouteAnswer>;
}

export interface SupplierDriver<C extends SupplierConnection = SupplierConnection> {
  /** Lowercase letters, digits and dashes ("ssactivewear"). It is the URL segment. */
  id: string;
  name: string;
  /** How OpenPromo talks to it: the supplier's own API, or PromoStandards from the directory. */
  kind: "native" | "promostandards";
  /** The shared questions it answers (what `connect` fills in). */
  capabilities: readonly Capability[];
  login: readonly LoginField[];
  /** "production" first (the default), then the supplier's test environment if it has one. */
  environments: readonly string[];
  /** The header that picks the environment (default `X-Supplier-Environment`). */
  environmentHeader?: string;
  /** For people: where the supplier's integration docs or sign-up are, and anything to know. */
  website?: string;
  notes?: string;
  routes?: readonly DriverRoute<C>[];
  connect(login: SupplierLogin, opts: ConnectOptions): C;
}

/** An error answer in the API's one error shape: `{ error: { kind, message, … } }`. */
export const errorAnswer = (status: number, kind: string, message: string, extra: Record<string, unknown> = {}): RouteAnswer => ({ status, body: { error: { kind, message, ...extra } } });

/**
 * The supplier's live (not cancelled) orders under a PO number, for a driver
 * to check before placing one: never order twice. Empty when the supplier has
 * none, including PromoStandards' "nothing yet".
 */
export async function liveOrdersUnder(connection: SupplierConnection, poNumber: string) {
  if (!connection.orderStatus) return [];
  const po = poNumber.trim().toLowerCase();
  const found = await connection.orderStatus({ poNumber });
  return found
    .filter((o) => o.purchaseOrderNumber.trim().toLowerCase() === po)
    .flatMap((o) => o.orders)
    .filter((o) => o.state !== "cancelled");
}

/** The headers PromoStandards suppliers (and any supplier with an id and a secret) take. */
export const ID_PASSWORD_LOGIN: readonly LoginField[] = [
  { key: "id", header: "X-Supplier-Id", label: "Web services id" },
  { key: "password", header: "X-Supplier-Password", label: "Web services password" },
];

/** A driver id as an env var prefix: "ss-activewear" → "SS_ACTIVEWEAR". */
export const envPrefix = (id: string) => id.toUpperCase().replace(/-/g, "_");
/** The env var a driver's default login field is read from: SANMAR_USERNAME, ALPHABRODER_PASSWORD. */
export const loginEnvVar = (id: string, key: string) => `${envPrefix(id)}_${key.toUpperCase()}`;
