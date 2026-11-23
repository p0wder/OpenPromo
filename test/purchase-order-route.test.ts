import { describe, expect, it } from "vitest";
import type { PurchaseOrderInput } from "../src/index.js";
import { createHandler, loadConfig } from "../src/server/index.js";
import { fakeSoap, fixture } from "./helpers.js";

const KEY = "k".repeat(32);
const LOGIN = { "X-Supplier-Id": "webuser", "X-Supplier-Password": "pw" };
const PO = { version: "1.0.0", url: "https://ps.acme.example/po" };
const OS = { version: "2.0.0", url: "https://ps.acme.example/orderstatus" };
const NS = "http://www.promostandards.org/WSDL/PO/1.0.0/";

/** Acme lists Purchase Order and Order Status; Bolt lists Purchase Order only; Calm lists no Purchase Order. */
const SUPPLIERS = [
  { id: "acme", name: "Acme Promo", endpoints: { purchaseOrder: PO, orderStatus: OS } },
  { id: "bolt", name: "Bolt Promo", endpoints: { purchaseOrder: { ...PO, url: "https://ps.bolt.example/po" } } },
  { id: "calm", name: "Calm Promo", endpoints: { orderStatus: { ...OS, url: "https://ps.calm.example/orderstatus" } } },
];

const order = (over: Partial<PurchaseOrderInput> = {}): PurchaseOrderInput => ({
  poNumber: "1042-1",
  orderDate: "2026-11-23T15:04:05Z",
  shipTo: { companyName: "Inkline Print Co", address1: "12 Main St", city: "Austin", region: "TX", postalCode: "78701", country: "US" },
  carrier: "UPS",
  service: "GROUND",
  lines: [
    { productId: "PC54", partId: "118032", quantity: 12, unitPrice: 312 },
    { productId: "PC54", partId: "118036", quantity: 6, unitPrice: 412 },
  ],
  ...over,
});

const NOTHING_UNDER_PO = fixture("promostandards/error-301.xml").replaceAll("GetInvoicesResponse", "GetOrderStatusResponse");
const BLANK_TAKEN = fixture("promostandards/po-1.0.0-supported-order-types.xml");
const SAMPLE_ONLY = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns1:GetSupportedOrderTypesResponse xmlns:ns1="${NS}"><ns1:supportedOrderTypes>Sample</ns1:supportedOrderTypes></ns1:GetSupportedOrderTypesResponse></S:Body></S:Envelope>`;
const SENT = fixture("promostandards/po-1.0.0-sent.xml");

function server(routes: Parameters<typeof fakeSoap>[0], env: Record<string, string> = {}) {
  const fake = fakeSoap(routes);
  const handler = createHandler(loadConfig({ OPENPROMO_API_KEY: KEY, OPENPROMO_SUPPLIERS: JSON.stringify(SUPPLIERS), ...env }, { fetch: fake.fetch }), { log: () => {} });
  const call = async (path: string, body?: unknown, headers: Record<string, string> = LOGIN) => {
    const init: RequestInit = body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) };
    const res = await handler(new Request(`https://openpromo.test${path}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...headers } }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const ops = () => fake.calls.map((c) => c.operation);
  return { call, calls: fake.calls, ops };
}

