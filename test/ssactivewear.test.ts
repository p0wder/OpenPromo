import { describe, expect, it } from "vitest";
import { buildSsOrder, OpenPromoError, placeSsOrder, ssActivewearConnection, SsActivewearClient, ssInventory, ssInvoices, ssOrderState, ssOrderStatus, ssPricing, ssProduct, ssShipments } from "../src/index.js";
import { SS_ORDERS, SS_PO, SS_PRODUCTS, SS_STYLE } from "./fixtures/ssactivewear.js";
import { basicUser, fakeRest, type FakeRestCall } from "./helpers.js";

const US = "api.ssactivewear.com/v2";
const CA = "api.ssactivewear.ca/v2";
const login = { accountNumber: "123456", apiKey: "kit-key" };
const ss = (routes: Parameters<typeof fakeRest>[0]) => {
  const fake = fakeRest(routes);
  return { client: new SsActivewearClient(login, { fetch: fake.fetch }), calls: fake.calls };
};
const order = { poNumber: "1042-10", shipTo: { company: "Acme", attention: "Pat", address1: "12 Main St", address2: "Suite 4", city: "Austin", state: "tx", zip: "78701", email: "pat@example.com" }, lines: [{ sku: "B00760004", quantity: 6 }] };

describe("the S&S client", () => {
  it("signs in with Basic auth (account number, API key) and asks for JSON", async () => {
    const { client, calls } = ss({ [`GET ${US}/products/`]: SS_PRODUCTS });
    expect(await client.products(39)).toHaveLength(3);
    expect(basicUser(calls[0]!.authorization)).toBe("123456:kit-key");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ mediaType: "json", styleid: "39" });
  });

  it("reads 404 as nothing, not an error", async () => {
    const { client } = ss({});
    expect(await client.style("999999")).toBeNull();
    expect(await client.ordersByPo("NOPE")).toEqual([]);
  });

  it("finds a Canadian account, or a login entered the wrong way round, and remembers which worked", async () => {
    const fake = fakeRest({ [`GET ${US}/styles/39`]: { status: 401, body: "Unauthorized" }, [`GET ${CA}/styles/39`]: [SS_STYLE] });
    let remembered: number | undefined;
    const client = new SsActivewearClient(login, { fetch: fake.fetch, signIn: { get: () => remembered, set: (v) => (remembered = v) } });
    expect(await client.style("39")).toMatchObject({ styleID: 39 });
    expect(remembered).toBe(1);
    await client.style("39");
    expect(fake.calls.map((c) => c.url.host)).toEqual(["api.ssactivewear.com", "api.ssactivewear.ca", "api.ssactivewear.ca"]);

    const swapped = ss({ [`GET ${US}/styles/39`]: (c: FakeRestCall) => (basicUser(c.authorization) === "kit-key:123456" ? [SS_STYLE] : { status: 401, body: "" }), [`GET ${CA}/styles/39`]: { status: 401, body: "" } });
    expect(await swapped.client.style("39")).toMatchObject({ styleID: 39 });
  });

  it("a login S&S turns down everywhere is `auth`, with a diagnostic that never holds the key", async () => {
    const { client } = ss({ [`GET ${US}/styles/`]: { status: 401, body: "<h1>Unauthorized</h1>" }, [`GET ${CA}/styles/`]: { status: 403, body: "" } });
    const e = (await client.styles().catch((x) => x)) as OpenPromoError;
    expect(e).toBeInstanceOf(OpenPromoError);
    expect(e.kind).toBe("auth");
    expect(e.detail).toMatch(/Tried api.ssactivewear.com: 401 "Unauthorized"; .*API key is 7 characters/);
    expect(e.detail).not.toContain("kit-key");
    const down = ss({ [`GET ${US}/styles/`]: new TypeError("fetch failed"), [`GET ${CA}/styles/`]: new TypeError("fetch failed") });
    expect(await down.client.styles().catch((x) => x.kind)).toBe("unreachable");
  });
});

