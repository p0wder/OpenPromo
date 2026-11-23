import { describe, expect, it } from "vitest";
import { buildDirectory, DIRECTORY, loginEnvVar, NATIVE_DRIVERS, supplierDrivers } from "../src/index.js";
import { ConfigError, createHandler, loadConfig } from "../src/server/index.js";
import { SS_ORDERS, SS_PO, SS_PRODUCTS, SS_STYLE, SS_STYLES } from "./fixtures/ssactivewear.js";
import { basicUser, fakeRest, fakeSoap, fixture } from "./helpers.js";

const KEY = "k".repeat(32);
const SANMAR = { SANMAR_CUSTOMER_NUMBER: "188646", SANMAR_USERNAME: "webuser", SANMAR_PASSWORD: "pw" };
const ENV = { OPENPROMO_API_KEY: KEY, ...SANMAR };
const US = "api.ssactivewear.com/v2";
const SS_LOGIN = { "X-Supplier-Id": "123456", "X-Supplier-Password": "kit-key" };

function serve(fetchImpl: typeof fetch, env: Record<string, string> = {}) {
  const lines: { method: string; path: string; status: number }[] = [];
  const handler = createHandler(loadConfig({ ...ENV, ...env }, { fetch: fetchImpl }), { log: (l) => lines.push(l) });
  const call = async (path: string, init: RequestInit & { key?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.key !== null) headers.set("Authorization", `Bearer ${init.key ?? KEY}`);
    const res = await handler(new Request(`https://openpromo.test${path}`, { ...init, headers }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, lines };
}
function server(routes: Parameters<typeof fakeSoap>[0], env: Record<string, string> = {}) {
  const fake = fakeSoap(routes);
  return { ...serve(fake.fetch, env), calls: fake.calls };
}
function ssServer(routes: Parameters<typeof fakeRest>[0], env: Record<string, string> = {}) {
  const fake = fakeRest(routes);
  return { ...serve(fake.fetch, env), calls: fake.calls };
}

const order = { poNumber: "1042-1", shipTo: { company: "Acme", address1: "12 Main ST", city: "Austin", state: "TX", zip: "78701" }, residential: false, lines: [{ style: "PC54", color: "Jet Black", size: "L", quantity: 12 }] };
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

describe("config", () => {
  it("needs only a long API key; a default login is optional but every field of it together", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ OPENPROMO_API_KEY: "short" })).toThrow(/at least 24/);
    const bare = loadConfig({ OPENPROMO_API_KEY: KEY });
    expect([...bare.suppliers.keys()].slice(0, 2)).toEqual(["sanmar", "ssactivewear"]);
    expect(bare.suppliers.get("sanmar")!.defaultLogin).toBeUndefined();
    expect(() => loadConfig({ OPENPROMO_API_KEY: KEY, SANMAR_USERNAME: "x" })).toThrow(/SANMAR_CUSTOMER_NUMBER, SANMAR_USERNAME, SANMAR_PASSWORD/);
    expect(() => loadConfig({ ...ENV, SANMAR_ENVIRONMENT: "test" })).toThrow(/"production" or "edev"/);
    // One naming rule for every supplier's default login.
    const ss = loadConfig({ OPENPROMO_API_KEY: KEY, SSACTIVEWEAR_ACCOUNT_NUMBER: "1", SSACTIVEWEAR_API_KEY: "k" });
    expect(ss.suppliers.get("ssactivewear")!.defaultLogin).toEqual({ account_number: "1", api_key: "k" });
    expect(loginEnvVar("alpha-broder", "id")).toBe("ALPHA_BRODER_ID");
  });

  it("adds any PromoStandards supplier from OPENPROMO_SUPPLIERS, checked; a written driver's id can't be taken", () => {
    const acme = { id: "acme", name: "Acme Promo", endpoints: { inventory: { version: "2.0.0", url: "https://ps.acme.example/inventory" } } };
    const config = loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_SUPPLIERS: JSON.stringify([acme]) });
    expect(config.suppliers.get("acme")).toMatchObject({ name: "Acme Promo", environment: "production" });
    expect(config.suppliers.get("acme")!.driver.capabilities).toEqual(["inventory"]);
    expect(() => loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_SUPPLIERS: JSON.stringify([{ ...acme, endpoints: { inventory: { version: "9.9.9", url: "http://x" } } }]) })).toThrow(/inventory 9.9.9 isn't supported/);
    expect(() => loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_SUPPLIERS: JSON.stringify([{ ...acme, id: "sanmar" }]) })).toThrow(/has its own driver/);
  });

  it("OPENPROMO_ENABLED_SUPPLIERS keeps just those", () => {
    expect([...loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_ENABLED_SUPPLIERS: "ssactivewear" }).suppliers.keys()]).toEqual(["ssactivewear"]);
    expect(() => loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_ENABLED_SUPPLIERS: "nobody" })).toThrow(/doesn't have: nobody/);
  });
});