describe("POST /v1/{supplier}/orders for PromoStandards suppliers (PO 1.0.0)", () => {
  it("places a Blank order for a supplier in OPENPROMO_ORDERS: checks order types and Order Status first, sends once, answers the transaction id and changes", async () => {
    const { call, calls, ops } = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: NOTHING_UNDER_PO, SendPORequest: SENT }, { OPENPROMO_ORDERS: "acme" });
    const placed = await call("/v1/acme/orders", order());
    expect(placed).toEqual({
      status: 201,
      body: {
        accepted: true,
        poNumber: "1042-1",
        transactionId: "TX-778201",
        total: 6216,
        messages: [{ code: "999", description: "Line 2 will ship from a second warehouse", severity: "Information" }],
        changes: ["currency: USD, as none was given"],
        duplicateCheck: "orderStatus",
      },
    });
    expect(ops()).toEqual(["GetSupportedOrderTypesRequest", "GetOrderStatusRequest", "SendPORequest"]);
    expect(calls[1]!.xml).toContain("1042-1");
    expect(calls[2]!.url).toBe("https://ps.acme.example/po");
    expect(calls[2]!.xml).toContain("<shar:id>webuser</shar:id>");
  });

  it("is off unless the supplier is in OPENPROMO_ORDERS (`on` is never a directory supplier): 403 orders_off, nothing reaches the supplier", async () => {
    for (const env of [{}, { OPENPROMO_ORDERS: "on" }, { OPENPROMO_ORDERS: "bolt" }] as Record<string, string>[]) {
      const { call, calls } = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: NOTHING_UNDER_PO, SendPORequest: SENT }, env);
      expect(await call("/v1/acme/orders", order())).toMatchObject({
        status: 403,
        body: { error: { kind: "orders_off", supplier: "acme", message: expect.stringMatching(/Acme Promo.*acme to OPENPROMO_ORDERS/) } },
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a second order under the same PO with 409 when Order Status shows a live one; nothing is sent", async () => {
    const { call, ops } = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: fixture("promostandards/order-status-2.0.0.xml"), SendPORequest: SENT }, { OPENPROMO_ORDERS: "acme" });
    expect(await call("/v1/acme/orders", order({ poNumber: "SS3820" }))).toMatchObject({
      status: 409,
      body: { error: { kind: "duplicate", supplier: "acme", message: expect.stringMatching(/already has an order under PO SS3820\. Nothing was sent/), orders: [{ salesOrderNumber: "100267568" }] } },
    });
    // skipDuplicateCheck doesn't skip a check OpenPromo can make.
    expect(await call("/v1/acme/orders", { ...order({ poNumber: "SS3820" }), skipDuplicateCheck: true })).toMatchObject({ status: 409 });
    expect(ops()).not.toContain("SendPORequest");
  });

  it("refuses a supplier without Order Status with 400 explaining why, unless the body says skipDuplicateCheck: true", async () => {
    const { call, calls, ops } = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, SendPORequest: SENT }, { OPENPROMO_ORDERS: "bolt" });
    const refused = await call("/v1/bolt/orders", order());
    expect(refused).toMatchObject({ status: 400, body: { error: { kind: "invalid", supplier: "bolt" } } });
    expect(refused.body.error.message).toBe(
      `Bolt Promo doesn't list Order Status, so OpenPromo can't check whether an order under PO 1042-1 was already placed. Nothing was sent. Make sure it wasn't (ask Bolt Promo), then send it again with "skipDuplicateCheck": true.`,
    );
    expect(ops()).toEqual([]);
    expect(await call("/v1/bolt/orders", { ...order(), skipDuplicateCheck: "yes" })).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: "skipDuplicateCheck must be true or false." } } });
    expect(await call("/v1/bolt/orders", { ...order(), skipDuplicateCheck: true })).toMatchObject({ status: 201, body: { transactionId: "TX-778201", duplicateCheck: "skipped" } });
    expect(ops()).toEqual(["GetSupportedOrderTypesRequest", "SendPORequest"]);
    // The opt-out isn't part of the PO sent.
    expect(calls.at(-1)!.xml).not.toMatch(/skipDuplicateCheck/);
  });

  it("refuses a supplier that doesn't take Blank orders (424 not_enabled), and an order that fails buildPurchaseOrder (400 invalid), before sending", async () => {
    const sample = server({ GetSupportedOrderTypesRequest: SAMPLE_ONLY, GetOrderStatusRequest: NOTHING_UNDER_PO, SendPORequest: SENT }, { OPENPROMO_ORDERS: "acme" });
    expect(await sample.call("/v1/acme/orders", order())).toMatchObject({
      status: 424,
      body: { error: { kind: "not_enabled", supplier: "acme", message: "Acme Promo doesn't take Blank orders through PromoStandards (it takes Sample). Nothing was sent." } },
    });
    expect(sample.ops()).toEqual(["GetSupportedOrderTypesRequest"]);

    const bad = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: NOTHING_UNDER_PO, SendPORequest: SENT }, { OPENPROMO_ORDERS: "acme" });
    const noPrice = order();
    delete (noPrice.lines[0] as Partial<(typeof noPrice.lines)[0]>).unitPrice;
    expect(await bad.call("/v1/acme/orders", noPrice)).toMatchObject({ status: 400, body: { error: { kind: "invalid", supplier: "acme", detail: expect.stringMatching(/unitPrice/) } } });
    expect(await bad.call("/v1/acme/orders", [order()])).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/JSON object/) } } });
    expect(await bad.call("/v1/acme/orders", "{not json")).toMatchObject({ status: 400, body: { error: { kind: "invalid" } } });
    expect(await bad.call("/v1/acme/orders", order(), {})).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/X-Supplier-Id and X-Supplier-Password/) } } });
    expect(bad.calls).toHaveLength(0);
  });

  it("answers the supplier's refusal and an unknown outcome in the same kinds as the client", async () => {
    const refused = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: NOTHING_UNDER_PO, SendPORequest: fixture("promostandards/po-1.0.0-refused.xml") }, { OPENPROMO_ORDERS: "acme" });
    expect(await refused.call("/v1/acme/orders", order())).toMatchObject({ status: 424, body: { error: { kind: "refused", supplier: "acme", detail: "Account 40112 is on credit hold" } } });
    const down = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: NOTHING_UNDER_PO, SendPORequest: { status: 503, body: "" } }, { OPENPROMO_ORDERS: "acme" });
    expect(await down.call("/v1/acme/orders", order())).toMatchObject({ status: 504, body: { error: { kind: "unreachable", message: expect.stringMatching(/may or may not have been placed\. Look PO 1042-1 up/) } } });
    expect(down.ops().filter((o) => o === "SendPORequest")).toHaveLength(1);
  });
});

