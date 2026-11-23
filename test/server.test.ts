import { describe, expect, it } from "vitest";
import { ConfigError, createHandler, loadConfig } from "../src/server/index.js";
import { fakeSoap, fixture } from "./helpers.js";

const KEY = "k".repeat(32);
const ENV = { OPENPROMO_API_KEY: KEY, SANMAR_CUSTOMER_NUMBER: "188646", SANMAR_USERNAME: "webuser", SANMAR_PASSWORD: "pw" };

function server(routes: Parameters<typeof fakeSoap>[0], env: Record<string, string> = {}) {
  const fake = fakeSoap(routes);
  const lines: { method: string; path: string; status: number }[] = [];
  const handler = createHandler(loadConfig({ ...ENV, ...env }, { fetch: fake.fetch }), { log: (l) => lines.push(l) });
  const call = async (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.key !== null) headers.set("Authorization", `Bearer ${init.key ?? KEY}`);
    const res = await handler(new Request(`https://openpromo.test${path}`, { ...init, headers }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, calls: fake.calls, lines };
}

const order = { poNumber: "1042-1", shipTo: { company: "Acme", address1: "12 Main ST", city: "Austin", state: "TX", zip: "78701" }, residential: false, lines: [{ style: "PC54", color: "Jet Black", size: "L", quantity: 12 }] };
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("config", () => {
  it("needs only a long API key; a default SanMar login is optional but all three values together", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ OPENPROMO_API_KEY: "short" })).toThrow(/at least 24/);
    const bare = loadConfig({ OPENPROMO_API_KEY: KEY });
    expect([...bare.suppliers.keys()]).toEqual(["sanmar"]);
    expect(bare.suppliers.get("sanmar")!.defaultLogin).toBeUndefined();
    expect(() => loadConfig({ OPENPROMO_API_KEY: KEY, SANMAR_USERNAME: "x" })).toThrow(/all three/);
    expect(() => loadConfig({ ...ENV, SANMAR_ENVIRONMENT: "test" })).toThrow(/production" or "edev/);
  });

  it("adds any PromoStandards supplier from OPENPROMO_SUPPLIERS, checked", () => {
    const acme = { id: "acme", name: "Acme Promo", endpoints: { inventory: { version: "2.0.0", url: "https://ps.acme.example/inventory" } } };
    const config = loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_SUPPLIERS: JSON.stringify([acme]) });
    expect([...config.suppliers.keys()]).toEqual(["sanmar", "acme"]);
    expect(() => loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_SUPPLIERS: JSON.stringify([{ ...acme, endpoints: { inventory: { version: "9.9.9", url: "http://x" } } }]) })).toThrow(/inventory 9.9.9 isn't supported/);
  });
});

