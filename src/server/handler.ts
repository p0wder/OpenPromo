/**
 * The REST API as one web-standard handler (`Request` → `Response`), so the
 * same code runs on Vercel, Node, Docker, Deno or Bun. JSON in and out,
 * money in cents. Nothing here names a supplier: every route is the same for
 * all of them, and what only one supplier does is that driver's route. It
 * asks a supplier only when a caller asks: no polling, no background jobs.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { OpenPromoError, type OpenPromoErrorKind } from "../errors.js";
import type { InvoiceQuery, MediaType, PriceType } from "../promostandards/types.js";
import { CAPABILITIES, type Capability, type DriverRoute, type SupplierConnection } from "../suppliers/driver.js";
import { connectionFor, environmentHeader, mayOrder, ordersOffMessage, type ServerConfig, type SupplierDef } from "./config.js";
import { openApiDocument } from "./openapi.js";

export const VERSION = "0.2.0";

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
  // The supplier turned down the login or request: a failed dependency, not the caller's fault.
  auth: 424,
  not_enabled: 424,
  refused: 424,
  rate_limited: 429,
  bad_response: 502,
  unreachable: 504,
};

type ErrorKind = keyof typeof STATUS;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (kind: ErrorKind, message: string, extra: Record<string, unknown> = {}) => json(STATUS[kind], { error: { kind, message, ...extra } });

const digest = (s: string) => createHash("sha256").update(s).digest();
function authorized(req: Request, keys: readonly string[]): boolean {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  if (!m) return false;
  const given = digest(m[1]!.trim());
  return keys.some((k) => timingSafeEqual(given, digest(k)));
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
const MEDIA_TYPES = new Set(["Image", "Video", "Audio", "Document"]);

/** A driver route's `:name` segments against the path, or null when it doesn't match. */
function matchRoute(pattern: string, rest: readonly string[]): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  if (want.length !== rest.length) return null;
  const params: Record<string, string> = {};
  for (const [i, seg] of want.entries()) {
    if (seg.startsWith(":")) params[seg.slice(1)] = rest[i]!;
    else if (seg !== rest[i]) return null;
  }
  return params;
}

/** Whether a supplier has a route that places orders (OPENPROMO_ORDERS still decides whether this server lets it). */
export const takesOrders = (def: SupplierDef) => (def.driver.routes ?? []).some((r) => r.write);

/** What the supplier list says about one supplier: never a login, only which headers carry one. */
export function describeSupplier(def: SupplierDef, config: Pick<ServerConfig, "orders">, detail = false) {
  const { driver } = def;
  const allowed = mayOrder(config, def.id);
  return {
    id: def.id,
    name: def.name,
    kind: driver.kind,
    capabilities: driver.capabilities,
    loginHeaders: driver.login.map((f) => f.header),
    defaultLogin: !!def.defaultLogin,
    environment: def.environment,
    ...(detail
      ? {
          login: driver.login.map((f) => ({ header: f.header, label: f.label })),
          environments: driver.environments,
          environmentHeader: environmentHeader(driver),
          // Whether this supplier may place real orders on this server (OPENPROMO_ORDERS).
          ordersAllowed: allowed,
          routes: (driver.routes ?? []).map((r) => ({ method: r.method, path: `/v1/${def.id}/${r.path}`, summary: r.summary, ...(r.write ? { write: true, allowed } : {}) })),
          ...(driver.website ? { website: driver.website } : {}),
          ...(driver.notes ? { notes: driver.notes } : {}),
        }
      : {}),
  };
}

export interface HandlerOptions {
  /** Called once per request with what happened (never bodies, logins or keys). */
  log?: (line: { method: string; path: string; status: number; ms: number }) => void;
}

