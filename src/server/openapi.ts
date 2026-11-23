/** The request body for SanMar orders. */
export const SANMAR_ORDER_SCHEMA = {
  type: "object",
  required: ["poNumber", "shipTo", "residential", "lines"],
  properties: {
    poNumber: { type: "string", maxLength: 28 },
    shipTo: {
      type: "object",
      required: ["address1", "city", "state", "zip"],
      properties: { company: { type: "string", maxLength: 28 }, attention: { type: "string", maxLength: 35 }, address1: { type: "string", maxLength: 35 }, address2: { type: "string", maxLength: 35 }, city: { type: "string", maxLength: 28 }, state: { type: "string", minLength: 2, maxLength: 2 }, zip: { type: "string" }, email: { type: "string", maxLength: 105 } },
    },
    residential: { type: "boolean" },
    shipMethod: { type: "string", description: "UPS (default), UPS 2ND DAY, UPS 2ND DAY AM, UPS 3RD DAY, UPS NEXT DAY, UPS NEXT DAY EA, UPS NEXT DAY SV, UPS SATURDAY, USPS PP, USPS APP, PSST, TRUCK" },
    notes: { type: "string", maxLength: 100 },
    lines: {
      type: "array",
      minItems: 1,
      items: { type: "object", required: ["quantity"], properties: { style: { type: "string" }, color: { type: "string", description: "SanMar's catalog (mainframe) color" }, size: { type: "string" }, inventoryKey: { type: "string" }, sizeIndex: { type: "string" }, quantity: { type: "integer", minimum: 1 }, warehouse: { type: "string" } } },
    },
  },
} as const;

/** The API described as OpenAPI 3.1, served at /openapi.json, so anyone can generate a client. */
export function openApiDocument(origin: string) {
  const supplier = { name: "supplier", in: "path", required: true, schema: { type: "string" }, description: 'A configured supplier id, e.g. "sanmar" (see GET /v1/suppliers).' };
  const ok = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
  const errors = {
    "400": { $ref: "#/components/responses/Error" },
    "401": { $ref: "#/components/responses/Error" },
    "404": { $ref: "#/components/responses/Error" },
    "424": { $ref: "#/components/responses/Error" },
    "429": { $ref: "#/components/responses/Error" },
    "502": { $ref: "#/components/responses/Error" },
    "504": { $ref: "#/components/responses/Error" },
  };
  const get = (summary: string, parameters: unknown[], description: string) => ({ get: { summary, parameters: [supplier, ...parameters], responses: { "200": ok(description), ...errors } } });
  const path = (name: string, description: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description });
  const query = (name: string, description: string) => ({ name, in: "query", required: false, schema: { type: "string" }, description });
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenPromo",
      version: "0.1.0",
      description:
        "A free, self-hosted REST API over PromoStandards and SanMar web services. Money is in cents. Every /v1 call needs `Authorization: Bearer <OPENPROMO_API_KEY>` and the login of the account it is for, in headers: `X-SanMar-Customer-Number`, `X-SanMar-Username`, `X-SanMar-Password` (optional `X-SanMar-Environment: edev`) for SanMar, `X-Supplier-Id` and `X-Supplier-Password` for other PromoStandards suppliers. The server uses it for that request only and keeps nothing. Errors are `{ error: { kind, message, detail?, code?, supplier? } }`; `kind` is one of invalid, unauthorized, not_found, not_yet (shipped or invoiced data isn't there yet), auth / not_enabled / refused (the supplier turned the request down), rate_limited, unreachable, bad_response, duplicate, orders_off.",
      license: { name: "MIT" },
    },
    servers: [{ url: origin }],
    components: {
      schemas: { SanmarOrder: SANMAR_ORDER_SCHEMA },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      responses: {
        Error: {
          description: "An error",
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", required: ["kind", "message"], properties: { kind: { type: "string" }, message: { type: "string" }, detail: { type: "string" }, code: { type: "string" }, supplier: { type: "string" } } } } } } },
        },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      "/health": { get: { summary: "Is the server up", security: [], responses: { "200": ok("ok and the configured supplier ids") } } },
      "/v1/suppliers": { get: { summary: "Configured suppliers and their services", responses: { "200": ok("suppliers") } } },
      "/v1/{supplier}/products/{productId}": get("A product: SanMar Product Info for SanMar, PromoStandards Product Data otherwise", [path("productId", "Style or product id")], "the product"),
      "/v1/{supplier}/products/{productId}/inventory": get("Stock per part and warehouse (PromoStandards Inventory 2.0.0)", [path("productId", "Style or product id"), query("partId", "Only these parts (repeat for several)")], "inventory"),
      "/v1/{supplier}/products/{productId}/pricing": get(
        "Prices. SanMar without priceType: its Pricing service, with myPrice (the account's own). With priceType: PromoStandards Pricing and Configuration.",
        [path("productId", "Style or product id"), query("priceType", "Net, List or Customer"), query("partId", "One part"), query("fobId", "FOB point (warehouse)")],
        "prices",
      ),
      "/v1/{supplier}/orders/{poNumber}": get("Where the supplier's orders under this PO stand (Order Status). Ask sparingly: suppliers ask for a few calls a day per order at most.", [path("poNumber", "Your PO number")], "the order status"),
      "/v1/{supplier}/orders/{poNumber}/shipments": get("Packages and tracking (Order Shipment Notification)", [path("poNumber", "Your PO number")], "shipments, empty until something ships"),
      "/v1/{supplier}/invoices": get("Invoices by PO, invoice number, invoice date, or since a time", [query("po", "PO number"), query("invoice", "Invoice number"), query("date", "YYYY-MM-DD"), query("since", "ISO time")], "invoices, empty until invoiced"),
      "/v1/sanmar/orders/preview": {
        post: { summary: "Check a SanMar order without placing it (getPreSubmitInfo): per line ok, short or not_found, and the warehouse", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SanmarOrder" } } } }, responses: { "200": ok("the check"), ...errors } },
      },
      "/v1/sanmar/orders": {
        post: {
          summary: "Place a SanMar order (submitPO). Off unless OPENPROMO_ORDERS=on. Refused with 409 when SanMar already has a live order under the PO number.",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SanmarOrder" } } } },
          responses: { "201": ok("accepted"), "403": { $ref: "#/components/responses/Error" }, "409": { $ref: "#/components/responses/Error" }, ...errors },
        },
      },
    },
    "x-schemas-note": "Response shapes are the TypeScript types exported by the openpromo package (Product, Inventory, Pricing, OrderStatus, Shipment, Invoice, SanmarProduct, SanmarPrice, SanmarPreSubmit).",
  } as const;
}

