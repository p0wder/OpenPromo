import { describe, expect, it } from "vitest";
import { checkSupplierConfig, OpenPromoError, PromoStandardsClient, SANMAR_PROMOSTANDARDS, orderStateOf, parseOrderStatusV1 } from "../src/index.js";
import { readSoapBody } from "../src/soap.js";
import { elementsOf, fakeSoap, fixture } from "./helpers.js";

const login = { id: "webuser", password: "s3cret&<" };
const client = (routes: Parameters<typeof fakeSoap>[0], environment: "production" | "test" = "production") => {
  const fake = fakeSoap(routes);
  return { ps: new PromoStandardsClient(SANMAR_PROMOSTANDARDS, login, { fetch: fake.fetch, environment }), calls: fake.calls };
};

describe("Order Status 2.0.0", () => {
  it("asks by PO with the 2.0.0 namespace, word query types and the required flags, all shared objects", async () => {
    const { ps, calls } = client({ GetOrderStatusRequest: fixture("promostandards/order-status-2.0.0.xml") });
    const [status] = await ps.getOrderStatus({ poNumber: "SS3820" });
    const call = calls[0]!;
    expect(call.url).toBe("https://ws.sanmar.com:8080/promostandards/OrderStatusServiceBindingV2");
    expect(call.xml).toContain('xmlns:ns="http://www.promostandards.org/WSDL/OrderStatus/2.0.0/"');
    expect(call.xml).toContain('xmlns:shar="http://www.promostandards.org/WSDL/OrderStatus/2.0.0/SharedObjects/"');
    expect(call.xml).toContain("<shar:wsVersion>2.0.0</shar:wsVersion>");
    expect(call.xml).toContain("<shar:queryType>poSearch</shar:queryType><shar:referenceNumber>SS3820</shar:referenceNumber>");
    expect(call.xml).toContain("<shar:returnIssueDetailType>openIssues</shar:returnIssueDetailType><shar:returnProductDetail>true</shar:returnProductDetail>");
    // Every value escaped.
    expect(call.xml).toContain("<shar:password>s3cret&amp;&lt;</shar:password>");
    expect(status).toEqual({
      purchaseOrderNumber: "SS3820",
      orders: [
        {
          salesOrderNumber: "100267568",
          state: "received",
          status: "received",
          final: false,
          backordered: false,
          onHold: true,
          expectedShipDate: undefined,
          expectedDeliveryDate: undefined,
          updatedAt: "2023-12-07T16:11:10.497-08:00",
          note: undefined,
          lines: [{ productId: "PC54", partId: "538612", lineNumber: "1", ordered: 500, shipped: 0, status: "received" }],
        },
      ],
    });
  });

  it("reads a split order: partly shipped with a backorder, and a complete one that's final", async () => {
    const { ps } = client({ GetOrderStatusRequest: fixture("promostandards/order-status-2.0.0-split.xml") });
    const [status] = await ps.getOrderStatus({ poNumber: "1042-1" });
    expect(status!.orders.map((o) => [o.salesOrderNumber, o.state, o.backordered, o.onHold, o.final])).toEqual([
      ["100300001", "partially_shipped", true, false, false],
      ["100300002", "shipped", false, false, true],
    ]);
    expect(status!.orders[0]!.lines.map((l) => [l.partId, l.ordered, l.shipped])).toEqual([
      ["118032", 12, 12],
      ["118036", 6, 0],
    ]);
  });

  it("asks by sales order, since a time, and for every open order", async () => {
    const answer = fixture("promostandards/order-status-2.0.0.xml");
    const { ps, calls } = client({ GetOrderStatusRequest: answer });
    await ps.getOrderStatus({ salesOrderNumber: "100342565" });
    await ps.getOrderStatus({ since: "2026-11-01T00:00:00" });
    await ps.getOrderStatus({ allOpen: true });
    expect(calls.map((c) => elementsOf(c.xml, "queryType")[0])).toEqual(["soSearch", "lastUpdate", "allOpen"]);
    expect(calls[1]!.xml).toContain("<shar:statusTimeStamp>2026-11-01T00:00:00</shar:statusTimeStamp>");
  });

  it("no such order (301 or 160) is an empty answer, not an error; a refused login throws auth", async () => {
    const notYet = fixture("promostandards/error-301.xml").replaceAll("GetInvoicesResponse", "GetOrderStatusResponse");
    expect(await client({ GetOrderStatusRequest: notYet }).ps.getOrderStatus({ poNumber: "X" })).toEqual([]);
    await expect(client({ GetOrderStatusRequest: fixture("promostandards/error-105.xml") }).ps.getOrderStatus({ poNumber: "X" })).rejects.toMatchObject({ kind: "auth", code: "105" });
  });

  it("maps every 2.0.0 status word, and 1.0.0's numeric ids", () => {
    expect(["Received", "Confirmed", "Partially Shipped", "Shipped", "Complete", "Canceled", "Cancelled", "Something new"].map(orderStateOf)).toEqual(["received", "in_production", "partially_shipped", "shipped", "shipped", "cancelled", "cancelled", "received"]);
    const v1 = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><GetOrderStatusDetailsResponse><OrderStatusArray><OrderStatus><purchaseOrderNumber>PO1</purchaseOrderNumber><OrderStatusDetailArray>
      <OrderStatusDetail><factoryOrderNumber>A</factoryOrderNumber><statusID>44</statusID><expectedShipDate>2026-12-20T00:00:00</expectedShipDate></OrderStatusDetail>
      <OrderStatusDetail><factoryOrderNumber>B</factoryOrderNumber><statusID>99</statusID></OrderStatusDetail>
    </OrderStatusDetailArray></OrderStatus></OrderStatusArray></GetOrderStatusDetailsResponse></S:Body></S:Envelope>`;
    const res = readSoapBody(v1)!.body.GetOrderStatusDetailsResponse as Record<string, unknown>;
    expect(parseOrderStatusV1(res)[0]!.orders.map((o) => [o.salesOrderNumber, o.state, o.status, o.backordered, o.final, o.expectedShipDate])).toEqual([
      ["A", "in_production", "Back Order Hold", true, false, "2026-12-20"],
      ["B", "cancelled", "Canceled", false, true, undefined],
    ]);
  });
});

describe("Order Shipment Notification 1.0.0", () => {
  it("puts queryType and referenceNumber in the service namespace, as SanMar's guide shows", async () => {
    const { ps, calls } = client({ GetOrderShipmentNotificationRequest: fixture("promostandards/shipments-1.0.0.xml") });
    const shipments = await ps.getShipments({ poNumber: "PO1645" });
    const xml = calls[0]!.xml;
    expect(calls[0]!.url).toBe("https://ws.sanmar.com:8080/promostandards/OrderShipmentNotificationServiceBinding");
    expect(xml).toContain("<shar:wsVersion>1.0.0</shar:wsVersion><shar:id>webuser</shar:id>");
    expect(xml).toContain("<ns:queryType>1</ns:queryType><ns:referenceNumber>PO1645</ns:referenceNumber>");
    expect(shipments).toEqual([
      { purchaseOrderNumber: "PONUMBER", salesOrderNumber: "1112223334", complete: true, packages: [{ trackingNumber: "1Z999AA10123456784", carrier: "UPS", method: "Ground", shippedOn: "2023-01-12", items: [{ productId: "PC55P", partId: "834732", quantity: 1 }] }] },
    ]);
  });

  it("nothing shipped yet (301) is no shipments", async () => {
    const notYet = fixture("promostandards/error-301.xml").replaceAll("GetInvoicesResponse", "GetOrderShipmentNotificationResponse");
    expect(await client({ GetOrderShipmentNotificationRequest: notYet }).ps.getShipments({ poNumber: "X" })).toEqual([]);
  });
});

describe("Invoice 1.0.0", () => {
  it("asks SanMar's V1_0_0 binding and reads the invoice, handling and sales orders included", async () => {
    const { ps, calls } = client({ GetInvoicesRequest: fixture("promostandards/invoices-1.0.0.xml") });
    const [inv] = await ps.getInvoices({ poNumber: "112233445" });
    expect(calls[0]!.url).toBe("https://ws.sanmar.com:8080/promostandards/InvoiceServiceBindingV1_0_0");
    expect(calls[0]!.xml).toContain("<shar:queryType>1</shar:queryType><shar:referenceNumber>112233445</shar:referenceNumber>");
    expect(inv).toEqual({
      invoiceNumber: "123456798",
      kind: "invoice",
      purchaseOrderNumber: "112233445",
      salesOrderNumbers: ["12345123"],
      invoiceDate: "2021-03-24",
      dueDate: "2021-04-24",
      paymentTerms: undefined,
      currency: "USD",
      subtotal: 1567,
      shipping: 0,
      handling: 0,
      tax: 0,
      total: 1567,
      amountDue: 1567,
      lines: [{ productId: "ST860", partId: "1019704", description: "ST Sport-Wick Textured 1/4-Zip Pullover", quantity: 1, unitPrice: 1567, extendedPrice: 1567 }],
    });
  });

  it("a PO not invoiced yet (301) is no invoices; the other query types send their own fields", async () => {
    const { ps, calls } = client({ GetInvoicesRequest: fixture("promostandards/error-301.xml") });
    expect(await ps.getInvoices({ poNumber: "1042-1" })).toEqual([]);
    await ps.getInvoices({ invoiceNumber: "77" });
    await ps.getInvoices({ invoiceDate: "2026-11-20" });
    await ps.getInvoices({ availableSince: "2026-11-01T00:00:00" });
    expect(calls.slice(1).map((c) => [elementsOf(c.xml, "queryType")[0], elementsOf(c.xml, "referenceNumber")[0] ?? elementsOf(c.xml, "requestedDate")[0] ?? elementsOf(c.xml, "availableTimeStamp")[0]])).toEqual([
      ["2", "77"],
      ["3", "2026-11-20"],
      ["4", "2026-11-01T00:00:00"],
    ]);
  });
});

describe("Inventory 2.0.0", () => {
  it("reads stock per part and location, and filters by parts", async () => {
    const { ps, calls } = client({ GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml") });
    const inv = await ps.getInventory("K420", { partIds: ["92032", "92033"] });
    expect(calls[0]!.url).toBe("https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final");
    expect(calls[0]!.xml).toContain("<shar:Filter><shar:partIdArray><shar:partId>92032</shar:partId><shar:partId>92033</shar:partId></shar:partIdArray></shar:Filter>");
    expect(inv).toEqual({
      productId: "k420",
      parts: [{ partId: "92032", color: "Black", size: "S", description: "Port Authority Heavyweight Cotton Pique Polo. K420", available: 1045, locations: [{ id: "1", name: "Seattle", postalCode: "98027", quantity: 0 }, { id: "2", name: "Cincinnati", postalCode: "45069", quantity: 167 }] }],
    });
  });

  it("an account without the service (104) throws not_enabled with the code", async () => {
    const err = await client({ GetInventoryLevelsRequest: fixture("promostandards/error-104.xml") })
      .ps.getInventory("PC54")
      .catch((e) => e);
    expect(err).toBeInstanceOf(OpenPromoError);
    expect(err).toMatchObject({ kind: "not_enabled", code: "104", supplier: "sanmar" });
  });
});

describe("Product Data 2.0.0 and Pricing and Configuration 1.0.0", () => {
  it("reads a product with its parts", async () => {
    const { ps, calls } = client({ GetProductRequest: fixture("promostandards/product-2.0.0.xml") });
    const p = await ps.getProduct("MM1000");
    expect(calls[0]!.xml).toContain("<shar:localizationCountry>US</shar:localizationCountry><shar:localizationLanguage>EN</shar:localizationLanguage><shar:productId>MM1000</shar:productId>");
    expect(p).toMatchObject({
      productId: "MM1000",
      brand: "Mercer+Mettle",
      description: ["Crafted in a heavier knit.", "Moisture-wicking"],
      keywords: ["Stretch", "Pique"],
      categories: [{ category: "Polos/Knits", subCategory: "Cotton, Easy Care" }],
      priceGroups: [{ name: "MSRP", currency: "USD", prices: [{ minQuantity: 1, price: 2498 }] }],
      parts: [{ partId: "1878771", colorName: "DeepBlack", standardColorName: "Deep Black", labelSize: "S", gtin: "00191265938235", isCloseout: false }],
    });
  });

  it("prices a product at the supplier's default FOB point without asking for FOB points", async () => {
    const { ps, calls } = client({ GetConfigurationAndPricingRequest: fixture("promostandards/pricing-1.0.0.xml") });
    const pricing = await ps.getPricing("K500", { priceType: "List" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.xml).toContain("<shar:currency>USD</shar:currency><shar:fobId>1</shar:fobId><shar:priceType>List</shar:priceType>");
    expect(calls[0]!.xml).toContain("<shar:configurationType>Blank</shar:configurationType>");
    expect(pricing).toEqual({ productId: "K500", priceType: "Net", currency: "USD", parts: [{ partId: "240831", prices: [{ minQuantity: 1, price: 899, uom: "CA", effectiveDate: "2023-05-19T12:51:32.780", expiryDate: "2023-05-19T23:59:59.000" }] }] });
  });
});

describe("transport and config", () => {
  it("uses SanMar's EDEV hosts in the test environment", async () => {
    const { ps, calls } = client({ GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml") }, "test");
    await ps.getInventory("K420");
    expect(calls[0]!.url).toBe("https://edev-ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final");
  });

  it("turns no answer, gateway errors, HTTP auth and SOAP faults into typed errors", async () => {
    const fail = (answer: Parameters<typeof fakeSoap>[0][string]) => client({ GetInventoryLevelsRequest: answer }).ps.getInventory("PC54").catch((e: OpenPromoError) => [e.kind, e.detail ?? null]);
    expect(await fail(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))).toEqual(["unreachable", "timed out"]);
    expect(await fail({ status: 504, body: "" })).toEqual(["unreachable", "gateway 504"]);
    expect(await fail({ status: 401, body: "" })).toEqual(["auth", null]);
    expect(await fail({ status: 429, body: "" })).toEqual(["rate_limited", null]);
    expect(await fail({ status: 200, body: "<html>not soap</html>" })).toEqual(["bad_response", "not a SOAP answer"]);
    const fault = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Something broke</faultstring></S:Fault></S:Body></S:Envelope>`;
    expect(await fail({ status: 500, body: fault })).toEqual(["refused", "Something broke"]);
  });

  it("checks a supplier config", () => {
    expect(checkSupplierConfig(SANMAR_PROMOSTANDARDS)).toEqual([]);
    expect(checkSupplierConfig({ id: "Acme Co", name: "Acme", endpoints: { orderStatus: { version: "3.0.0", url: "http://x" } } })).toEqual([
      'supplier id "Acme Co" must be lowercase letters, digits and dashes',
      "orderStatus 3.0.0 isn't supported (supported: 1.0.0, 2.0.0)",
      "orderStatus URL isn't https: http://x",
    ]);
  });
});
