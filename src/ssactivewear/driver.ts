/**
 * S&S Activewear as a driver: its REST API v2 answering the shared questions
 * in the shared shapes, plus what only S&S does (its styles catalog, its raw
 * products, placing orders) as driver routes.
 */
import { OpenPromoError } from "../errors.js";
import type { InvoiceQuery, OrderQuery } from "../promostandards/types.js";
import { SS_ORDER_SCHEMA } from "../server/schemas.js";
import { errorAnswer, liveOrdersUnder, type SupplierConnection, type SupplierDriver } from "../suppliers/driver.js";
import { SsActivewearClient, type SsActivewearClientOptions } from "./client.js";
import { ssInventory, ssInvoices, ssOrderStatus, ssPricing, ssProduct, ssShipments } from "./map.js";
import { placeSsOrder, type SsOrderInput } from "./order.js";
import type { SsOrder, SsStyle } from "./types.js";

export interface SsActivewearConnection extends Required<SupplierConnection> {
  ss: SsActivewearClient;
}

const same = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

/** The shared questions answered from S&S on one client. A product id is S&S's numeric style id (or a part number or "Brand Style", resolved first). */
export function ssActivewearConnection(ss: SsActivewearClient): SsActivewearConnection {
  const styleOf = async (productId: string): Promise<SsStyle | null> => ss.style(productId);
  const styleIdOf = async (productId: string): Promise<string | null> => (/^\d+$/.test(productId.trim()) ? productId.trim() : ((await styleOf(productId))?.styleID?.toString() ?? null));
  const ordersFor = async (query: OrderQuery): Promise<SsOrder[]> => {
    if ("poNumber" in query) return ss.ordersByPo(query.poNumber, { lines: true });
    if ("salesOrderNumber" in query) return (await ss.orders(query.salesOrderNumber, { lines: true })).filter((o) => same(o.orderNumber, query.salesOrderNumber));
    throw new OpenPromoError("invalid", "S&S can't list orders changed since a time. Ask by PO number or S&S order number.", { supplier: "ssactivewear" });
  };
  return {
    ss,
    async product(productId) {
      const style = await styleOf(productId);
      return style ? ssProduct(style, await ss.products(style.styleID)) : null;
    },
    async inventory(productId, filter) {
      const id = await styleIdOf(productId);
      const products = id ? await ss.products(id) : [];
      return products.length ? ssInventory(id!, products, filter.partIds) : null;
    },
    async pricing(productId, opts) {
      const id = await styleIdOf(productId);
      const products = id ? await ss.products(id) : [];
      return products.length ? ssPricing(id!, products, opts.priceType, { partId: opts.partId }) : null;
    },
    orderStatus: async (query) => ssOrderStatus(await ordersFor(query)),
    shipments: async (query) => ssShipments(await ordersFor(query)),
    async invoices(query: InvoiceQuery) {
      if ("poNumber" in query) return ssInvoices(await ss.ordersByPo(query.poNumber, { lines: true }));
      if ("invoiceNumber" in query) return ssInvoices((await ss.orders(query.invoiceNumber, { lines: true })).filter((o) => same(o.invoiceNumber, query.invoiceNumber)));
      if ("invoiceDate" in query) return ssInvoices(await ss.ordersInvoiced(query.invoiceDate, query.invoiceDate));
      return ssInvoices(await ss.ordersInvoiced(query.availableSince.slice(0, 10), today()));
    },
  };
}

/** Words in a style's brand, number, title or part number: a quick filter on the catalog for callers that don't keep their own. */
function matches(style: SsStyle, words: string[]) {
  const hay = `${style.brandName} ${style.styleName} ${style.title} ${style.partNumber ?? ""} ${style.baseCategory ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const ssActivewearDriver: SupplierDriver<SsActivewearConnection> = {
  id: "ssactivewear",
  name: "S&S Activewear",
  kind: "native",
  capabilities: ["product", "inventory", "pricing", "orderStatus", "shipments", "invoices"],
  login: [
    { key: "account_number", header: "X-Supplier-Id", label: "S&S account number" },
    { key: "api_key", header: "X-Supplier-Password", label: "S&S API key" },
  ],
  environments: ["production"],
  website: "https://api.ssactivewear.com/V2/Default.aspx",
  notes: "Product ids are S&S style ids (numeric, from GET /v1/ssactivewear/native/styles); part ids are S&S SKUs. Prices: Customer and Net are the account's own price, List is S&S's list price. Canadian accounts are found automatically (api.ssactivewear.ca).",
  connect(login, opts) {
    const options: SsActivewearClientOptions = { fetch: opts.fetch };
    return ssActivewearConnection(new SsActivewearClient({ accountNumber: login.account_number ?? "", apiKey: login.api_key ?? "" }, options));
  },
  routes: [
    {
      method: "GET",
      path: "native/styles",
      summary: "S&S's styles catalog (several thousand; S&S asks for it once a day). ?search= keeps styles whose brand, number or title has every word; ?limit= caps the list.",
      async handle({ connection, url }) {
        const words = (url.searchParams.get("search") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
        const styles = (await connection.ss.styles()).filter((s) => !words.length || matches(s, words));
        return { status: 200, body: { styles: limit ? styles.slice(0, limit) : styles } };
      },
    },
    {
      method: "GET",
      path: "native/products/:styleId",
      summary: "S&S's own products answer for a style: every SKU with S&S's field names, prices in dollars and stock per warehouse",
      async handle({ connection, params }) {
        const products = await connection.ss.products(params.styleId!);
        return products.length ? { status: 200, body: { styleId: params.styleId, products } } : errorAnswer(404, "not_found", `S&S has no style ${params.styleId}.`, { supplier: "ssactivewear" });
      },
    },
    {
      method: "POST",
      path: "orders",
      summary: "Place an S&S order (POST /v2/orders/). Refused with 409 when S&S already has a live order under the PO number.",
      write: true,
      requestSchema: SS_ORDER_SCHEMA,
      async handle({ connection, body }) {
        const order = await body<SsOrderInput>();
        const existing = await liveOrdersUnder(connection, String(order?.poNumber ?? ""));
        if (existing.length) return errorAnswer(409, "duplicate", `S&S already has an order under PO ${order.poNumber}. Nothing was sent.`, { supplier: "ssactivewear", orders: existing });
        return { status: 201, body: await placeSsOrder(connection.ss, order) };
      },
    },
  ],
};
