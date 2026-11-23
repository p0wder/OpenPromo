import { describe, expect, it } from "vitest";
import { parseSanmarProductInfo, sanmarMedia, ssMedia } from "../src/index.js";
import { createHandler, loadConfig } from "../src/server/index.js";
import { SS_PRODUCTS, SS_STYLE } from "./fixtures/ssactivewear.js";
import { fakeRest, fakeSoap, fixture } from "./helpers.js";

const KEY = "k".repeat(32);
const SANMAR = { SANMAR_CUSTOMER_NUMBER: "188646", SANMAR_USERNAME: "webuser", SANMAR_PASSWORD: "pw" };
const ACME = { id: "acme", name: "Acme Promo", endpoints: { inventory: { version: "2.0.0", url: "https://ps.acme.example/inventory" }, media: { version: "1.1.0", url: "https://ps.acme.example/media" } } };
const NO_MEDIA = { id: "plain", name: "Plain Promo", endpoints: { inventory: { version: "2.0.0", url: "https://ps.plain.example/inventory" } } };
const ACME_LOGIN = { "X-Supplier-Id": "webuser", "X-Supplier-Password": "pw" };
const SS_LOGIN = { "X-Supplier-Id": "123456", "X-Supplier-Password": "kit-key" };
const US = "api.ssactivewear.com/v2";