describe("the registry", () => {
  it("written drivers win over the directory; directory entries need no code", () => {
    const directory = buildDirectory(
      [
        { id: "sanmar", name: "SanMar (directory)", endpoints: { inventory: { version: "2.0.0", url: "https://x.example/inv" } } },
        { id: "acme", name: "Acme", endpoints: { inventory: { version: "2.0.0", url: "https://acme.example/inv" }, orderStatus: { version: "1.0.0", url: "https://acme.example/os" } } },
        { id: "gone", name: "Gone", endpoints: {} },
      ],
      { patch: { acme: { endpoints: { orderStatus: { version: "2.0.0", url: "https://acme.example/os2" } } } }, add: [{ id: "extra", name: "Extra", endpoints: {} }], skip: { gone: "left PromoStandards" } },
    );
    expect(directory.map((d) => d.id)).toEqual(["acme", "extra", "sanmar"]);
    expect(directory[0]!.endpoints).toEqual({ inventory: { version: "2.0.0", url: "https://acme.example/inv" }, orderStatus: { version: "2.0.0", url: "https://acme.example/os2" } });
    const drivers = supplierDrivers({ directory });
    expect(drivers.map((d) => [d.id, d.kind])).toEqual([["sanmar", "native"], ["ssactivewear", "native"], ["acme", "promostandards"], ["extra", "promostandards"]]);
    expect(drivers.find((d) => d.id === "acme")!.capabilities).toEqual(["inventory", "orderStatus"]);
  });

  it("every written driver names its login headers and starts with production", () => {
    for (const d of NATIVE_DRIVERS) {
      expect(d.login.length).toBeGreaterThan(0);
      expect(d.environments[0]).toBe("production");
    }
  });
});