/** The whole API. */
export function createHandler(config: ServerConfig, opts: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const log = opts.log ?? ((l) => console.info(`${l.method} ${l.path} ${l.status} ${l.ms}ms`));
  const counts = { suppliers: config.suppliers.size };

  async function route(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method.toUpperCase();

    if (method === "GET" && (parts.length === 0 || (parts.length === 1 && parts[0] === "health"))) return json(200, { ok: true, name: "OpenPromo", version: VERSION, ...counts });
    if (method === "GET" && parts.length === 1 && parts[0] === "openapi.json") return json(200, openApiDocument(url.origin, config));
    if (parts[0] !== "v1") return fail("unknown_route", `No route ${method} ${url.pathname}. See /openapi.json.`);
    if (!authorized(req, config.apiKeys)) return fail("unauthorized", "Send your OpenPromo API key as `Authorization: Bearer <key>`.");

    // GET /v1/suppliers[?search=&capability=&kind=], GET /v1/suppliers/:id
    if (method === "GET" && parts[1] === "suppliers") {
      if (parts.length === 3) {
        const def = config.suppliers.get(parts[2]!);
        return def ? json(200, describeSupplier(def, config, true)) : fail("unknown_supplier", `No supplier "${parts[2]}" on this server. See GET /v1/suppliers.`);
      }
      if (parts.length === 2) {
        const words = (url.searchParams.get("search") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const capability = url.searchParams.get("capability");
        const kind = url.searchParams.get("kind");
        // `orders` isn't a capability (capabilities drive the shared GET routes): it means the supplier has a write route
        // (SanMar's and S&S's own, or `orders` for a PromoStandards supplier listing PO 1.0.0), whether or not this server allows it.
        if (capability && capability !== "orders" && !(CAPABILITIES as readonly string[]).includes(capability)) throw new OpenPromoError("invalid", `capability must be one of ${CAPABILITIES.join(", ")}, orders.`);
        const matches = (s: SupplierDef) => (capability === "orders" ? takesOrders(s) : s.driver.capabilities.includes(capability as Capability));
        const list = [...config.suppliers.values()].filter(
          (s) => (!words.length || words.every((w) => `${s.id} ${s.name}`.toLowerCase().includes(w))) && (!capability || matches(s)) && (!kind || s.driver.kind === kind),
        );
        return json(200, { count: list.length, suppliers: list.map((s) => describeSupplier(s, config)) });
      }
    }

    const def = parts[1] ? config.suppliers.get(parts[1]) : undefined;
    if (!def) return fail("unknown_supplier", `No supplier "${parts[1] ?? ""}" on this server. See GET /v1/suppliers.`);
    const rest = parts.slice(2);

    // What only this supplier does.
    for (const r of (def.driver.routes ?? []) as readonly DriverRoute[]) {
      if (r.method !== method) continue;
      const params = matchRoute(r.path, rest);
      if (!params) continue;
      if (r.write && !mayOrder(config, def.id)) return fail("orders_off", ordersOffMessage(def), { supplier: def.id });
      const connection = connectionFor(def, req.headers, config);
      const answer = await r.handle({
        connection,
        request: req,
        url,
        params,
        env: config.env,
        body: async <T>() => {
          try {
            return (await req.json()) as T;
          } catch {
            throw new OpenPromoError("invalid", "The request body must be JSON.");
          }
        },
      });
      return json(answer.status, answer.body);
    }

    // The shared questions, the same for every supplier.
    const ask = <K extends Capability>(capability: K): NonNullable<SupplierConnection[K]> => {
      const connection = connectionFor(def, req.headers, config);
      const fn = connection[capability];
      if (!fn) throw Object.assign(new OpenPromoError("not_enabled", `${def.name} doesn't offer ${capability} through OpenPromo.`, { supplier: def.id }), { notOffered: true });
      return fn.bind(connection) as NonNullable<SupplierConnection[K]>;
    };
    const offers = (capability: Capability) => def.driver.capabilities.includes(capability);
    const notOffered = (capability: Capability) => fail("not_offered", `${def.name} doesn't offer ${capability} through OpenPromo. See GET /v1/suppliers/${def.id}.`, { supplier: def.id });

    if (method === "GET" && rest[0] === "products" && rest[1] && rest.length <= 3) {
      const id = rest[1];
      if (rest.length === 2) {
        if (!offers("product")) return notOffered("product");
        const product = await ask("product")(id);
        return product ? json(200, product) : fail("not_found", `${def.name} has no product ${id}.`, { supplier: def.id });
      }
      if (rest[2] === "inventory") {
        if (!offers("inventory")) return notOffered("inventory");
        const inv = await ask("inventory")(id, { partIds: url.searchParams.getAll("partId") });
        return inv ? json(200, inv) : fail("not_found", `${def.name} has no product ${id}.`, { supplier: def.id });
      }
      if (rest[2] === "pricing") {
        if (!offers("pricing")) return notOffered("pricing");
        const priceType = url.searchParams.get("priceType") ?? "Net";
        if (!PRICE_TYPES.has(priceType)) throw new OpenPromoError("invalid", "priceType must be Net, List or Customer.");
        const pricing = await ask("pricing")(id, { priceType: priceType as PriceType, partId: url.searchParams.get("partId") ?? undefined, fobId: url.searchParams.get("fobId") ?? undefined });
        return pricing ? json(200, pricing) : fail("not_found", `${def.name} has no product ${id}.`, { supplier: def.id });
      }
      if (rest[2] === "media") {
        if (!offers("media")) return notOffered("media");
        const type = url.searchParams.get("type") ?? "Image";
        if (!MEDIA_TYPES.has(type)) throw new OpenPromoError("invalid", "type must be Image, Video, Audio or Document.");
        const filter = { mediaType: type as MediaType, partId: url.searchParams.get("partId") || undefined, classType: url.searchParams.get("classType") || undefined };
        const media = await ask("media")(id, filter);
        return media ? json(200, media) : fail("not_found", `${def.name} has no product ${id}.`, { supplier: def.id });
      }
    }

    if (method === "GET" && rest[0] === "media" && rest[1] === "changes" && rest.length === 2) {
      if (!offers("mediaChanges")) return notOffered("mediaChanges");
      const since = url.searchParams.get("since") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}/.test(since) || Number.isNaN(Date.parse(since))) throw new OpenPromoError("invalid", "Say since when: ?since=<ISO time>, e.g. 2026-11-01T00:00:00Z.");
      return json(200, { since, productIds: await ask("mediaChanges")(since) });
    }

    if (method === "GET" && rest[0] === "orders" && rest[1] && rest.length <= 3) {
      const po = rest[1];
      if (rest.length === 2) {
        if (!offers("orderStatus")) return notOffered("orderStatus");
        const found = (await ask("orderStatus")({ poNumber: po })).filter((o) => o.purchaseOrderNumber.trim().toLowerCase() === po.trim().toLowerCase());
        const orders = found.flatMap((o) => o.orders);
        return orders.length ? json(200, { purchaseOrderNumber: po, orders }) : fail("not_found", `${def.name} has no order under PO ${po}.`, { supplier: def.id });
      }
      if (rest[2] === "shipments") {
        if (!offers("shipments")) return notOffered("shipments");
        return json(200, { purchaseOrderNumber: po, shipments: await ask("shipments")({ poNumber: po }) });
      }
    }

    if (method === "GET" && rest[0] === "invoices" && rest.length === 1) {
      if (!offers("invoices")) return notOffered("invoices");
      return json(200, { invoices: await ask("invoices")(invoiceQuery(url.searchParams)) });
    }

    return fail("unknown_route", `No route ${method} ${url.pathname}. See GET /v1/suppliers/${def.id} and /openapi.json.`);
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
