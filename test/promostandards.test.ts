import { describe, expect, it } from "vitest";
import { checkSupplierConfig, OpenPromoError, SUPPORTED_VERSIONS, PromoStandardsClient, SANMAR_PROMOSTANDARDS, orderStateOf, parseOrderStatusV1, promoStandardsCapabilities, promoStandardsConnection } from "../src/index.js";
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

describe("Order Shipment Notification 2.0.0", () => {
  const ACME = { id: "acme", name: "Acme Promo", endpoints: { shipments: { version: "2.0.0", url: "https://ps.acme.example/osn2" } } };
  const acme = (answer: string) => {
    const fake = fakeSoap({ GetOrderShipmentNotificationRequest: answer });
    return { ps: new PromoStandardsClient(ACME, login, { fetch: fake.fetch }), calls: fake.calls };
  };

  it("is a supported config", () => {
    expect(checkSupplierConfig(ACME)).toEqual([]);
    expect(checkSupplierConfig({ ...ACME, endpoints: { shipments: { version: "2.2.0", url: "https://x.example" } } })).toEqual(["shipments 2.2.0 isn't supported (supported: 1.0.0, 2.0.0, 2.1.0)"]);
  });

  it("asks by PO with the 2.0.0 namespace, every field a shared object as the schema has it", async () => {
    const { ps, calls } = acme(fixture("promostandards/shipments-2.0.0.xml"));
    await ps.getShipments({ poNumber: "PO2001" });
    const call = calls[0]!;
    expect(call.url).toBe("https://ps.acme.example/osn2");
    expect(call.soapAction).toBe("getOrderShipmentNotification");
    expect(call.xml).toContain('xmlns:ns="http://www.promostandards.org/WSDL/OrderShipmentNotificationService/2.0.0/"');
    expect(call.xml).toContain('xmlns:shar="http://www.promostandards.org/WSDL/OrderShipmentNotificationService/2.0.0/SharedObjects/"');
    expect(call.xml).toContain("<ns:GetOrderShipmentNotificationRequest>");
    expect(call.xml).toContain("<shar:wsVersion>2.0.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password><shar:queryType>1</shar:queryType><shar:referenceNumber>PO2001</shar:referenceNumber>");
    expect(call.xml).not.toContain("<ns:queryType>");
  });

  it("asks by sales order and since a time (`shipmentDateTimestamp`, 2.0.0's spelling)", async () => {
    const { ps, calls } = acme(fixture("promostandards/shipments-2.0.0.xml"));
    await ps.getShipments({ salesOrderNumber: "SO-100" });
    await ps.getShipments({ since: "2026-11-20T00:00:00" });
    expect(calls.map((c) => elementsOf(c.xml, "queryType")[0])).toEqual(["2", "3"]);
    expect(calls[0]!.xml).toContain("<shar:referenceNumber>SO-100</shar:referenceNumber>");
    expect(calls[1]!.xml).toContain("<shar:shipmentDateTimestamp>2026-11-20T00:00:00</shar:shipmentDateTimestamp>");
    expect(calls[1]!.xml).not.toContain("referenceNumber");
  });

  it("reads several packages and items, addresses, weight, dimensions and freight; a partial pickup shipment", async () => {
    const shipments = await acme(fixture("promostandards/shipments-2.0.0.xml")).ps.getShipments({ poNumber: "PO2001" });
    const dc = { address1: "100 Warehouse Way", city: "Irving", region: "TX", postalCode: "75038" };
    expect(shipments).toEqual([
      {
        purchaseOrderNumber: "PO2001",
        salesOrderNumber: "SO-100",
        complete: true,
        packages: [
          {
            trackingNumber: "1Z999AA10123456784",
            carrier: "UPS",
            method: "Ground",
            shippedOn: "2026-11-20",
            items: [
              { productId: "PC54", partId: "538612", quantity: 24, uom: "EA", lineNumber: "1" },
              { productId: "PC54", partId: "538613", quantity: 12, uom: "EA", lineNumber: "2" },
            ],
            shipFrom: { ...dc, companyName: "Acme Promo DC", country: "US" },
            shipTo: { attentionTo: "Receiving", companyName: "Ink Shop", address1: "12 Main St", address2: "Suite 4", city: "Jacksonville", region: "FL", postalCode: "32218", country: "US", phone: "904-555-0100" },
            destinationType: "Commercial",
            customerPickup: false,
            weight: { value: 14.2, uom: "Pounds" },
            dimensions: { uom: "Inches", length: 18, width: 12, height: 10.5 },
            shippingAccount: "A1B2C3",
            shipmentTerms: "Prepaid",
          },
          {
            trackingNumber: "1Z999AA10123456785",
            carrier: "UPS",
            method: "Ground",
            shippedOn: "2026-11-20",
            items: [{ productId: "K420", partId: "92032", quantity: 6, uom: "EA" }],
            shipFrom: { ...dc, companyName: "Acme Promo DC", country: "US" },
            shipTo: expect.objectContaining({ address1: "12 Main St" }),
            destinationType: "Commercial",
            customerPickup: false,
          },
        ],
      },
      {
        purchaseOrderNumber: "PO2001",
        salesOrderNumber: "SO-101",
        complete: false,
        packages: [{ trackingNumber: "", carrier: undefined, method: undefined, shippedOn: "2026-11-21", items: [{ productId: "ST860", partId: "1019704", quantity: 2, uom: "DZ", lineNumber: "3" }], shipFrom: dc, shipTo: dc, customerPickup: true }],
      },
    ]);
    // Left out, not empty, when the supplier doesn't say.
    expect(Object.keys(shipments[0]!.packages[1]!)).not.toContain("weight");
    expect(Object.keys(shipments[1]!.packages[0]!)).not.toContain("destinationType");
  });

  it("nothing shipped yet (301) is no shipments; a refused login throws auth", async () => {
    expect(await acme(fixture("promostandards/error-301-osn-2.0.0.xml")).ps.getShipments({ poNumber: "X" })).toEqual([]);
    const refused = fixture("promostandards/error-105.xml").replaceAll("GetOrderStatusResponse", "GetOrderShipmentNotificationResponse");
    await expect(acme(refused).ps.getShipments({ poNumber: "X" })).rejects.toMatchObject({ kind: "auth", code: "105", supplier: "acme" });
  });

  it("an empty answer is no shipments", async () => {
    const empty = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:GetOrderShipmentNotificationResponse xmlns:ns2="http://www.promostandards.org/WSDL/OrderShipmentNotificationService/2.0.0/"></ns2:GetOrderShipmentNotificationResponse></S:Body></S:Envelope>`;
    expect(await acme(empty).ps.getShipments({ since: "2026-11-20T00:00:00" })).toEqual([]);
  });
});

describe("Order Shipment Notification 2.1.0", () => {
  const ACME = { id: "acme", name: "Acme Promo", endpoints: { shipments: { version: "2.1.0", url: "https://ps.acme.example/osn21" } } };
  const acme = (answer: string) => {
    const fake = fakeSoap({ GetOrderShipmentNotificationRequest: answer });
    return { ps: new PromoStandardsClient(ACME, login, { fetch: fake.fetch }), calls: fake.calls };
  };

  it("is a supported config, after 1.0.0 and 2.0.0", () => {
    expect(SUPPORTED_VERSIONS.shipments).toEqual(["1.0.0", "2.0.0", "2.1.0"]);
    expect(checkSupplierConfig(ACME)).toEqual([]);
  });

  it("asks by PO, sales order and since a time with the 2.1.0 namespace, every field a shared object", async () => {
    const { ps, calls } = acme(fixture("promostandards/shipments-2.1.0.xml"));
    await ps.getShipments({ poNumber: "PO2101" });
    await ps.getShipments({ salesOrderNumber: "SO-211" });
    await ps.getShipments({ since: "2026-11-22T00:00:00" });
    const call = calls[0]!;
    expect(call.url).toBe("https://ps.acme.example/osn21");
    expect(call.soapAction).toBe("getOrderShipmentNotification");
    expect(call.xml).toContain('xmlns:ns="http://www.promostandards.org/WSDL/OrderShipmentNotificationService/2.1.0/"');
    expect(call.xml).toContain('xmlns:shar="http://www.promostandards.org/WSDL/OrderShipmentNotificationService/2.1.0/SharedObjects/"');
    expect(call.xml).toContain("<ns:GetOrderShipmentNotificationRequest>");
    expect(call.xml).toContain("<shar:wsVersion>2.1.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password><shar:queryType>1</shar:queryType><shar:referenceNumber>PO2101</shar:referenceNumber>");
    expect(call.xml).not.toContain("<ns:queryType>");
    expect(calls.map((c) => elementsOf(c.xml, "queryType")[0])).toEqual(["1", "2", "3"]);
    expect(calls[1]!.xml).toContain("<shar:referenceNumber>SO-211</shar:referenceNumber>");
    expect(calls[2]!.xml).toContain("<shar:shipmentDateTimestamp>2026-11-22T00:00:00</shar:shipmentDateTimestamp>");
    expect(calls[2]!.xml).not.toContain("referenceNumber");
  });

  it("reads the answer, its elements all in SharedObjects, in the shared shape", async () => {
    const shipments = await acme(fixture("promostandards/shipments-2.1.0.xml")).ps.getShipments({ poNumber: "PO2101" });
    const dc = { address1: "100 Warehouse Way", city: "Irving", region: "TX", postalCode: "75038" };
    const shop = { address1: "12 Main St", city: "Jacksonville", region: "FL", postalCode: "32218" };
    expect(shipments).toEqual([
      {
        purchaseOrderNumber: "PO2101",
        salesOrderNumber: "SO-210",
        complete: true,
        packages: [
          {
            trackingNumber: "9400111899223100012345",
            carrier: "USPS",
            method: "Priority Mail",
            shippedOn: "2026-11-22",
            items: [{ productId: "PC54", partId: "538612", quantity: 48, uom: "EA", lineNumber: "1" }],
            shipFrom: { ...dc, companyName: "Acme Promo DC", country: "US" },
            shipTo: { ...shop, attentionTo: "Receiving", companyName: "Ink Shop", country: "US", email: "receiving@inkshop.example" },
            destinationType: "Residential",
            customerPickup: false,
            weight: { value: 3.25, uom: "kg" },
            dimensions: { uom: "cm", length: 40, width: 30 },
            shipmentTerms: "Collect",
          },
        ],
      },
      {
        purchaseOrderNumber: "PO2101",
        salesOrderNumber: "SO-211",
        complete: false,
        packages: [
          {
            trackingNumber: "1Z999AA10123456790",
            carrier: "UPS",
            method: "2nd Day Air",
            shippedOn: "2026-11-22",
            items: [
              { productId: "K420", partId: "92032", quantity: 1, uom: "BX" },
              { productId: "ST860", partId: undefined, quantity: 2.5, uom: "DZ", lineNumber: "4" },
            ],
            shipFrom: dc,
            shipTo: shop,
            customerPickup: false,
            shippingAccount: "ACCT-77",
          },
        ],
      },
    ]);
    // 2.1.0's `shipReferences` has no place in the shared shape: not read.
    expect(JSON.stringify(shipments)).not.toContain("DEPT 12");
    expect(Object.keys(shipments[0]!.packages[0]!.dimensions!)).not.toContain("height");
  });

  it("nothing shipped yet (301) is no shipments; a refused login throws auth", async () => {
    expect(await acme(fixture("promostandards/error-301-osn-2.1.0.xml")).ps.getShipments({ poNumber: "X" })).toEqual([]);
    const refused = fixture("promostandards/error-105.xml").replaceAll("GetOrderStatusResponse", "GetOrderShipmentNotificationResponse");
    await expect(acme(refused).ps.getShipments({ poNumber: "X" })).rejects.toMatchObject({ kind: "auth", code: "105", supplier: "acme" });
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

describe("Media Content 1.1.0", () => {
  const ACME = { id: "acme", name: "Acme Promo", endpoints: { media: { version: "1.1.0", url: "https://ps.acme.example/media" } } };
  const acme = (routes: Parameters<typeof fakeSoap>[0]) => {
    const fake = fakeSoap(routes);
    return { ps: new PromoStandardsClient(ACME, login, { fetch: fake.fetch }), calls: fake.calls };
  };
  // An answer carrying only an errorMessage, as SharedMediaObjects.xsd shapes it (or bare words, which some suppliers send).
  const errorAnswer = (inner: string) =>
    `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns1:GetMediaContentResponse xmlns:ns1="http://www.promostandards.org/WSDL/MediaService/1.0.0/" xmlns:ns2="http://www.promostandards.org/WSDL/MediaService/1.0.0/SharedObjects/"><ns2:errorMessage>${inner}</ns2:errorMessage></ns1:GetMediaContentResponse></S:Body></S:Envelope>`;
  const message = (code: string, description: string) => errorAnswer(`<ns2:code>${code}</ns2:code><ns2:description>${description}</ns2:description>`);

  it("is a supported config", () => {
    expect(SUPPORTED_VERSIONS.media).toEqual(["1.1.0"]);
    expect(checkSupplierConfig(ACME)).toEqual([]);
    expect(checkSupplierConfig({ ...ACME, endpoints: { media: { version: "1.0.0", url: "https://ps.acme.example/media" } } })).toEqual(["media 1.0.0 isn't supported (supported: 1.1.0)"]);
  });

  it("asks getMediaContent in the 1.0.0 namespace with wsVersion 1.1.0, Image by default, classType in the service namespace", async () => {
    const { ps, calls } = acme({ GetMediaContentRequest: fixture("promostandards/media-1.1.0-images.xml") });
    await ps.getMedia("TEE100");
    await ps.getMedia("TEE100", { mediaType: "Document", partId: "TEE100-NVY-L", classType: 1006, cultureName: "en-US" });
    const [plain, filtered] = calls;
    expect(plain!.url).toBe("https://ps.acme.example/media");
    expect(plain!.soapAction).toBe("getMediaContent");
    expect(plain!.xml).toContain('xmlns:ns="http://www.promostandards.org/WSDL/MediaService/1.0.0/"');
    expect(plain!.xml).toContain('xmlns:shar="http://www.promostandards.org/WSDL/MediaService/1.0.0/SharedObjects/"');
    expect(plain!.xml).toContain("<ns:GetMediaContentRequest><shar:wsVersion>1.1.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password><shar:mediaType>Image</shar:mediaType><shar:productId>TEE100</shar:productId></ns:GetMediaContentRequest>");
    // The schema's order: cultureName, mediaType, productId, partId, classType.
    expect(filtered!.xml).toContain("<shar:password>s3cret&amp;&lt;</shar:password><shar:cultureName>en-US</shar:cultureName><shar:mediaType>Document</shar:mediaType><shar:productId>TEE100</shar:productId><shar:partId>TEE100-NVY-L</shar:partId><ns:classType>1006</ns:classType>");
  });

  it("reads images with several class types and a part-specific picture in the shared shape", async () => {
    const media = await acme({ GetMediaContentRequest: fixture("promostandards/media-1.1.0-images.xml") }).ps.getMedia("TEE100");
    expect(media).toEqual({
      productId: "TEE100",
      items: [
        {
          url: "https://media.acme.example/TEE100/tee100-primary.jpg",
          mediaType: "Image",
          classTypes: [
            { id: "1006", name: "Primary" },
            { id: "1007", name: "Front" },
            { id: "500", name: "High" },
          ],
          description: "Classic tee, front",
          changedAt: "2026-11-02T14:05:00Z",
          width: 2000,
          height: 2400,
          dpi: 300,
          fileSize: 482133,
          singlePart: false,
        },
        {
          url: "https://media.acme.example/TEE100/tee100-navy-back.jpg",
          mediaType: "Image",
          partId: "TEE100-NVY-L",
          color: "Navy",
          classTypes: [{ id: "1008", name: "Rear" }],
          width: 1000,
          height: 1200,
          singlePart: true,
          decorations: [{ id: "1", name: "Screen Print" }],
          locations: [{ id: "12", name: "Full Back" }],
        },
      ],
    });
    // Left out, not empty, when not sent.
    expect(Object.keys(media.items[1]!)).not.toContain("description");
    expect(Object.keys(media.items[0]!)).not.toContain("decorations");
  });

  it("reads a document", async () => {
    const media = await acme({ GetMediaContentRequest: fixture("promostandards/media-1.1.0-document.xml") }).ps.getMedia("TEE100", { mediaType: "Document" });
    expect(media).toEqual({ productId: "TEE100", items: [{ url: "https://media.acme.example/TEE100/tee100-spec-sheet.pdf", mediaType: "Document", classTypes: [{ id: "2001", name: "Spec Sheet" }], singlePart: false }] });
  });

  it("no media is an empty list, not an error: an empty answer, 160, or the supplier's words", async () => {
    const empty = { productId: "TEE100", items: [] };
    expect(await acme({ GetMediaContentRequest: fixture("promostandards/media-1.1.0-empty.xml") }).ps.getMedia("TEE100")).toEqual(empty);
    expect(await acme({ GetMediaContentRequest: message("160", "No Results Found") }).ps.getMedia("TEE100")).toEqual(empty);
    expect(await acme({ GetMediaContentRequest: message("999", "No media found for product TEE100") }).ps.getMedia("TEE100")).toEqual(empty);
    expect(await acme({ GetMediaContentRequest: errorAnswer("Product Id not found") }).ps.getMedia("TEE100")).toEqual(empty);
  });

  it("maps error messages to typed errors, by code and else by wording; unknown wording is refused with the supplier's words", async () => {
    const fail = (answer: string) =>
      acme({ GetMediaContentRequest: answer })
        .ps.getMedia("TEE100")
        .then(() => null, (e: OpenPromoError) => [e.kind, e.code || null, e.detail ?? null]);
    expect(await fail(fixture("promostandards/error-media-1.1.0.xml"))).toEqual(["auth", "105", "Authentication Credentials failed"]);
    expect(await fail(message("104", "Account not authorized"))).toEqual(["not_enabled", "104", "Account not authorized"]);
    expect(await fail(message("999", "Invalid password"))).toEqual(["auth", "999", "Invalid password"]);
    expect(await fail(errorAnswer("Your account is not authorized to use the Media service"))).toEqual(["not_enabled", null, "Your account is not authorized to use the Media service"]);
    expect(await fail(errorAnswer("mediaType is required"))).toEqual(["invalid", null, "mediaType is required"]);
    expect(await fail(message("42", "Image server is down for maintenance"))).toEqual(["refused", "42", "Image server is down for maintenance"]);
    expect(await fail(message("999", "General Error"))).toEqual(["refused", "999", "General Error"]);
  });

  it("asks getMediaDateModified (SOAP action urn:getMediaDateModified) for the products whose media changed since a time", async () => {
    const { ps, calls } = acme({ GetMediaDateModifiedRequest: fixture("promostandards/media-date-modified-1.1.0.xml") });
    expect(await ps.getMediaChanges("2026-11-20T00:00:00Z")).toEqual(["TEE100", "CAP200"]);
    expect(calls[0]!.soapAction).toBe("urn:getMediaDateModified");
    expect(calls[0]!.xml).toContain('xmlns:ns="http://www.promostandards.org/WSDL/MediaService/1.0.0/"');
    expect(calls[0]!.xml).toContain("<ns:GetMediaDateModifiedRequest><shar:wsVersion>1.1.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password><shar:changeTimeStamp>2026-11-20T00:00:00Z</shar:changeTimeStamp></ns:GetMediaDateModifiedRequest>");
    const none = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns1:GetMediaDateModifiedResponse xmlns:ns1="http://www.promostandards.org/WSDL/MediaService/1.0.0/"/></S:Body></S:Envelope>`;
    expect(await acme({ GetMediaDateModifiedRequest: none }).ps.getMediaChanges("2026-11-20T00:00:00Z")).toEqual([]);
  });

  it("a supplier without the service says so; a media endpoint adds media and mediaChanges and leaves the others alone", async () => {
    const none = new PromoStandardsClient({ id: "acme", name: "Acme Promo", endpoints: { shipments: { version: "2.1.0", url: "https://ps.acme.example/osn21" } } }, login, { fetch: fakeSoap({}).fetch });
    await expect(none.getMedia("PC54")).rejects.toMatchObject({ kind: "not_enabled" });
    // SanMar lists Media Content 1.1.0, so its PromoStandards connection has media too (SanMar's driver answers media from Product Info instead).
    expect(SANMAR_PROMOSTANDARDS.endpoints.media).toEqual({ version: "1.1.0", url: "https://ws.sanmar.com:8080/promostandards/MediaContentServiceBinding", testUrl: "https://edev-ws.sanmar.com:8080/promostandards/MediaContentServiceBinding" });
    expect(Object.keys(promoStandardsConnection(new PromoStandardsClient(SANMAR_PROMOSTANDARDS, login)))).toEqual(["product", "productList", "productChanges", "inventory", "pricing", "orderStatus", "shipments", "invoices", "media", "mediaChanges"]);
    const both = { ...ACME, endpoints: { ...ACME.endpoints, shipments: { version: "2.1.0", url: "https://ps.acme.example/osn21" } } };
    expect(checkSupplierConfig(both)).toEqual([]);
    expect(promoStandardsCapabilities(both)).toEqual(["shipments", "media", "mediaChanges"]);
    expect(Object.keys(promoStandardsConnection(new PromoStandardsClient(both, login)))).toEqual(["shipments", "media", "mediaChanges"]);
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