describe("S&S in the shared shapes", () => {
  it("a style is a product with one part per SKU: color, hex, size, GTIN and pictures", () => {
    const p = ssProduct(SS_STYLE, SS_PRODUCTS);
    expect(p).toMatchObject({ productId: "39", styleNumber: "5000", name: "Heavy Cotton T-Shirt", brand: "Gildan", categories: [{ category: "T-Shirts" }], primaryImageUrl: "https://www.ssactivewear.com/Images/Style/39_fm.jpg" });
    expect(p.parts[1]).toEqual({
      partId: "B00760004",
      colorName: "Black",
      colorHex: "#000000",
      size: "XL",
      labelSize: "XL",
      gtin: "0082178060004",
      images: { front: "https://www.ssactivewear.com/Images/Color/B00760004_f.jpg", back: "https://www.ssactivewear.com/Images/Color/B00760004_b.jpg", swatch: "https://www.ssactivewear.com/Images/ColorSwatch/B00760004_s.jpg" },
    });
  });

  it("stock per SKU and warehouse, by name; a negative count is none", () => {
    const inv = ssInventory("39", SS_PRODUCTS);
    expect(inv.parts[1]).toEqual({ partId: "B00760004", color: "Black", size: "XL", available: 10, locations: [{ id: "IL", name: "Lockport, IL", quantity: 6 }, { id: "NV", name: "Reno, NV", quantity: 4 }] });
    expect(inv.parts[2]!.locations).toEqual([{ id: "ZZ", name: "ZZ", quantity: 0 }]);
    expect(ssInventory("39", SS_PRODUCTS, ["b00760004"]).parts.map((p) => p.partId)).toEqual(["B00760004"]);
  });

  it("Customer and Net are the account's price; List is S&S's, with dozen and case breaks", () => {
    expect(ssPricing("39", SS_PRODUCTS, "Customer").parts[0]).toEqual({ partId: "B00760003", prices: [{ minQuantity: 1, price: 250 }] });
    expect(ssPricing("39", SS_PRODUCTS, "Net", { partId: "B00860003" }).parts).toEqual([{ partId: "B00860003", prices: [{ minQuantity: 1, price: 220 }] }]);
    expect(ssPricing("39", SS_PRODUCTS, "List").parts[0]!.prices).toEqual([{ minQuantity: 1, price: 312 }, { minQuantity: 12, price: 298 }, { minQuantity: 72, price: 275 }]);
    // A dozen price the same as the piece price is no break.
    expect(ssPricing("39", SS_PRODUCTS, "List").parts[2]!.prices).toEqual([{ minQuantity: 1, price: 280 }, { minQuantity: 72, price: 275 }]);
  });

  it("reads S&S's status words as the shared states", () => {
    expect(["Pending", "In Progress", "Processing", "Partially Shipped", "Shipped", "Completed", "Cancelled", "Back Ordered", ""].map(ssOrderState)).toEqual(["received", "in_production", "in_production", "partially_shipped", "shipped", "shipped", "cancelled", "in_production", "received"]);
  });

  it("a PO S&S split by warehouse is one order status with both S&S orders", () => {
    const [status] = ssOrderStatus(SS_ORDERS);
    expect(status).toMatchObject({ purchaseOrderNumber: SS_PO, orders: [{ salesOrderNumber: "SS-8800", state: "shipped", final: true }, { salesOrderNumber: "SS-8801", state: "in_production", final: false, expectedShipDate: "2026-11-14", lines: [{ partId: "B00760004", ordered: 4, shipped: 0 }] }] });
    expect(ssOrderStatus([{ orderNumber: "A", poNumber: "7", orderStatus: "Backordered", expectedShipDate: "2026-11-20" }])[0]!.orders[0]).toMatchObject({ backordered: true, onHold: false });
  });

  it("shipments: every tracking number, the shipped lines on the first package; nothing for what hasn't shipped", () => {
    expect(ssShipments(SS_ORDERS)).toEqual([
      {
        purchaseOrderNumber: SS_PO,
        salesOrderNumber: "SS-8800",
        complete: true,
        packages: [
          { trackingNumber: "1Z5V1E750312345678", carrier: "UPS", method: "Ground", shippedOn: "2026-11-09", items: [{ productId: "5000", partId: "B00760004", quantity: 8 }] },
          { trackingNumber: "1Z5V1E750312345679", carrier: "UPS", method: "Ground", shippedOn: "2026-11-09", items: [] },
        ],
      },
    ]);
  });

  it("invoices in cents, one per invoiced S&S order; a credit reads as a credit", () => {
    expect(ssInvoices(SS_ORDERS)).toEqual([
      {
        invoiceNumber: "SI-310045",
        kind: "invoice",
        purchaseOrderNumber: SS_PO,
        salesOrderNumbers: ["SS-8800"],
        invoiceDate: "2026-11-09",
        dueDate: "2026-12-09",
        paymentTerms: "Net 30",
        subtotal: 2496,
        shipping: 895,
        tax: 0,
        total: 3391,
        lines: [{ productId: "5000", partId: "B00760004", description: "Gildan 5000 Heavy Cotton T-Shirt Black XL", quantity: 8, unitPrice: 312, extendedPrice: 2496 }],
      },
    ]);
    expect(ssInvoices([{ invoiceNumber: "CR-1", orderType: "Credit", total: -12.5 }])[0]).toMatchObject({ kind: "credit", total: 1250 });
  });

  it("the connection resolves a style number to S&S's style id, and asks S&S once per question", async () => {
    const fake = fakeRest({ [`GET ${US}/styles/Gildan 5000`]: [SS_STYLE], [`GET ${US}/products/`]: SS_PRODUCTS, [`GET ${US}/orders/${SS_PO}`]: SS_ORDERS });
    const c = ssActivewearConnection(new SsActivewearClient(login, { fetch: fake.fetch }));
    expect((await c.inventory("Gildan 5000", {}))?.productId).toBe("39");
    expect((await c.pricing("39", { priceType: "List" }))?.parts).toHaveLength(3);
    expect(fake.calls.map((x) => x.url.pathname)).toEqual(["/v2/styles/Gildan%205000", "/v2/products/", "/v2/products/"]);
    expect(await c.invoices({ poNumber: SS_PO })).toHaveLength(1);
    expect(fake.calls.at(-1)!.url.searchParams.get("lines")).toBe("true");
    await expect(c.orderStatus({ since: "2026-11-01" })).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("S&S orders", () => {
  it("builds S&S's request: address joined, state upper-cased, Ground by default, identical lines merged", () => {
    const built = buildSsOrder({ ...order, lines: [{ sku: "B00760004", quantity: 6 }, { sku: "b00760004", quantity: 2 }, { sku: "B00760003", quantity: 1, warehouse: "nv" }] });
    expect(built.request).toEqual({
      shippingAddress: { customer: "Acme", attn: "Pat", address: "12 Main St, Suite 4", city: "Austin", state: "TX", zip: "78701", residential: false },
      shippingMethod: "1",
      shipBlind: false,
      poNumber: "1042-10",
      emailConfirmation: "pat@example.com",
      testOrder: false,
      autoselectWarehouse: false,
      rejectLineErrors: true,
      lines: [{ identifier: "B00760004", qty: 8 }, { identifier: "B00760003", qty: 1, warehouseAbbr: "NV" }],
    });
    expect(built.changes).toEqual(["ship method: Ground (1), S&S's default", "line 2 (b00760004) merged into the earlier line for the same SKU"]);
  });

  it("refuses an order S&S can't take, saying everything that's wrong, before sending", () => {
    const e = (() => {
      try {
        buildSsOrder({ ...order, shipTo: { ...order.shipTo, city: "x".repeat(51), state: "Texas", zip: "7" }, shipMethod: "UPS", lines: [{ sku: "", quantity: 0 }] });
      } catch (x) {
        return x as OpenPromoError;
      }
    })()!;
    expect(e.kind).toBe("invalid");
    expect(e.detail).toBe('city is 51 characters; S&S takes 50; state must be a two-letter code; ZIP "7" isn\'t a US ZIP or Canadian postal code; ship method "UPS" isn\'t an S&S ship method code (1 Ground, 16 3 Day Select, 3 2nd Day Air, 2 Next Day Air, 6 Will call (pick up)); line 1 has no sku; line 1 quantity must be a whole number of at least 1');
  });

  it("places it once, on the host a read proved, and reads S&S's split", async () => {
    const { client, calls } = ss({ [`POST ${US}/orders/`]: [{ orderNumber: "SS-9001", warehouseAbbr: "IL" }, { orderNumber: "SS-9002", warehouseAbbr: "NV" }] });
    expect(await placeSsOrder(client, order)).toEqual({ accepted: true, poNumber: "1042-10", orders: [{ orderNumber: "SS-9001", warehouse: "IL" }, { orderNumber: "SS-9002", warehouse: "NV" }], changes: ["ship method: Ground (1), S&S's default"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ poNumber: "1042-10", testOrder: false });
  });

  it("says when an order may or may not have gone through, and never retries", async () => {
    const cases: [unknown, string][] = [
      [{ status: 500, body: "oops" }, "unreachable"],
      [new TypeError("fetch failed"), "unreachable"],
      [{ status: 200, body: "{}" }, "bad_response"],
      [{ status: 400, body: { errors: [{ field: "zip", message: "Invalid ZIP for state." }] } }, "refused"],
      [{ status: 401, body: "" }, "auth"],
    ];
    for (const [answer, kind] of cases) {
      const { client, calls } = ss({ [`POST ${US}/orders/`]: answer });
      const e = (await placeSsOrder(client, order).catch((x) => x)) as OpenPromoError;
      expect(e.kind).toBe(kind);
      expect(calls).toHaveLength(1);
      if (kind === "refused") expect(e.detail).toBe("Invalid ZIP for state.");
    }
  });
});

