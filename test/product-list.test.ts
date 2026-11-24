import { describe, expect, it } from "vitest";
import { parseProductDateModified, parseProductSellable, PromoStandardsClient, promoStandardsCapabilities, promoStandardsConnection, supplierDrivers } from "../src/index.js";
import { createHandler, loadConfig } from "../src/server/index.js";
import { readSoapBody } from "../src/soap.js";
import { SS_STYLES } from "./fixtures/ssactivewear.js";
import { fakeRest, fakeSoap, fixture } from "./helpers.js";

const KEY = "k".repeat(32);
const SANMAR = { SANMAR_CUSTOMER_NUMBER: "188646", SANMAR_USERNAME: "webuser", SANMAR_PASSWORD: "pw" };
const login = { id: "webuser", password: "s3cret&<" };
const ACME = { id: "acme", name: "Acme Promo", endpoints: { productData: { version: "2.0.0", url: "https://ps.acme.example/productdata" }, inventory: { version: "2.0.0", url: "https://ps.acme.example/inventory" } } };
const PLAIN = { id: "plain", name: "Plain Promo", endpoints: { inventory: { version: "2.0.0", url: "https://ps.plain.example/inventory" } } };
const ACME_LOGIN = { "X-Supplier-Id": "webuser", "X-Supplier-Password": "pw" };
const SS_LOGIN = { "X-Supplier-Id": "123456", "X-Supplier-Password": "kit-key" };
const US = "api.ssactivewear.com/v2";

const TEE_AND_CAP = [
  { productId: "TEE100", partIds: ["TEE100-NVY-L", "TEE100-RED-M"] },
  { productId: "CAP200", partIds: [] },
];
const CHANGED = [
  { productId: "TEE100", partIds: ["TEE100-RED-M", "TEE100-RED-L"] },
  { productId: "POLO300", partIds: [] },
];

const acme = (routes: Parameters<typeof fakeSoap>[0]) => {
  const fake = fakeSoap(routes);
  return { ps: new PromoStandardsClient(ACME, login, { fetch: fake.fetch }), calls: fake.calls };
};

