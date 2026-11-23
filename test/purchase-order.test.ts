import { describe, expect, it } from "vitest";
import { buildPurchaseOrder, checkSupplierConfig, OpenPromoError, PromoStandardsClient, promoStandardsCapabilities, SUPPORTED_VERSIONS, type PurchaseOrderInput } from "../src/index.js";
import { buildSoapEnvelope } from "../src/soap.js";
import { elementsOf, fakeSoap, fixture } from "./helpers.js";

const login = { id: "webuser", password: "s3cret&<" };
const ACME = {
  id: "acme",
  name: "Acme Promo",
  endpoints: {
    purchaseOrder: { version: "1.0.0", url: "https://ps.acme.example/po" },
    orderStatus: { version: "2.0.0", url: "https://ps.acme.example/orderstatus" },
  },
};
const acme = (routes: Parameters<typeof fakeSoap>[0]) => {
  const fake = fakeSoap(routes);
  return { ps: new PromoStandardsClient(ACME, login, { fetch: fake.fetch }), calls: fake.calls };
};

const order = (over: Partial<PurchaseOrderInput> = {}): PurchaseOrderInput => ({
  poNumber: "1042-1",
  orderDate: "2026-11-23T15:04:05Z",
  currency: "USD",
  paymentTerms: "NET30",
  shipTo: { companyName: "Inkline Print Co", attentionTo: "Pat", address1: "12 Main St", city: "Austin", region: "TX", postalCode: "78701", country: "US", email: "pat@example.com", phone: "512-555-0100" },
  carrier: "UPS",
  service: "GROUND",
  lines: [
    { productId: "PC54", partId: "118032", quantity: 12, unitPrice: 312, description: "Core Cotton Tee, Jet Black, L" },
    { productId: "PC54", partId: "118036", quantity: 6, unitPrice: 412 },
  ],
  ...over,
});

const NS = "http://www.promostandards.org/WSDL/PO/1.0.0/";

