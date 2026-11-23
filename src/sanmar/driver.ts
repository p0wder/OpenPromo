/**
 * SanMar as a driver. The shared questions are answered by SanMar's
 * PromoStandards services, so part ids match across product, stock, prices,
 * orders and invoices. SanMar's own services are driver routes: Product Info
 * (colors, images, standard prices), its price list with `myPrice` (the
 * account's own price), and the PO service (check and place orders).
 */
import { SANMAR_ORDER_SCHEMA } from "../server/schemas.js";
import { errorAnswer, liveOrdersUnder, type SupplierConnection, type SupplierDriver } from "../suppliers/driver.js";
import { promoStandardsConnection } from "../suppliers/promostandards.js";
import { SanmarClient, type SanmarEnvironment, type SanmarOrder } from "./index.js";

export interface SanmarConnection extends SupplierConnection {
  sanmar: SanmarClient;
}

const yes = (v: string | null | undefined) => /^(1|true|on|yes)$/i.test(v ?? "");

/** SanMar sets this up per account: lines may name a warehouse, and will call is allowed. A request's header wins over the server's default. */
const warehouseSelection = (request: Request, env: Record<string, string | undefined>) => {
  const h = request.headers.get("x-sanmar-warehouse-selection");
  return { warehouseSelection: h === null ? yes(env.SANMAR_WAREHOUSE_SELECTION) : yes(h) };
};

export const sanmarDriver: SupplierDriver<SanmarConnection> = {
  id: "sanmar",
  name: "SanMar",
  kind: "native",
  capabilities: ["product", "inventory", "pricing", "orderStatus", "shipments", "invoices"],
  login: [
    { key: "customer_number", header: "X-SanMar-Customer-Number", label: "SanMar customer number" },
    { key: "username", header: "X-SanMar-Username", label: "sanmar.com web-services user" },
    { key: "password", header: "X-SanMar-Password", label: "sanmar.com password" },
  ],
  environments: ["production", "edev"],
  environmentHeader: "X-SanMar-Environment",
  website: "https://www.sanmar.com/resources/electronicintegration/webservicesintegration",
  notes: "EDEV (SanMar's test environment) has its own logins. Send X-SanMar-Warehouse-Selection: on if SanMar set the account up for Warehouse Selection.",
  connect(login, opts) {
    const sanmar = new SanmarClient(
      { customerNumber: login.customer_number ?? "", username: login.username ?? "", password: login.password ?? "" },
      { environment: opts.environment as SanmarEnvironment, fetch: opts.fetch },
    );
    return { ...promoStandardsConnection(sanmar.promoStandards()), sanmar };
  },
  routes: [
    {
      method: "GET",
      path: "native/product-info/:style",
      summary: "SanMar Product Info: every color and size of a style, with images, inventory keys and SanMar's standard prices",
      async handle({ connection, params }) {
        const product = await connection.sanmar.productInfo(params.style!);
        return product ? { status: 200, body: product } : errorAnswer(404, "not_found", `SanMar has no style ${params.style}.`, { supplier: "sanmar" });
      },
    },
    {
      method: "GET",
      path: "native/pricing/:style",
      summary: "SanMar's Pricing service for a style: piece, case, sale and incentive prices, and myPrice (the account's own)",
      async handle({ connection, params, url }) {
        const filter = { color: url.searchParams.get("color") ?? undefined, size: url.searchParams.get("size") ?? undefined };
        return { status: 200, body: { style: params.style!.toUpperCase(), prices: await connection.sanmar.pricing(params.style!, filter) } };
      },
    },
    {
      method: "POST",
      path: "orders/preview",
      summary: "Check a SanMar order without placing it (getPreSubmitInfo): per line ok, short or not_found, and the warehouse",
      requestSchema: SANMAR_ORDER_SCHEMA,
      async handle({ connection, request, env, body }) {
        return { status: 200, body: await connection.sanmar.preSubmitOrder(await body<SanmarOrder>(), warehouseSelection(request, env)) };
      },
    },
    {
      method: "POST",
      path: "orders",
      summary: "Place a SanMar order (submitPO). Refused with 409 when SanMar already has a live order under the PO number.",
      write: true,
      requestSchema: SANMAR_ORDER_SCHEMA,
      async handle({ connection, request, env, body }) {
        const order = await body<SanmarOrder>();
        const existing = await liveOrdersUnder(connection, String(order.poNumber ?? ""));
        if (existing.length) return errorAnswer(409, "duplicate", `SanMar already has an order under PO ${order.poNumber}. Nothing was sent.`, { supplier: "sanmar", orders: existing });
        return { status: 201, body: await connection.sanmar.submitOrder(order, warehouseSelection(request, env)) };
      },
    },
  ],
};