function serve(fetchImpl: typeof fetch) {
  const handler = createHandler(loadConfig({ OPENPROMO_API_KEY: KEY, ...SANMAR, OPENPROMO_SUPPLIERS: JSON.stringify([ACME, PLAIN]) }, { fetch: fetchImpl }), { log: () => {} });
  return async (path: string, headers: Record<string, string> = {}) => {
    const res = await handler(new Request(`https://openpromo.test${path}`, { headers: { Authorization: `Bearer ${KEY}`, ...headers } }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
}
const soapServer = (routes: Parameters<typeof fakeSoap>[0]) => {
  const fake = fakeSoap(routes);
  return { call: serve(fake.fetch), calls: fake.calls };
};

describe("Product Data 2.0.0: what a supplier sells, and what changed", () => {
  it("reads the schema's answers as one entry per product, its parts each once", () => {
    const res = (name: string, op: string) => readSoapBody(fixture(`promostandards/${name}`))!.body[op] as Record<string, unknown>;
    expect(parseProductSellable(res("product-sellable-2.0.0.xml", "GetProductSellableResponse"))).toEqual(TEE_AND_CAP);
    expect(parseProductDateModified(res("product-date-modified-2.0.0.xml", "GetProductDateModifiedResponse"))).toEqual(CHANGED);
    expect(parseProductSellable({})).toEqual([]);
  });

  it("asks getProductSellable for sellable products, every field a shared object in the schema's order", async () => {
    const { ps, calls } = acme({ GetProductSellableRequest: fixture("promostandards/product-sellable-2.0.0.xml") });
    expect(await ps.getProductsSellable()).toEqual(TEE_AND_CAP);
    expect(calls[0]!.url).toBe("https://ps.acme.example/productdata");
    expect(calls[0]!.soapAction).toBe("getProductSellable");
    expect(calls[0]!.xml).toContain('xmlns:ns="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/"');
    expect(calls[0]!.xml).toContain(
      "<ns:GetProductSellableRequest><shar:wsVersion>2.0.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password><shar:localizationCountry>US</shar:localizationCountry><shar:localizationLanguage>EN</shar:localizationLanguage><shar:isSellable>true</shar:isSellable></ns:GetProductSellableRequest>",
    );
  });

  it("asks getProductDateModified since a time, sent as an xsd:dateTime", async () => {
    const { ps, calls } = acme({ GetProductDateModifiedRequest: fixture("promostandards/product-date-modified-2.0.0.xml") });
    expect(await ps.getProductsChanged("2026-11-20")).toEqual(CHANGED);
    expect(calls[0]!.soapAction).toBe("getProductDateModified");
    expect(calls[0]!.xml).toContain("<ns:GetProductDateModifiedRequest><shar:wsVersion>2.0.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password><shar:changeTimeStamp>2026-11-20T00:00:00.000Z</shar:changeTimeStamp></ns:GetProductDateModifiedRequest>");
    await expect(ps.getProductsChanged("last week")).rejects.toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(1);
  });

  it("nothing to list is an empty list; a refused service is the supplier's words", async () => {
    const empty = fixture("promostandards/product-sellable-2.0.0-empty.xml");
    expect(await acme({ GetProductSellableRequest: empty }).ps.getProductsSellable()).toEqual([]);
    const none = (op: string, code: string, words: string) =>
      `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns1:${op} xmlns:ns1="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/" xmlns:ns3="http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/"><ns3:ServiceMessageArray><ns3:ServiceMessage><ns3:code>${code}</ns3:code><ns3:description>${words}</ns3:description><ns3:severity>Error</ns3:severity></ns3:ServiceMessage></ns3:ServiceMessageArray></ns1:${op}></S:Body></S:Envelope>`;
    expect(await acme({ GetProductDateModifiedRequest: none("GetProductDateModifiedResponse", "160", "No results found") }).ps.getProductsChanged("2026-11-20T00:00:00Z")).toEqual([]);
    await expect(acme({ GetProductSellableRequest: none("GetProductSellableResponse", "104", "Not authorized") }).ps.getProductsSellable()).rejects.toMatchObject({ kind: "not_enabled", detail: "Not authorized" });
  });

  it("Product Data adds productList and productChanges to a connection; a supplier without it has neither", () => {
    expect(promoStandardsCapabilities(ACME)).toEqual(["product", "productList", "productChanges", "inventory"]);
    expect(Object.keys(promoStandardsConnection(new PromoStandardsClient(ACME, login)))).toEqual(["product", "productList", "productChanges", "inventory"]);
    expect(promoStandardsCapabilities(PLAIN)).toEqual(["inventory"]);
  });
});

describe("GET /v1/{supplier}/products", () => {
  it("a PromoStandards supplier answers the list and the changes in one shape", async () => {
    const { call, calls } = soapServer({
      GetProductSellableRequest: fixture("promostandards/product-sellable-2.0.0.xml"),
      GetProductDateModifiedRequest: fixture("promostandards/product-date-modified-2.0.0.xml"),
    });
    expect(await call("/v1/acme/products", ACME_LOGIN)).toEqual({ status: 200, body: { count: 2, products: TEE_AND_CAP } });
    expect(await call("/v1/acme/products?changedSince=2026-11-20T00:00:00Z", ACME_LOGIN)).toEqual({ status: 200, body: { changedSince: "2026-11-20T00:00:00Z", count: 2, products: CHANGED } });
    expect(calls.map((c) => c.operation)).toEqual(["GetProductSellableRequest", "GetProductDateModifiedRequest"]);
  });

  it("an empty answer is an empty list, not an error", async () => {
    const { call } = soapServer({ GetProductSellableRequest: fixture("promostandards/product-sellable-2.0.0-empty.xml"), GetProductDateModifiedRequest: fixture("promostandards/product-sellable-2.0.0-empty.xml").replace(/GetProductSellableResponse/g, "GetProductDateModifiedResponse") });
    expect(await call("/v1/acme/products", ACME_LOGIN)).toEqual({ status: 200, body: { count: 0, products: [] } });
    expect(await call("/v1/acme/products?changedSince=2026-11-20", ACME_LOGIN)).toEqual({ status: 200, body: { changedSince: "2026-11-20", count: 0, products: [] } });
  });

  it("a bad changedSince is invalid, with nothing sent", async () => {
    const { call, calls } = soapServer({});
    expect(await call("/v1/acme/products?changedSince=yesterday", ACME_LOGIN)).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/changedSince/) } } });
    expect(await call("/v1/acme/products?changedSince=", ACME_LOGIN)).toMatchObject({ status: 400, body: { error: { kind: "invalid" } } });
    expect(calls).toHaveLength(0);
  });

  it("a supplier without Product Data says not_offered before asking for a login", async () => {
    const { call, calls } = soapServer({});
    expect(await call("/v1/plain/products")).toMatchObject({ status: 404, body: { error: { kind: "not_offered", message: expect.stringMatching(/Plain Promo doesn't offer productList/) } } });
    expect(await call("/v1/plain/products?changedSince=2026-11-20")).toMatchObject({ status: 404, body: { error: { kind: "not_offered", message: expect.stringMatching(/productChanges/) } } });
    expect(await call("/v1/acme/products")).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/X-Supplier-Id and X-Supplier-Password/) } } });
    expect(calls).toHaveLength(0);
  });

  it("SanMar answers both from its PromoStandards Product Data", async () => {
    const { call, calls } = soapServer({
      GetProductSellableRequest: fixture("promostandards/product-sellable-2.0.0.xml"),
      GetProductDateModifiedRequest: fixture("promostandards/product-date-modified-2.0.0.xml"),
    });
    expect(await call("/v1/sanmar/products")).toMatchObject({ status: 200, body: { count: 2 } });
    expect(await call("/v1/sanmar/products?changedSince=2026-11-20T00:00:00Z")).toMatchObject({ status: 200, body: { count: 2, products: CHANGED } });
    expect(calls.map((c) => c.url)).toEqual(["https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2", "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2"]);
  });

  it("S&S lists its styles catalog by style id, and can't say what changed", async () => {
    const fake = fakeRest({ [`GET ${US}/styles/`]: SS_STYLES });
    const call = serve(fake.fetch);
    expect(await call("/v1/ssactivewear/products", SS_LOGIN)).toEqual({ status: 200, body: { count: 2, products: [{ productId: "39", partIds: [] }, { productId: "4113", partIds: [] }] } });
    expect(await call("/v1/ssactivewear/products?changedSince=2026-11-20", SS_LOGIN)).toMatchObject({ status: 404, body: { error: { kind: "not_offered", message: expect.stringMatching(/S&S Activewear doesn't offer productChanges/) } } });
    expect(fake.calls).toHaveLength(1);
  });

  it("?capability= lists who answers each", async () => {
    const { call } = soapServer({});
    const ids = async (capability: string) => (await call(`/v1/suppliers?capability=${capability}`)).body.suppliers.map((s: { id: string }) => s.id);
    const list = await ids("productList");
    expect(list).toEqual(expect.arrayContaining(["sanmar", "ssactivewear", "acme"]));
    expect(list).not.toContain("plain");
    const changes = await ids("productChanges");
    expect(changes).toEqual(expect.arrayContaining(["sanmar", "acme"]));
    expect(changes).not.toContain("ssactivewear");
    expect(changes).not.toContain("plain");
    // Every directory supplier with Product Data 2.0.0 answers both.
    const withProductData = supplierDrivers().filter((d) => d.kind === "promostandards" && d.capabilities.includes("product")).map((d) => d.id);
    expect(withProductData.length).toBeGreaterThan(0);
    expect(list).toEqual(expect.arrayContaining(withProductData));
    expect(changes).toEqual(expect.arrayContaining(withProductData));
  });

  it("is in the OpenAPI document", async () => {
    const handler = createHandler(loadConfig({ OPENPROMO_API_KEY: KEY }), { log: () => {} });
    const doc = (await (await handler(new Request("https://openpromo.test/openapi.json"))).json()) as Record<string, any>;
    expect(doc.paths["/v1/{supplier}/products"].get.parameters.map((p: { name: string }) => p.name)).toEqual(["supplier", "changedSince"]);
    expect(doc.paths["/v1/{supplier}/products"].get.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/ProductList" });
    expect(doc.components.schemas.ListedProduct.required).toEqual(["productId", "partIds"]);
  });
});