function serve(fetchImpl: typeof fetch) {
  const handler = createHandler(loadConfig({ OPENPROMO_API_KEY: KEY, ...SANMAR, OPENPROMO_SUPPLIERS: JSON.stringify([ACME, NO_MEDIA]) }, { fetch: fetchImpl }), { log: () => {} });
  return async (path: string, headers: Record<string, string> = {}) => {
    const res = await handler(new Request(`https://openpromo.test${path}`, { headers: { Authorization: `Bearer ${KEY}`, ...headers } }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
}
const soapServer = (routes: Parameters<typeof fakeSoap>[0]) => {
  const fake = fakeSoap(routes);
  return { call: serve(fake.fetch), calls: fake.calls };
};

const CDN = "https://cdnm.sanmar.com";
const SANMAR_PC61 = [
  { url: `${CDN}/catalog/images/imglib/catl/2016/f17/PC61_white_model_front_102016.jpg`, mediaType: "Image", partId: "118032", color: "White", classTypes: [{ id: "1006", name: "Primary" }] },
  { url: `${CDN}/imglib/mresjpg/2012/f1/PC61_White_Flat_Front_2009.jpg`, mediaType: "Image", partId: "118032", color: "White", classTypes: [{ id: "1007", name: "Front" }, { id: "flat", name: "Flat" }] },
  { url: `${CDN}/imglib/mresjpg/2016/f17/PC61_white_model_front_102016.jpg`, mediaType: "Image", partId: "118032", color: "White", classTypes: [{ id: "1007", name: "Front" }, { id: "model", name: "Model" }] },
  { url: `${CDN}/imglib/mresjpg/2016/f17/PC61_white_model_back_102016.jpg`, mediaType: "Image", partId: "118032", color: "White", classTypes: [{ id: "1008", name: "Rear" }, { id: "model", name: "Model" }] },
  { url: `${CDN}/swatch/gifs/port_white.gif`, mediaType: "Image", partId: "118032", color: "White", classTypes: [{ id: "1004", name: "Swatch" }] },
  // The same "colors available" picture for every color: one item, of no one color or part.
  { url: `${CDN}/catalog/images/PC61sw.jpg`, mediaType: "Image", classTypes: [{ id: "colorsAvailable", name: "Colors Available" }] },
];

describe("SanMar media from Product Info", () => {
  const pc61 = parseSanmarProductInfo(fixture("sanmar/product-info.xml"), "PC61")!;

  it("names each view with PromoStandards' class types where they match, one item per picture", () => {
    expect(sanmarMedia(pc61)).toEqual({ productId: "PC61", items: SANMAR_PC61 });
  });

  it("filters by part (SanMar's unique key), class type (id or name) and media type", () => {
    expect(sanmarMedia(pc61, { partId: "118056" }).items).toEqual([SANMAR_PC61[5]]);
    expect(sanmarMedia(pc61, { partId: "999" }).items).toEqual([]);
    expect(sanmarMedia(pc61, { classType: "front" }).items.map((i) => i.url)).toEqual([SANMAR_PC61[1]!.url, SANMAR_PC61[2]!.url]);
    expect(sanmarMedia(pc61, { classType: "1008" }).items).toEqual([SANMAR_PC61[3]]);
    expect(sanmarMedia(pc61, { mediaType: "Document" })).toEqual({ productId: "PC61", items: [] });
  });
});

describe("S&S media from its color images", () => {
  it("the style's picture is Primary; each SKU's front, back and swatch are Front, Rear and Swatch", () => {
    const media = ssMedia(SS_STYLE, SS_PRODUCTS);
    expect(media.productId).toBe("39");
    expect(media.items[0]).toEqual({ url: "https://www.ssactivewear.com/Images/Style/39_fm.jpg", mediaType: "Image", classTypes: [{ id: "1006", name: "Primary" }] });
    expect(media.items[1]).toEqual({ url: "https://www.ssactivewear.com/Images/Color/B00760003_f.jpg", mediaType: "Image", partId: "B00760003", color: "Black", classTypes: [{ id: "1007", name: "Front" }] });
    expect(media.items.map((i) => i.classTypes[0]!.name)).toEqual(["Primary", "Front", "Rear", "Swatch", "Front", "Rear", "Swatch", "Front", "Rear", "Swatch"]);
    expect(ssMedia(SS_STYLE, SS_PRODUCTS, { partId: "B00860003" }).items.map((i) => i.partId ?? "style")).toEqual(["style", "B00860003", "B00860003", "B00860003"]);
    expect(ssMedia(SS_STYLE, SS_PRODUCTS, { classType: "Swatch" }).items).toHaveLength(3);
  });

  it("a picture S&S gives for every size of a color is one item of that color", () => {
    const shared = SS_PRODUCTS.map((p) => ({ ...p, colorFrontImage: `Images/Color/${p.colorName}_f.jpg`, colorBackImage: undefined, colorSwatchImage: undefined }));
    expect(ssMedia({ ...SS_STYLE, styleImage: undefined }, shared).items).toEqual([
      { url: "https://www.ssactivewear.com/Images/Color/Black_f.jpg", mediaType: "Image", color: "Black", classTypes: [{ id: "1007", name: "Front" }] },
      { url: "https://www.ssactivewear.com/Images/Color/White_f.jpg", mediaType: "Image", partId: "B00860003", color: "White", classTypes: [{ id: "1007", name: "Front" }] },
    ]);
  });
});

describe("media through the API", () => {
  it("lists who answers media and media changes", async () => {
    const { call } = soapServer({});
    const ids = async (capability: string) => (await call(`/v1/suppliers?capability=${capability}`)).body.suppliers.map((s: { id: string }) => s.id);
    expect(await ids("media")).toEqual(expect.arrayContaining(["sanmar", "ssactivewear", "acme"]));
    expect(await ids("media")).not.toContain("plain");
    const changes = await ids("mediaChanges");
    expect(changes).toContain("acme");
    expect(changes).not.toContain("sanmar");
    expect(changes).not.toContain("ssactivewear");
  });

  it("a PromoStandards supplier answers from Media Content; a class type's name is matched on the answer, its id is sent", async () => {
    const { call, calls } = soapServer({ GetMediaContentRequest: fixture("promostandards/media-1.1.0-images.xml"), GetMediaDateModifiedRequest: fixture("promostandards/media-date-modified-1.1.0.xml") });
    const all = await call("/v1/acme/products/TEE100/media", ACME_LOGIN);
    expect(all).toMatchObject({ status: 200, body: { productId: "TEE100", items: [{ classTypes: [{ name: "Primary" }, { name: "Front" }, { name: "High" }] }, { partId: "TEE100-NVY-L", color: "Navy" }] } });
    expect((await call("/v1/acme/products/TEE100/media?classType=rear", ACME_LOGIN)).body.items.map((i: { url: string }) => i.url)).toEqual(["https://media.acme.example/TEE100/tee100-navy-back.jpg"]);
    expect(calls[1]!.xml).not.toContain("classType");
    await call("/v1/acme/products/TEE100/media?type=Document&partId=TEE100-NVY-L&classType=1006", ACME_LOGIN);
    expect(calls[2]!.xml).toContain("<shar:mediaType>Document</shar:mediaType><shar:productId>TEE100</shar:productId><shar:partId>TEE100-NVY-L</shar:partId><ns:classType>1006</ns:classType>");
    expect(await call("/v1/acme/media/changes?since=2026-11-20T00:00:00Z", ACME_LOGIN)).toEqual({ status: 200, body: { since: "2026-11-20T00:00:00Z", productIds: ["TEE100", "CAP200"] } });
    expect(await call("/v1/acme/media/changes", ACME_LOGIN)).toMatchObject({ status: 400, body: { error: { kind: "invalid" } } });
    expect(await call("/v1/acme/products/TEE100/media?type=Picture", ACME_LOGIN)).toMatchObject({ status: 400, body: { error: { kind: "invalid" } } });
    expect(calls).toHaveLength(4);
  });

  it("SanMar answers from Product Info, in the same shape, and can't say what changed", async () => {
    const { call, calls } = soapServer({ getProductInfoByStyleColorSize: fixture("sanmar/product-info.xml"), GetMediaContentRequest: "unused" });
    expect(await call("/v1/sanmar/products/PC61/media")).toEqual({ status: 200, body: { productId: "PC61", items: SANMAR_PC61 } });
    expect((await call("/v1/sanmar/products/PC61/media?partId=118056")).body.items).toEqual([SANMAR_PC61[5]]);
    expect(calls.map((c) => c.operation)).toEqual(["getProductInfoByStyleColorSize", "getProductInfoByStyleColorSize"]);
    expect(await call("/v1/sanmar/media/changes?since=2026-11-20")).toMatchObject({ status: 404, body: { error: { kind: "not_offered", message: expect.stringMatching(/SanMar doesn't offer mediaChanges/) } } });
    const missing = soapServer({ getProductInfoByStyleColorSize: fixture("sanmar/product-info-invalid.xml") });
    expect(await missing.call("/v1/sanmar/products/NOPE/media")).toMatchObject({ status: 404, body: { error: { kind: "not_found" } } });
  });

  it("S&S answers from its color images, in the same shape", async () => {
    const fake = fakeRest({ [`GET ${US}/styles/39`]: [SS_STYLE], [`GET ${US}/products/`]: SS_PRODUCTS });
    const call = serve(fake.fetch);
    expect(await call("/v1/ssactivewear/products/39/media?partId=B00760004&classType=Front", SS_LOGIN)).toEqual({
      status: 200,
      body: { productId: "39", items: [{ url: "https://www.ssactivewear.com/Images/Color/B00760004_f.jpg", mediaType: "Image", partId: "B00760004", color: "Black", classTypes: [{ id: "1007", name: "Front" }] }] },
    });
    expect(await call("/v1/ssactivewear/products/1/media", SS_LOGIN)).toMatchObject({ status: 404, body: { error: { kind: "not_found" } } });
    expect(await call("/v1/ssactivewear/media/changes?since=2026-11-20", SS_LOGIN)).toMatchObject({ status: 404, body: { error: { kind: "not_offered" } } });
  });

  it("a supplier without Media Content says so, without asking for a login; the OpenAPI document has the routes and the shape", async () => {
    const { call, calls } = soapServer({});
    expect(await call("/v1/plain/products/X/media")).toMatchObject({ status: 404, body: { error: { kind: "not_offered", message: expect.stringMatching(/Plain Promo doesn't offer media/) } } });
    expect(await call("/v1/plain/media/changes?since=2026-11-20")).toMatchObject({ status: 404, body: { error: { kind: "not_offered" } } });
    expect(calls).toHaveLength(0);
    const doc = (await call("/openapi.json")).body;
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/v1/{supplier}/products/{productId}/media", "/v1/{supplier}/media/changes"]));
    expect(doc.paths["/v1/{supplier}/products/{productId}/media"].get.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Media" });
    expect(doc.components.schemas.MediaItem.required).toEqual(["url", "mediaType", "classTypes"]);
  });
});