describe("the API", () => {
  it("health and the OpenAPI document are open; everything under /v1 needs the key", async () => {
    const { call } = server({});
    expect(await call("/health", { key: null })).toMatchObject({ status: 200, body: { ok: true, name: "OpenPromo", version: "0.2.0", suppliers: expect.any(Number) } });
    const doc = (await call("/openapi.json", { key: null })).body;
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/v1/{supplier}/products/{productId}", "/v1/sanmar/orders/preview", "/v1/sanmar/native/pricing/{style}", "/v1/ssactivewear/orders", "/v1/ssactivewear/native/styles"]));
    expect(doc.components.schemas).toHaveProperty("SsactivewearOrders");
    expect(await call("/v1/suppliers", { key: null })).toMatchObject({ status: 401, body: { error: { kind: "unauthorized" } } });
    expect(await call("/v1/suppliers", { key: "wrong".repeat(8) })).toMatchObject({ status: 401 });
  });

  it("lists suppliers, filtered, and says each one's login headers, never a login", async () => {
    const { call } = server({});
    const all = await call("/v1/suppliers");
    expect(all.body.suppliers.slice(0, 2)).toEqual([
      { id: "sanmar", name: "SanMar", kind: "native", capabilities: ["product", "inventory", "pricing", "orderStatus", "shipments", "invoices", "media"], loginHeaders: ["X-SanMar-Customer-Number", "X-SanMar-Username", "X-SanMar-Password"], defaultLogin: true, environment: "production" },
      { id: "ssactivewear", name: "S&S Activewear", kind: "native", capabilities: ["product", "inventory", "pricing", "orderStatus", "shipments", "invoices", "media"], loginHeaders: ["X-Supplier-Id", "X-Supplier-Password"], defaultLogin: false, environment: "production" },
    ]);
    expect(JSON.stringify(all.body)).not.toMatch(/webuser|188646/);
    // S&S's own driver first; S&S Activewear's PromoStandards listing is skipped in favor of it.
    expect((await call("/v1/suppliers?search=s%26s")).body.suppliers.map((s: { id: string }) => s.id)).toEqual(["ssactivewear", "s-and-s-canada"]);
    expect((await call("/v1/suppliers?kind=promostandards&capability=invoices")).body.count).toBeGreaterThan(20);
    expect((await call("/v1/suppliers?capability=bogus")).status).toBe(400);
    // Directory suppliers that list only Order Shipment Notification 2.x still answer shipments.
    const onOsn2 = DIRECTORY.filter((d) => d.endpoints.shipments?.version.startsWith("2.")).map((d) => d.id);
    expect(onOsn2.length).toBeGreaterThan(10);
    const withShipments = (await call("/v1/suppliers?capability=shipments")).body.suppliers.map((s: { id: string }) => s.id);
    expect(withShipments).toEqual(expect.arrayContaining(onOsn2));
    const one = await call("/v1/suppliers/ssactivewear");
    expect(one.body).toMatchObject({ id: "ssactivewear", environments: ["production"], environmentHeader: "X-Supplier-Environment", login: [{ header: "X-Supplier-Id", label: "S&S account number" }, { header: "X-Supplier-Password", label: "S&S API key" }] });
    expect(one.body.routes).toContainEqual({ method: "POST", path: "/v1/ssactivewear/orders", summary: expect.any(String), write: true, allowed: false });
    expect(await call("/v1/suppliers/nobody")).toMatchObject({ status: 404, body: { error: { kind: "unknown_supplier" } } });
  });

  it("serves SanMar from its PromoStandards services, and its own services as its routes", async () => {
    const { call } = server({ getProductInfoByStyleColorSize: fixture("sanmar/product-info.xml"), getPricing: fixture("sanmar/pricing.xml"), GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml"), GetProductRequest: fixture("promostandards/product-2.0.0.xml") });
    expect(await call("/v1/sanmar/products/PC61")).toMatchObject({ status: 200, body: { productId: expect.any(String), parts: expect.any(Array) } });
    expect(await call("/v1/sanmar/products/K420/inventory?partId=92032")).toMatchObject({ status: 200, body: { parts: [{ partId: "92032", available: 1045 }] } });
    expect(await call("/v1/sanmar/native/product-info/PC61")).toMatchObject({ status: 200, body: { style: "PC61", colors: [{ name: "White" }, { name: "Athletic Heather" }] } });
    expect(await call("/v1/sanmar/native/pricing/lpc61")).toMatchObject({ status: 200, body: { style: "LPC61", prices: [{ myPrice: 176, salePrice: 199 }] } });
    const missing = server({ getProductInfoByStyleColorSize: fixture("sanmar/product-info-invalid.xml") });
    expect(await missing.call("/v1/sanmar/native/product-info/NOPE")).toMatchObject({ status: 404, body: { error: { kind: "not_found" } } });
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
    expect(await down.call("/v1/sanmar/nothing/here")).toMatchObject({ status: 404, body: { error: { kind: "unknown_route" } } });
  });

  it("a supplier that doesn't answer a question says so, without asking for a login", async () => {
    const acme = { id: "acme", name: "Acme Promo", endpoints: { inventory: { version: "2.0.0", url: "https://ps.acme.example/inventory" } } };
    const { call, calls } = server({}, { OPENPROMO_SUPPLIERS: JSON.stringify([acme]) });
    expect(await call("/v1/acme/invoices?po=1")).toMatchObject({ status: 404, body: { error: { kind: "not_offered", message: expect.stringMatching(/Acme Promo doesn't offer invoices/) } } });
    expect(await call("/v1/acme/products/X/inventory")).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/X-Supplier-Id and X-Supplier-Password/) } } });
    expect(calls).toHaveLength(0);
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

    expect(await ask("/v1/sanmar/products/PC54/inventory")).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/X-SanMar-Customer-Number, X-SanMar-Username and X-SanMar-Password/) } } });
    expect(await ask("/v1/sanmar/products/PC54/inventory", { "X-SanMar-Username": "only-this" })).toMatchObject({ status: 400 });
    expect(fake.calls).toHaveLength(0);

    expect(await ask("/v1/sanmar/products/K420/inventory", shopA)).toMatchObject({ status: 200, body: { parts: [{ partId: "92032" }] } });
    expect(await ask("/v1/sanmar/native/product-info/PC61", shopB)).toMatchObject({ status: 200, body: { style: "PC61" } });
    expect(fake.calls[0]!.xml).toContain("<shar:id>shop-a</shar:id><shar:password>pw-a</shar:password>");
    expect(fake.calls[1]!.xml).toContain("<sanMarCustomerNumber>222</sanMarCustomerNumber><sanMarUserName>shop-b</sanMarUserName><sanMarUserPassword>pw-b</sanMarUserPassword>");
    await ask("/v1/sanmar/products/K420/inventory", { ...shopA, "X-SanMar-Environment": "edev" });
    expect(new URL(fake.calls[2]!.url).host).toBe("edev-ws.sanmar.com:8080");
    expect(await ask("/v1/sanmar/products/K420/inventory", { ...shopA, "X-SanMar-Environment": "staging" })).toMatchObject({ status: 400 });
    expect(JSON.stringify(lines)).not.toMatch(/pw-a|pw-b|shop-a|shop-b/);
  });

  it("a request's login wins over the server's default one", async () => {
    const { call, calls } = server({ GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml") });
    await call("/v1/sanmar/products/K420/inventory", { headers: { "X-SanMar-Customer-Number": "9", "X-SanMar-Username": "other", "X-SanMar-Password": "x" } });
    await call("/v1/sanmar/products/K420/inventory");
    expect(calls.map((c) => /<shar:id>([^<]*)</.exec(c.xml)?.[1])).toEqual(["other", "webuser"]);
  });
});