describe("Purchase Order 1.0.0: building a Blank order", () => {
  it("adds purchaseOrder at 1.0.0 without giving PromoStandards suppliers a new capability", () => {
    expect(SUPPORTED_VERSIONS.purchaseOrder).toEqual(["1.0.0"]);
    expect(checkSupplierConfig(ACME)).toEqual([]);
    expect(checkSupplierConfig({ ...ACME, endpoints: { purchaseOrder: { version: "1.1.0", url: "https://x.example" } } })).toEqual(["purchaseOrder 1.1.0 isn't supported (supported: 1.0.0)"]);
    expect(promoStandardsCapabilities(ACME)).toEqual(["orderStatus"]);
  });

  it("prices every line from the order, totals each line and the order, in the schema's order and namespaces", () => {
    const built = buildPurchaseOrder(order());
    expect(built.total).toBe(12 * 312 + 6 * 412);
    expect(built.lines).toEqual([
      { lineNumber: 1, productId: "PC54", partId: "118032", quantity: 12, uom: "EA", unitPrice: 312, lineTotal: 3744 },
      { lineNumber: 2, productId: "PC54", partId: "118036", quantity: 6, uom: "EA", unitPrice: 412, lineTotal: 2472 },
    ]);
    expect(built.changes).toEqual([]);
    const xml = buildSoapEnvelope({ namespace: NS, operation: "SendPORequest", namespaces: { shar: `${NS}SharedObjects/` }, childPrefix: "shar", body: { "ns:PO": built.request } });
    // PO's own fields in the service namespace, in sequence; currency is a shared object.
    expect(xml).toContain(
      "<ns:PO><ns:orderType>Blank</ns:orderType><ns:orderNumber>1042-1</ns:orderNumber><ns:orderDate>2026-11-23T15:04:05Z</ns:orderDate><ns:totalAmount>62.16</ns:totalAmount><ns:paymentTerms>NET30</ns:paymentTerms><ns:rush>false</ns:rush><shar:currency>USD</shar:currency><ns:ShipmentArray><shar:Shipment>",
    );
    expect(xml).toContain(
      "<shar:allowConsolidation>false</shar:allowConsolidation><shar:blindShip>false</shar:blindShip><shar:packingListRequired>false</shar:packingListRequired><shar:FreightDetails><shar:carrier>UPS</shar:carrier><shar:service>GROUND</shar:service></shar:FreightDetails><shar:ShipTo><shar:customerPickup>false</shar:customerPickup><shar:ContactDetails><shar:attentionTo>Pat</shar:attentionTo><shar:companyName>Inkline Print Co</shar:companyName><shar:address1>12 Main St</shar:address1><shar:city>Austin</shar:city><shar:region>TX</shar:region><shar:postalCode>78701</shar:postalCode><shar:country>US</shar:country><shar:email>pat@example.com</shar:email><shar:phone>512-555-0100</shar:phone></shar:ContactDetails><shar:shipmentId>1</shar:shipmentId></shar:ShipTo></shar:Shipment></ns:ShipmentArray>",
    );
    expect(xml).toContain(
      "<ns:LineItemArray><ns:LineItem><ns:lineNumber>1</ns:lineNumber><shar:description>Core Cotton Tee, Jet Black, L</shar:description><ns:lineType>New</ns:lineType><shar:Quantity><shar:uom>EA</shar:uom><shar:value>12</shar:value></shar:Quantity><shar:ToleranceDetails><shar:tolerance>ExactOnly</shar:tolerance></shar:ToleranceDetails><ns:allowPartialShipments>false</ns:allowPartialShipments><shar:unitPrice>3.12</shar:unitPrice><ns:lineItemTotal>37.44</ns:lineItemTotal><shar:productId>PC54</shar:productId><ns:PartArray><shar:Part><shar:partId>118032</shar:partId><shar:customerSupplied>false</shar:customerSupplied><shar:Quantity><shar:uom>EA</shar:uom><shar:value>12</shar:value></shar:Quantity><shar:unitPrice>3.12</shar:unitPrice><shar:extendedPrice>37.44</shar:extendedPrice></shar:Part></ns:PartArray></ns:LineItem>",
    );
    // A required description the caller didn't give goes empty, never made up; termsAndConditions is required too.
    expect(xml).toContain("<ns:lineNumber>2</ns:lineNumber><shar:description></shar:description>");
    expect(xml).toContain("</ns:LineItemArray><ns:termsAndConditions></ns:termsAndConditions></ns:PO>");
    expect(xml).not.toContain("OrderContactArray");
  });

  it("merges identical lines, fills in the currency, country and order date, and says so in changes", () => {
    const built = buildPurchaseOrder(
      order({
        orderDate: undefined,
        currency: undefined,
        shipTo: { address1: "12 Main St", city: "Austin", region: "tx", postalCode: "78701" },
        lines: [
          { productId: "PC54", partId: "118032", quantity: 12, unitPrice: 312, requestedInHandsDate: "2026-12-01" },
          { productId: "pc54", partId: "118032", quantity: 3, unitPrice: 312, requestedInHandsDate: "2026-12-01" },
        ],
      }),
      { now: new Date("2026-11-23T18:00:00.123Z") },
    );
    expect(built.lines).toEqual([{ lineNumber: 1, productId: "PC54", partId: "118032", quantity: 15, uom: "EA", unitPrice: 312, lineTotal: 4680 }]);
    expect(built.total).toBe(4680);
    expect(built.changes).toEqual([
      "orderDate: 2026-11-23T18:00:00Z, now, as none was given",
      "currency: USD, as none was given",
      "shipTo country: US, as none was given",
      "line 1 requestedInHandsDate: 2026-12-01 sent as 2026-12-01T00:00:00 (the schema takes a date and time)",
      "line 2 requestedInHandsDate: 2026-12-01 sent as 2026-12-01T00:00:00 (the schema takes a date and time)",
      "line 2 (pc54 118032) merged into line 1, the same part",
    ]);
    const shipTo = (built.request["ns:ShipmentArray"] as { Shipment: { ShipTo: { ContactDetails: Record<string, unknown> } } }).Shipment.ShipTo.ContactDetails;
    expect(shipTo.region).toBe("TX");
    expect(shipTo.country).toBe("US");
  });

  it("sends contacts, ship references and the caller's choices", () => {
    const built = buildPurchaseOrder(
      order({ rush: true, blindShip: true, allowPartialShipments: true, shipReferences: ["JOB 88"], contacts: [{ type: "Order", details: { attentionTo: "Sam", email: "sam@example.com" } }], total: 6216, termsAndConditions: "Standard terms" }),
    );
    const xml = buildSoapEnvelope({ namespace: NS, operation: "SendPORequest", childPrefix: "shar", body: { "ns:PO": built.request } });
    expect(xml).toContain("<ns:rush>true</ns:rush>");
    expect(xml).toContain("<ns:OrderContactArray><shar:Contact><shar:contactType>Order</shar:contactType><shar:ContactDetails><shar:attentionTo>Sam</shar:attentionTo><shar:email>sam@example.com</shar:email></shar:ContactDetails></shar:Contact></ns:OrderContactArray><ns:ShipmentArray><shar:Shipment><shar:shipReferences>JOB 88</shar:shipReferences>");
    expect(xml).toContain("<shar:blindShip>true</shar:blindShip>");
    expect(elementsOf(xml, "allowPartialShipments")).toEqual(["true", "true"]);
    expect(xml).toContain("<ns:termsAndConditions>Standard terms</ns:termsAndConditions>");
  });

  it("refuses a bad order with everything that's wrong, before sending anything", async () => {
    const { ps, calls } = acme({ SendPORequest: fixture("promostandards/po-1.0.0-sent.xml") });
    const bad = order({
      orderType: "Sample",
      poNumber: "",
      currency: "XYZ",
      carrier: "",
      shipReferences: ["a", "b", "c"],
      shipTo: { address1: "12 Main St, Building 4, Suite 1200, Rear Dock", city: "Austin", region: "Texas", postalCode: "787", country: "US" },
      lines: [
        { productId: "PC54", partId: "118032", quantity: 12 } as unknown as PurchaseOrderInput["lines"][number],
        { productId: "PC54", partId: "", quantity: 0, unitPrice: 3.5 },
        { productId: "PC54", partId: "118036", quantity: 1, unitPrice: 100, uom: "XX" as "EA" },
      ],
    });
    const err = await ps.sendPurchaseOrder(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenPromoError);
    expect((err as OpenPromoError).kind).toBe("invalid");
    expect((err as OpenPromoError).supplier).toBe("acme");
    expect((err as OpenPromoError).detail!.split("; ")).toEqual([
      'orderType "Sample" isn\'t built yet: OpenPromo sends Blank orders only',
      "poNumber is required",
      'currency "XYZ" isn\'t an ISO 4217 code the PO schema lists',
      "shipTo address1 is 45 characters, over the PO schema's 35",
      "shipTo region is 5 characters, over the PO schema's 3",
      'shipTo postalCode "787" isn\'t a US ZIP',
      "carrier is required",
      "shipReferences has 3 entries, over the PO schema's 2",
      "line 1 has no unitPrice: every line carries the buyer's price, in cents (OpenPromo never looks one up)",
      "line 2 partId is required",
      "line 2 quantity must be a whole number of at least 1",
      "line 2 unitPrice must be a whole number of cents above 0",
      'line 3 uom "XX" isn\'t one of BX, CA, DZ, EA, KT, PK, PR, RL, SL, ST, TH',
    ]);
    expect(calls).toHaveLength(0);
  });

  it("refuses a total the lines don't add up to, the same part at two prices, and an order with no lines", () => {
    expect(() => buildPurchaseOrder(order({ total: 6000 }))).toThrow(/the lines add up to 6216 cents, not the 6000 given as total/);
    expect(() => buildPurchaseOrder(order({ lines: [{ productId: "PC54", partId: "1", quantity: 1, unitPrice: 100 }, { productId: "PC54", partId: "1", quantity: 1, unitPrice: 120 }] }))).toThrow(/line 2 is the same as line 1 but at a different unitPrice/);
    expect(() => buildPurchaseOrder(order({ lines: [] }))).toThrow(/an order needs at least one line/);
    expect(() => buildPurchaseOrder(order({ orderDate: "23/11/2026" }))).toThrow(/orderDate "23\/11\/2026" isn't an ISO 8601 date or date-time/);
  });

  it("needs no address for a pickup", () => {
    const built = buildPurchaseOrder(order({ customerPickup: true, shipTo: { attentionTo: "Pat" } }));
    expect(built.changes).toEqual([]);
    const shipTo = (built.request["ns:ShipmentArray"] as { Shipment: { ShipTo: Record<string, unknown> } }).Shipment.ShipTo;
    expect(shipTo.customerPickup).toBe(true);
  });
});

describe("Purchase Order 1.0.0: sending", () => {
  it("sends once to sendPO with the login and answers the transaction id", async () => {
    const { ps, calls } = acme({ SendPORequest: fixture("promostandards/po-1.0.0-sent.xml") });
    const placed = await ps.sendPurchaseOrder(order());
    expect(placed).toEqual({
      accepted: true,
      poNumber: "1042-1",
      transactionId: "TX-778201",
      total: 6216,
      messages: [{ code: "999", description: "Line 2 will ship from a second warehouse", severity: "Information" }],
      changes: [],
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://ps.acme.example/po");
    expect(call.soapAction).toBe("sendPO");
    expect(call.xml).toContain(`xmlns:ns="${NS}"`);
    expect(call.xml).toContain(`xmlns:shar="${NS}SharedObjects/"`);
    expect(call.xml).toContain("<ns:SendPORequest><shar:wsVersion>1.0.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password><ns:PO><ns:orderType>Blank</ns:orderType>");
  });

  it("reads a refusal message as refused, with the supplier's words", async () => {
    const { ps, calls } = acme({ SendPORequest: fixture("promostandards/po-1.0.0-refused.xml") });
    const err = (await ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect([err.kind, err.code, err.detail]).toEqual(["refused", "999", "Account 40112 is on credit hold"]);
    expect(calls).toHaveLength(1);
  });

  it("reads a standard code (105) as its kind, and a message that would mean 'unknown' as refused", async () => {
    const msg = (code: string, description: string) =>
      `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns1:SendPOResponse xmlns:ns1="${NS}" xmlns:ns2="${NS}SharedObjects/"><ns2:ServiceMessageArray><ns2:ServiceMessage><ns2:code>${code}</ns2:code><ns2:description>${description}</ns2:description><ns2:severity>Error</ns2:severity></ns2:ServiceMessage></ns2:ServiceMessageArray></ns1:SendPOResponse></S:Body></S:Envelope>`;
    const auth = (await acme({ SendPORequest: msg("105", "Authentication Credentials failed") }).ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect(auth.kind).toBe("auth");
    const version = (await acme({ SendPORequest: msg("115", "wsVersion not found") }).ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect([version.kind, version.code]).toEqual(["refused", "115"]);
  });

  it("answers a 5xx as unreachable, saying the order may have gone through, after one request", async () => {
    const { ps, calls } = acme({ SendPORequest: { status: 503, body: "Service Unavailable" } });
    const err = (await ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect(err.kind).toBe("unreachable");
    expect(err.status).toBe(503);
    expect(err.message).toBe("Acme Promo answered HTTP 503, so the order may or may not have been placed. Look PO 1042-1 up (Order Status) before sending it again.");
    expect(calls).toHaveLength(1);
  });

  it("answers a timeout as unreachable, saying the order may have gone through, after one request", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const { ps, calls } = acme({ SendPORequest: timeout });
    const err = (await ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect([err.kind, err.detail]).toEqual(["unreachable", "timed out"]);
    expect(err.message).toMatch(/^Acme Promo didn't answer, so the order may or may not have been placed\. Look PO 1042-1 up/);
    expect(calls).toHaveLength(1);
  });

  it("answers an answer without a transaction id as bad_response, saying the order may have gone through", async () => {
    const { ps, calls } = acme({ SendPORequest: fixture("promostandards/po-1.0.0-no-transaction.xml") });
    const err = (await ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect(err.kind).toBe("bad_response");
    expect(err.message).toMatch(/answered without a transaction id, so the order may or may not have been placed/);
    expect(calls).toHaveLength(1);
  });

  it("answers an answer that isn't a SendPOResponse, or says both yes and no, as bad_response", async () => {
    const notPo = await acme({ SendPORequest: "<html>Welcome</html>" })
      .ps.sendPurchaseOrder(order())
      .catch((e: unknown) => e);
    expect((notPo as OpenPromoError).kind).toBe("bad_response");
    const both = fixture("promostandards/po-1.0.0-refused.xml").replace("<ns2:ServiceMessageArray>", "<ns1:transactionId>TX-1</ns1:transactionId><ns2:ServiceMessageArray>");
    const err = (await acme({ SendPORequest: both }).ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect(err.kind).toBe("bad_response");
    expect(err.message).toMatch(/answered both a transaction id \(TX-1\) and an error, so the order may or may not have been placed/);
  });

  it("reads a SOAP fault as refused and a 401 as auth: the supplier said no", async () => {
    const fault = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Invalid PO</faultstring></S:Fault></S:Body></S:Envelope>`;
    const refused = (await acme({ SendPORequest: { status: 500, body: fault } }).ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect([refused.kind, refused.detail]).toEqual(["refused", "Invalid PO"]);
    const auth = (await acme({ SendPORequest: { status: 401, body: "" } }).ps.sendPurchaseOrder(order()).catch((e: unknown) => e)) as OpenPromoError;
    expect(auth.kind).toBe("auth");
  });

  it("is not_enabled for a supplier with no purchaseOrder endpoint, before sending", async () => {
    const fake = fakeSoap({});
    const ps = new PromoStandardsClient({ ...ACME, endpoints: { orderStatus: ACME.endpoints.orderStatus } }, login, { fetch: fake.fetch });
    await expect(ps.sendPurchaseOrder(order())).rejects.toMatchObject({ kind: "not_enabled" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Purchase Order 1.0.0: getSupportedOrderTypes", () => {
  it("asks with the login only and answers the order types, each once", async () => {
    const { ps, calls } = acme({ GetSupportedOrderTypesRequest: fixture("promostandards/po-1.0.0-supported-order-types.xml") });
    expect(await ps.getSupportedOrderTypes()).toEqual(["Blank", "Configured", "Sample"]);
    expect(calls[0]!.soapAction).toBe("getSupportedOrderTypes");
    expect(calls[0]!.xml).toContain("<ns:GetSupportedOrderTypesRequest><shar:wsVersion>1.0.0</shar:wsVersion><shar:id>webuser</shar:id><shar:password>s3cret&amp;&lt;</shar:password></ns:GetSupportedOrderTypesRequest>");
  });

  it("answers none as an empty list, and reads a service message", async () => {
    const empty = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns1:GetSupportedOrderTypesResponse xmlns:ns1="${NS}"/></S:Body></S:Envelope>`;
    expect(await acme({ GetSupportedOrderTypesRequest: empty }).ps.getSupportedOrderTypes()).toEqual([]);
    const err = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns1:GetSupportedOrderTypesResponse xmlns:ns1="${NS}" xmlns:ns2="${NS}SharedObjects/"><ns2:ServiceMessageArray><ns2:ServiceMessage><ns2:code>104</ns2:code><ns2:description>Account not authorized</ns2:description><ns2:severity>Error</ns2:severity></ns2:ServiceMessage></ns2:ServiceMessageArray></ns1:GetSupportedOrderTypesResponse></S:Body></S:Envelope>`;
    await expect(acme({ GetSupportedOrderTypesRequest: err }).ps.getSupportedOrderTypes()).rejects.toMatchObject({ kind: "not_enabled" });
  });
});