describe("the API", () => {
  it("health and the OpenAPI document are open; everything under /v1 needs the key", async () => {
    const { call } = server({});
    expect(await call("/health", { key: null })).toEqual({ status: 200, body: { ok: true, name: "OpenPromo", suppliers: ["sanmar"] } });
    expect((await call("/openapi.json", { key: null })).body.openapi).toBe("3.1.0");
    expect(await call("/v1/suppliers", { key: null })).toMatchObject({ status: 401, body: { error: { kind: "unauthorized" } } });
    expect(await call("/v1/suppliers", { key: "wrong".repeat(8) })).toMatchObject({ status: 401 });
    expect(await call("/v1/suppliers")).toMatchObject({ status: 200, body: { suppliers: [{ id: "sanmar", environment: "production", sanmarServices: true, orders: false }] } });
  });

  it("serves SanMar products, pricing and inventory; unknown styles are 404", async () => {
    const { call } = server({ getProductInfoByStyleColorSize: fixture("sanmar/product-info.xml"), getPricing: fixture("sanmar/pricing.xml"), GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml") });
    expect(await call("/v1/sanmar/products/PC61")).toMatchObject({ status: 200, body: { style: "PC61", colors: [{ name: "White" }, { name: "Athletic Heather" }] } });
    expect(await call("/v1/sanmar/products/lpc61/pricing")).toMatchObject({ status: 200, body: { style: "LPC61", prices: [{ myPrice: 176, salePrice: 199 }] } });
    expect(await call("/v1/sanmar/products/K420/inventory?partId=92032")).toMatchObject({ status: 200, body: { parts: [{ partId: "92032", available: 1045 }] } });
    const missing = server({ getProductInfoByStyleColorSize: fixture("sanmar/product-info-invalid.xml") });
    expect(await missing.call("/v1/sanmar/products/NOPE")).toMatchObject({ status: 404, body: { error: { kind: "not_found" } } });
  });

  it("order status, shipments and invoices; nothing yet is a 404 or an empty list, not an error", async () => {
    const notYet = fixture("promostandards/error-301.xml");
    const { call } = server({
      GetOrderStatusRequest: fixture("promostandards/order-status-2.0.0.xml"),
      GetOrderShipmentNotificationRequest: notYet.replaceAll("GetInvoicesResponse", "GetOrderShipmentNotificationResponse"),
      GetInvoicesRequest: fixture("promostandards/invoices-1.0.0.xml"),
    });
    expect(await call("/v1/sanmar/orders/SS3820")).toMatchObject({ status: 200, body: { purchaseOrderNumber: "SS3820", orders: [{ salesOrderNumber: "100267568", state: "received", onHold: true }] } });
    expect(await call("/v1/sanmar/orders/OTHER")).toMatchObject({ status: 404, body: { error: { kind: "not_found" } } });
    expect(await call("/v1/sanmar/orders/SS3820/shipments")).toEqual({ status: 200, body: { purchaseOrderNumber: "SS3820", shipments: [] } });
    expect(await call("/v1/sanmar/invoices?po=112233445")).toMatchObject({ status: 200, body: { invoices: [{ invoiceNumber: "123456798", total: 1567 }] } });
    expect(await call("/v1/sanmar/invoices")).toMatchObject({ status: 400, body: { error: { kind: "invalid" } } });
  });

  it("supplier failures map to statuses with the supplier's words", async () => {
    const auth = server({ GetInventoryLevelsRequest: fixture("promostandards/error-105.xml").replaceAll("GetOrderStatusResponse", "GetInventoryLevelsResponse") });
    expect(await auth.call("/v1/sanmar/products/PC54/inventory")).toMatchObject({ status: 424, body: { error: { kind: "auth", code: "105", supplier: "sanmar", detail: "Authentication Credentials failed" } } });
    const down = server({ GetInventoryLevelsRequest: { status: 504, body: "" } });
    expect(await down.call("/v1/sanmar/products/PC54/inventory")).toMatchObject({ status: 504, body: { error: { kind: "unreachable" } } });
    expect(await down.call("/v1/acme/products/X")).toMatchObject({ status: 404, body: { error: { kind: "unknown_supplier" } } });
  });

  it("previews a SanMar order, and refuses an order SanMar can't take before sending", async () => {
    const { call, calls } = server({ getPreSubmitInfo: fixture("sanmar/presubmit-short.xml") });
    expect(await call("/v1/sanmar/orders/preview", post({ ...order, lines: [{ style: "K420", color: "Black", size: "S", quantity: 900 }] }))).toMatchObject({ status: 200, body: { ok: false, lines: [{ status: "short" }] } });
    expect(await call("/v1/sanmar/orders/preview", post({ ...order, shipTo: { ...order.shipTo, zip: "7" } }))).toMatchObject({ status: 400, body: { error: { kind: "invalid", detail: expect.stringMatching(/ZIP/) } } });
    expect(calls).toHaveLength(1);
  });

  it("placing orders is off by default; on, it looks the PO up first and never orders twice", async () => {
    const off = server({ submitPO: fixture("sanmar/submit-ok.xml") });
    expect(await off.call("/v1/sanmar/orders", post(order))).toMatchObject({ status: 403, body: { error: { kind: "orders_off" } } });
    expect(off.calls).toHaveLength(0);

    const notThere = fixture("promostandards/error-301.xml").replaceAll("GetInvoicesResponse", "GetOrderStatusResponse");
    const on = server({ GetOrderStatusRequest: notThere, submitPO: fixture("sanmar/submit-ok.xml") }, { OPENPROMO_ORDERS: "on" });
    expect(await on.call("/v1/sanmar/orders", post(order))).toMatchObject({ status: 201, body: { accepted: true, poNumber: "1042-1" } });
    expect(on.calls.map((c) => c.operation)).toEqual(["GetOrderStatusRequest", "submitPO"]);

    const dup = server({ GetOrderStatusRequest: fixture("promostandards/order-status-2.0.0.xml"), submitPO: fixture("sanmar/submit-ok.xml") }, { OPENPROMO_ORDERS: "on" });
    expect(await dup.call("/v1/sanmar/orders", post({ ...order, poNumber: "SS3820" }))).toMatchObject({ status: 409, body: { error: { kind: "duplicate", orders: [{ salesOrderNumber: "100267568" }] } } });
    expect(dup.calls.map((c) => c.operation)).toEqual(["GetOrderStatusRequest"]);
  });

  it("logs method, path, status and time only", async () => {
    const { call, lines } = server({});
    await call("/v1/suppliers");
    expect(lines).toEqual([{ method: "GET", path: "/v1/suppliers", status: 200, ms: expect.any(Number) }]);
  });

  it("is a pass-through: each request brings its own login in headers, nothing is kept or logged", async () => {
    const fake = fakeSoap({ GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml"), getProductInfoByStyleColorSize: fixture("sanmar/product-info.xml") });
    const lines: unknown[] = [];
    const handler = createHandler(loadConfig({ OPENPROMO_API_KEY: KEY }, { fetch: fake.fetch }), { log: (l) => lines.push(l) });
    const ask = async (path: string, headers: Record<string, string> = {}) => {
      const res = await handler(new Request(`https://openpromo.test${path}`, { headers: { Authorization: `Bearer ${KEY}`, ...headers } }));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const shopA = { "X-SanMar-Customer-Number": "111", "X-SanMar-Username": "shop-a", "X-SanMar-Password": "pw-a" };
    const shopB = { "X-SanMar-Customer-Number": "222", "X-SanMar-Username": "shop-b", "X-SanMar-Password": "pw-b" };

    // No login on the request and none on the server: say which headers to send.
    expect(await ask("/v1/sanmar/products/PC54/inventory")).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/X-SanMar-Customer-Number, X-SanMar-Username and X-SanMar-Password/) } } });
    expect(await ask("/v1/sanmar/products/PC54/inventory", { "X-SanMar-Username": "only-this" })).toMatchObject({ status: 400 });
    expect(fake.calls).toHaveLength(0);

    // Two accounts, one after the other, each on its own login.
    expect(await ask("/v1/sanmar/products/K420/inventory", shopA)).toMatchObject({ status: 200, body: { parts: [{ partId: "92032" }] } });
    expect(await ask("/v1/sanmar/products/PC61", shopB)).toMatchObject({ status: 200, body: { style: "PC61" } });
    expect(fake.calls[0]!.xml).toContain("<shar:id>shop-a</shar:id><shar:password>pw-a</shar:password>");
    expect(fake.calls[1]!.xml).toContain("<sanMarCustomerNumber>222</sanMarCustomerNumber><sanMarUserName>shop-b</sanMarUserName><sanMarUserPassword>pw-b</sanMarUserPassword>");
    // EDEV per request.
    await ask("/v1/sanmar/products/K420/inventory", { ...shopA, "X-SanMar-Environment": "edev" });
    expect(new URL(fake.calls[2]!.url).host).toBe("edev-ws.sanmar.com:8080");
    expect(JSON.stringify(lines)).not.toMatch(/pw-a|pw-b|shop-a|shop-b/);

    // The supplier list says which headers to send, never a login.
    const list = await ask("/v1/suppliers");
    expect(list.body.suppliers[0]).toMatchObject({ id: "sanmar", defaultLogin: false, loginHeaders: ["X-SanMar-Customer-Number", "X-SanMar-Username", "X-SanMar-Password"] });
  });

  it("a request's login wins over the server's default one", async () => {
    const { call, calls } = server({ GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml") });
    await call("/v1/sanmar/products/K420/inventory", { headers: { "X-SanMar-Customer-Number": "9", "X-SanMar-Username": "other", "X-SanMar-Password": "x" } });
    await call("/v1/sanmar/products/K420/inventory");
    expect(calls.map((c) => /<shar:id>([^<]*)</.exec(c.xml)?.[1])).toEqual(["other", "webuser"]);
  });
});
