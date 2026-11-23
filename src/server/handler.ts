/**
 * The REST API as one web-standard handler (`Request` → `Response`), so the
 * same code runs on Vercel, Node, Docker, Deno or Bun. JSON in and out,
 * money in cents. It asks a supplier only when a caller asks: no polling,
 * no background jobs.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { OpenPromoError, type OpenPromoErrorKind } from "../errors.js";
import type { InvoiceQuery, PriceType } from "../promostandards/types.js";
import type { SanmarOrder } from "../sanmar/order.js";
import type { ServerConfig, SupplierEntry } from "./config.js";
import { openApiDocument } from "./openapi.js";

const STATUS: Record<OpenPromoErrorKind | "unauthorized" | "unknown_route" | "unknown_supplier" | "not_offered" | "orders_off" | "duplicate", number> = {
  invalid: 400,
  unauthorized: 401,
  orders_off: 403,
  not_found: 404,
  not_yet: 404,
  unknown_route: 404,
  unknown_supplier: 404,
  not_offered: 404,
  duplicate: 409,
  // The supplier turned down this server's login or request: a failed dependency, not the caller's fault.
  auth: 424,
  not_enabled: 424,
  refused: 424,
  rate_limited: 429,
  bad_response: 502,
  unreachable: 504,
};

type ErrorKind = keyof typeof STATUS;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

const fail = (kind: ErrorKind, message: string, extra: Record<string, unknown> = {}) => json(STATUS[kind], { error: { kind, message, ...extra } });

const digest = (s: string) => createHash("sha256").update(s).digest();
function authorized(req: Request, keys: readonly string[]): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const given = digest(m[1]!.trim());
  return keys.some((k) => timingSafeEqual(given, digest(k)));
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new OpenPromoError("invalid", "The request body must be JSON.");
  }
}

function invoiceQuery(params: URLSearchParams): InvoiceQuery {
  const po = params.get("po");
  const invoice = params.get("invoice");
  const date = params.get("date");
  const since = params.get("since");
  if (po) return { poNumber: po };
  if (invoice) return { invoiceNumber: invoice };
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new OpenPromoError("invalid", "date must look like 2026-11-20.");
    return { invoiceDate: date };
  }
  if (since) return { availableSince: since };
  throw new OpenPromoError("invalid", "Say which invoices: ?po=, ?invoice=, ?date=YYYY-MM-DD or ?since=<ISO time>.");
}

const PRICE_TYPES = new Set(["Net", "List", "Customer"]);

export interface HandlerOptions {
  /** Called once per request with what happened (never bodies, logins or keys). */
  log?: (line: { method: string; path: string; status: number; ms: number }) => void;
}