describe("POST /v1/{supplier}/orders/check", () => {
  it("builds and checks the order the same way, whether or not ordering is on, and never calls sendPO", async () => {
    const { call, ops } = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: NOTHING_UNDER_PO, SendPORequest: SENT });
    const checked = await call("/v1/acme/orders/check", order({ lines: [...order().lines, { productId: "PC54", partId: "118032", quantity: 3, unitPrice: 312 }] }));
    expect(checked).toMatchObject({
      status: 200,
      body: {
        ok: true,
        poNumber: "1042-1",
        currency: "USD",
        total: 7152,
        lines: [
          { lineNumber: 1, partId: "118032", quantity: 15, unitPrice: 312, lineTotal: 4680 },
          { lineNumber: 2, partId: "118036", quantity: 6, unitPrice: 412, lineTotal: 2472 },
        ],
        changes: ["currency: USD, as none was given", "line 3 (PC54 118032) merged into line 1, the same part"],
        duplicateCheck: "orderStatus",
      },
    });
    expect(await call("/v1/acme/orders/check", order({ shipTo: { ...order().shipTo, postalCode: "7" } }))).toMatchObject({ status: 400, body: { error: { kind: "invalid" } } });

    const dup = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, GetOrderStatusRequest: fixture("promostandards/order-status-2.0.0.xml"), SendPORequest: SENT });
    expect(await dup.call("/v1/acme/orders/check", order({ poNumber: "SS3820" }))).toMatchObject({ status: 409, body: { error: { kind: "duplicate" } } });
    const bolt = server({ GetSupportedOrderTypesRequest: BLANK_TAKEN, SendPORequest: SENT });
    expect(await bolt.call("/v1/bolt/orders/check", order())).toMatchObject({ status: 400, body: { error: { kind: "invalid", message: expect.stringMatching(/skipDuplicateCheck/) } } });
    expect(await bolt.call("/v1/bolt/orders/check", { ...order(), skipDuplicateCheck: true })).toMatchObject({ status: 200, body: { ok: true, duplicateCheck: "skipped" } });

    for (const s of [{ ops }, dup, bolt]) expect(s.ops()).not.toContain("SendPORequest");
  });
});

describe("who has the order routes", () => {
  it("only PromoStandards suppliers that list PO 1.0.0; the supplier page lists both routes with allowed; the OpenAPI document has them once", async () => {
    const { call, calls } = server({}, { OPENPROMO_ORDERS: "acme" });
    const acme = (await call("/v1/suppliers/acme")).body;
    expect(acme.ordersAllowed).toBe(true);
    expect(acme.capabilities).toEqual(["orderStatus"]);
    expect(acme.routes).toEqual([
      { method: "POST", path: "/v1/acme/orders/check", summary: expect.stringMatching(/Never calls sendPO/) },
      { method: "POST", path: "/v1/acme/orders", summary: expect.stringMatching(/skipDuplicateCheck/), write: true, allowed: true },
    ]);
    expect((await call("/v1/suppliers/bolt")).body.routes).toContainEqual(expect.objectContaining({ path: "/v1/bolt/orders", write: true, allowed: false }));
    expect((await call("/v1/suppliers/calm")).body.routes).toEqual([]);
    expect(await call("/v1/calm/orders", order())).toMatchObject({ status: 404, body: { error: { kind: "unknown_route" } } });
    expect(await call("/v1/calm/orders/check", order())).toMatchObject({ status: 404, body: { error: { kind: "unknown_route" } } });
    // SanMar and S&S keep their own routes: no orders/check there.
    expect(await call("/v1/sanmar/orders/check", order(), { "X-SanMar-Customer-Number": "1", "X-SanMar-Username": "u", "X-SanMar-Password": "p" })).toMatchObject({ status: 404, body: { error: { kind: "unknown_route" } } });
    expect(calls).toHaveLength(0);

    const doc = (await call("/openapi.json")).body;
    expect(doc.paths["/v1/{supplier}/orders"].post).toMatchObject({ requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PurchaseOrder" } } } }, responses: { "201": expect.anything(), "403": expect.anything(), "409": expect.anything() } });
    expect(doc.paths["/v1/{supplier}/orders/check"].post.responses).toHaveProperty("200");
    expect(doc.components.schemas.PurchaseOrder.required).toEqual(["poNumber", "shipTo", "carrier", "service", "lines"]);
    expect(doc.components.schemas.PurchaseOrder.properties.lines.items.required).toContain("unitPrice");
    expect(doc.components.schemas.PurchaseOrder.properties).toHaveProperty("skipDuplicateCheck");
    expect(Object.keys(doc.paths).filter((p) => /^\/v1\/(acme|bolt)\//.test(p))).toEqual([]);
    expect(doc.paths).toHaveProperty(["/v1/sanmar/orders"]);
  });
});