describe("S&S Activewear through the API", () => {
  const routes = {
    [`GET ${US}/styles/39`]: [SS_STYLE],
    [`GET ${US}/styles/`]: SS_STYLES,
    [`GET ${US}/products/`]: SS_PRODUCTS,
    [`GET ${US}/orders/${SS_PO}`]: SS_ORDERS,
  };

  it("answers the same paths, in the same shapes, as every other supplier", async () => {
    const { call, calls } = ssServer(routes);
    const h = { headers: SS_LOGIN };
    expect(await call("/v1/ssactivewear/products/39", h)).toMatchObject({ status: 200, body: { productId: "39", styleNumber: "5000", parts: [{ partId: "B00760003" }, { partId: "B00760004" }, { partId: "B00860003" }] } });
    expect(await call("/v1/ssactivewear/products/39/inventory?partId=B00760004", h)).toMatchObject({ status: 200, body: { parts: [{ partId: "B00760004", available: 10 }] } });
    expect(await call("/v1/ssactivewear/products/39/pricing?priceType=List&partId=B00760004", h)).toMatchObject({ status: 200, body: { priceType: "List", parts: [{ partId: "B00760004", prices: [{ minQuantity: 1, price: 312 }, { minQuantity: 12, price: 298 }, { minQuantity: 72, price: 275 }] }] } });
    expect(await call(`/v1/ssactivewear/orders/${SS_PO}`, h)).toMatchObject({ status: 200, body: { orders: [{ salesOrderNumber: "SS-8800", state: "shipped" }, { salesOrderNumber: "SS-8801", state: "in_production" }] } });
    expect(await call(`/v1/ssactivewear/orders/${SS_PO}/shipments`, h)).toMatchObject({ status: 200, body: { shipments: [{ salesOrderNumber: "SS-8800", packages: [{ trackingNumber: "1Z5V1E750312345678" }, { trackingNumber: "1Z5V1E750312345679" }] }] } });
    expect(await call(`/v1/ssactivewear/invoices?po=${SS_PO}`, h)).toMatchObject({ status: 200, body: { invoices: [{ invoiceNumber: "SI-310045", total: 3391 }] } });
    expect(await call("/v1/ssactivewear/products/1", h)).toMatchObject({ status: 404, body: { error: { kind: "not_found" } } });
    expect(await call("/v1/ssactivewear/orders/NOPE", h)).toMatchObject({ status: 404, body: { error: { kind: "not_found" } } });
    expect(calls.every((c) => basicUser(c.authorization) === "123456:kit-key")).toBe(true);
  });

  it("its own routes: the styles catalog (searchable) and raw products", async () => {
    const { call } = ssServer(routes);
    expect(await call("/v1/ssactivewear/native/styles?search=bella%203001", { headers: SS_LOGIN })).toMatchObject({ status: 200, body: { styles: [{ styleID: 4113 }] } });
    expect((await call("/v1/ssactivewear/native/styles?limit=1", { headers: SS_LOGIN })).body.styles).toHaveLength(1);
    expect(await call("/v1/ssactivewear/native/products/39", { headers: SS_LOGIN })).toMatchObject({ status: 200, body: { styleId: "39", products: expect.arrayContaining([expect.objectContaining({ sku: "B00760003", customerPrice: 2.5 })]) } });
  });

  it("asks for its login by name; S&S turning it down is a 424 with S&S's diagnostic", async () => {
    const { call, calls } = ssServer({ [`GET ${US}/products/`]: { status: 401, body: "" }, [`GET api.ssactivewear.ca/v2/products/`]: { status: 401, body: "" } });
    expect(await call("/v1/ssactivewear/products/39/inventory")).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/X-Supplier-Id and X-Supplier-Password \(S&S account number, S&S API key\)/) } } });
    expect(calls).toHaveLength(0);
    expect(await call("/v1/ssactivewear/products/39/inventory", { headers: SS_LOGIN })).toMatchObject({ status: 424, body: { error: { kind: "auth", supplier: "ssactivewear", detail: expect.stringMatching(/^Tried /) } } });
  });

  it("places an order only when allowed, after checking S&S has nothing live under the PO", async () => {
    const body = { poNumber: "1042-10", shipTo: { address1: "12 Main St", city: "Austin", state: "TX", zip: "78701" }, lines: [{ sku: "B00760004", quantity: 6 }] };
    const off = ssServer(routes);
    expect(await off.call("/v1/ssactivewear/orders", post(body, SS_LOGIN))).toMatchObject({ status: 403, body: { error: { kind: "orders_off" } } });
    expect(off.calls).toHaveLength(0);

    const on = ssServer({ ...routes, [`POST ${US}/orders/`]: [{ orderNumber: "SS-9001", warehouseAbbr: "IL" }] }, { OPENPROMO_ORDERS: "on" });
    expect(await on.call("/v1/ssactivewear/orders", post(body, SS_LOGIN))).toMatchObject({ status: 201, body: { accepted: true, orders: [{ orderNumber: "SS-9001" }] } });
    expect(on.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v2/orders/1042-10", "POST /v2/orders/"]);

    const dup = ssServer({ ...routes, [`POST ${US}/orders/`]: [{ orderNumber: "X" }] }, { OPENPROMO_ORDERS: "on" });
    expect(await dup.call("/v1/ssactivewear/orders", post({ ...body, poNumber: SS_PO }, SS_LOGIN))).toMatchObject({ status: 409, body: { error: { kind: "duplicate", orders: [{ salesOrderNumber: "SS-8800" }, { salesOrderNumber: "SS-8801" }] } } });
    expect(dup.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await dup.call("/v1/ssactivewear/orders", post({ ...body, lines: [] }, SS_LOGIN))).toMatchObject({ status: 400, body: { error: { kind: "invalid" } } });
  });
});