/** The whole API. */
export function createHandler(config: ServerConfig, opts: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const log = opts.log ?? ((l) => console.info(`${l.method} ${l.path} ${l.status} ${l.ms}ms`));

  async function route(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method.toUpperCase();

    if (method === "GET" && (parts.length === 0 || (parts.length === 1 && parts[0] === "health"))) return json(200, { ok: true, name: "OpenPromo", suppliers: [...config.suppliers.keys()] });
    if (method === "GET" && parts.length === 1 && parts[0] === "openapi.json") return json(200, openApiDocument(url.origin));
    if (parts[0] !== "v1") return fail("unknown_route", `No route ${method} ${url.pathname}. See /openapi.json.`);
    if (!authorized(req, config.apiKeys)) return fail("unauthorized", "Send your OpenPromo API key as `Authorization: Bearer <key>`.");

    if (method === "GET" && parts.length === 2 && parts[1] === "suppliers") {
      return json(200, { suppliers: [...config.suppliers.values()].map((s) => ({ id: s.id, name: s.name, environment: s.environment, services: s.services, sanmarServices: !!s.sanmar, orders: !!s.sanmar && config.allowOrders })) });
    }

    const supplierId = parts[1];
    const s: SupplierEntry | undefined = supplierId ? config.suppliers.get(supplierId) : undefined;
    if (!s) return fail("unknown_supplier", `No supplier "${supplierId ?? ""}" on this server. Configured: ${[...config.suppliers.keys()].join(", ")}.`);
    const rest = parts.slice(2);
    const ps = s.promoStandards;
    const needs = (service: Parameters<typeof ps.has>[0]) => {
      if (!ps.has(service)) throw Object.assign(new OpenPromoError("not_enabled", `${s.name} has no ${service} service on this server.`), { notOffered: true });
    };

    // GET /v1/:supplier/products/:id[/inventory|/pricing]
    if (method === "GET" && rest[0] === "products" && rest[1]) {
      const id = rest[1];
      if (rest.length === 2) {
        const product = s.sanmar ? await s.sanmar.productInfo(id) : (needs("productData"), await ps.getProduct(id));
        return product ? json(200, product) : fail("not_found", `${s.name} has no product ${id}.`);
      }
      if (rest.length === 3 && rest[2] === "inventory") {
        needs("inventory");
        const partIds = url.searchParams.getAll("partId");
        const inv = await ps.getInventory(id, partIds.length ? { partIds } : {});
        return inv ? json(200, inv) : fail("not_found", `${s.name} has no product ${id}.`);
      }
      if (rest.length === 3 && rest[2] === "pricing") {
        const priceType = url.searchParams.get("priceType");
        if (s.sanmar && !priceType) return json(200, { style: id.toUpperCase(), prices: await s.sanmar.pricing(id) });
        if (priceType && !PRICE_TYPES.has(priceType)) throw new OpenPromoError("invalid", "priceType must be Net, List or Customer.");
        needs("pricing");
        const pricing = await ps.getPricing(id, { priceType: (priceType as PriceType | null) ?? "Net", partId: url.searchParams.get("partId") ?? undefined, fobId: url.searchParams.get("fobId") ?? undefined });
        return pricing ? json(200, pricing) : fail("not_found", `${s.name} has no product ${id}.`);
      }
    }

    // GET /v1/:supplier/orders/:po[/shipments]
    if (method === "GET" && rest[0] === "orders" && rest[1] && rest.length <= 3) {
      const po = rest[1];
      if (rest.length === 2) {
        needs("orderStatus");
        const found = (await ps.getOrderStatus({ poNumber: po })).filter((o) => o.purchaseOrderNumber.trim().toLowerCase() === po.trim().toLowerCase());
        const orders = found.flatMap((o) => o.orders);
        return orders.length ? json(200, { purchaseOrderNumber: po, orders }) : fail("not_found", `${s.name} has no order under PO ${po}.`);
      }
      if (rest[2] === "shipments") {
        needs("shipments");
        return json(200, { purchaseOrderNumber: po, shipments: await ps.getShipments({ poNumber: po }) });
      }
    }

    // GET /v1/:supplier/invoices?po=|invoice=|date=|since=
    if (method === "GET" && rest[0] === "invoices" && rest.length === 1) {
      needs("invoices");
      return json(200, { invoices: await ps.getInvoices(invoiceQuery(url.searchParams)) });
    }

    // POST /v1/sanmar/orders/preview, POST /v1/sanmar/orders
    if (method === "POST" && rest[0] === "orders" && s.sanmar) {
      const options = { warehouseSelection: config.sanmarWarehouseSelection };
      if (rest.length === 2 && rest[1] === "preview") return json(200, await s.sanmar.preSubmitOrder(await body<SanmarOrder>(req), options));
      if (rest.length === 1) {
        if (!config.allowOrders) return fail("orders_off", "Placing orders is switched off on this server. Set OPENPROMO_ORDERS=on to allow it.");
        const order = await body<SanmarOrder>(req);
        // Never order twice: if SanMar already has a live order under this PO number, say so instead.
        const existing = (await ps.getOrderStatus({ poNumber: String(order.poNumber ?? "") })).flatMap((o) => o.orders).filter((o) => o.state !== "cancelled");
        if (existing.length) return fail("duplicate", `SanMar already has an order under PO ${order.poNumber}. Nothing was sent.`, { orders: existing });
        return json(201, await s.sanmar.submitOrder(order, options));
      }
    }

    return fail("unknown_route", `No route ${method} ${url.pathname}. See /openapi.json.`);
  }

  return async (req: Request) => {
    const started = Date.now();
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(req, url);
    } catch (e) {
      if (e instanceof OpenPromoError) {
        const kind: ErrorKind = (e as OpenPromoError & { notOffered?: boolean }).notOffered ? "not_offered" : e.kind;
        res = fail(kind, e.message, { supplier: e.supplier, detail: e.detail, code: e.code });
      } else {
        console.error(e);
        res = json(500, { error: { kind: "internal", message: "Something went wrong in OpenPromo. Check the server log." } });
      }
    }
    log({ method: req.method, path: url.pathname, status: res.status, ms: Date.now() - started });
    return res;
  };
}
