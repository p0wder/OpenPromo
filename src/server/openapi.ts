/**
 * The API described as OpenAPI 3.1, served at /openapi.json, so anyone can
 * generate a client. Built from the server's suppliers: the shared paths
 * once, and each driver's own routes under its id.
 */
import type { ServerConfig } from "./config.js";
import { PURCHASE_ORDER_SCHEMA } from "./schemas.js";

export function openApiDocument(origin: string, config?: Pick<ServerConfig, "suppliers">) {
  const supplier = { name: "supplier", in: "path", required: true, schema: { type: "string" }, description: 'A supplier id, e.g. "sanmar" or "ssactivewear" (see GET /v1/suppliers).' };
  const ok = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
  const errors = Object.fromEntries(["400", "401", "404", "424", "429", "502", "504"].map((s) => [s, { $ref: "#/components/responses/Error" }]));
  const get = (summary: string, parameters: unknown[], description: string) => ({ get: { summary, parameters: [supplier, ...parameters], responses: { "200": ok(description), ...errors } } });
  const path = (name: string, description: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description });
  /** A GET whose 200 answer is one of the component schemas. */
  const withSchema = (op: ReturnType<typeof get>, schema: string) => ({ get: { ...op.get, responses: { ...op.get.responses, "200": { description: op.get.responses["200"].description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } } } } });
  const query = (name: string, description: string) => ({ name, in: "query", required: false, schema: { type: "string" }, description });

  const pair = { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } };
  const schemas: Record<string, unknown> = {
    MediaItem: {
      type: "object",
      required: ["url", "mediaType", "classTypes"],
      description: "One picture, video, sound or document. Optional fields are left out when the supplier doesn't say.",
      properties: {
        url: { type: "string" },
        mediaType: { type: "string", description: "Image, Video, Audio or Document" },
        partId: { type: "string", description: "The one part it shows" },
        color: { type: "string" },
        classTypes: { type: "array", items: pair, description: "PromoStandards class types (1004 Swatch, 1006 Primary, 1007 Front, 1008 Rear, …); for SanMar and S&S, PromoStandards' where they match, else side, threeQuarter, model, flat, colorsAvailable" },
        description: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        dpi: { type: "number" },
        fileSize: { type: "number", description: "As the supplier gives it" },
        singlePart: { type: "boolean" },
        changedAt: { type: "string" },
        decorations: { type: "array", items: pair },
        locations: { type: "array", items: pair },
      },
    },
    Media: { type: "object", required: ["productId", "items"], properties: { productId: { type: "string" }, items: { type: "array", items: { $ref: "#/components/schemas/MediaItem" } } } },
    PurchaseOrder: PURCHASE_ORDER_SCHEMA,
  };
  const purchaseOrderBody = { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PurchaseOrder" } } } };
  const poSuppliers = "PromoStandards suppliers that list Purchase Order 1.0.0 only (their routes in GET /v1/suppliers/{supplier}); SanMar and S&S have their own order routes and bodies.";
  const orderErrors = { "403": { $ref: "#/components/responses/Error" }, "409": { $ref: "#/components/responses/Error" } };
  const driverPaths: Record<string, unknown> = {};
  for (const def of config?.suppliers.values() ?? []) {
    // A PromoStandards supplier's routes are the shared order routes, documented once under /v1/{supplier}.
    if (def.driver.kind === "promostandards") continue;
    for (const r of def.driver.routes ?? []) {
      const p = `/v1/${def.id}/${r.path.replace(/:(\w+)/g, "{$1}")}`;
      const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => path(m[1]!, m[1]!));
      const schemaName = r.requestSchema ? `${def.id.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())}${r.path.split("/").filter((s) => !s.startsWith(":")).map((s) => s[0]!.toUpperCase() + s.slice(1)).join("")}` : null;
      if (schemaName && r.requestSchema) schemas[schemaName] = r.requestSchema;
      const responses = { [r.write ? "201" : "200"]: ok(r.summary), ...(r.write ? { "403": { $ref: "#/components/responses/Error" }, "409": { $ref: "#/components/responses/Error" } } : {}), ...errors };
      const op = { summary: `${def.name}: ${r.summary}`, tags: [def.name], parameters: params, ...(schemaName ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } } } } : {}), responses };
      driverPaths[p] = { ...(driverPaths[p] as object), [r.method.toLowerCase()]: op };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "OpenPromo",
      version: "0.2.0",
      description:
        "A free, self-hosted REST API over supplier web services: PromoStandards, SanMar and S&S Activewear, the same paths and answers for every supplier. Money is in cents. Every /v1 call needs `Authorization: Bearer <OPENPROMO_API_KEY>` and the login of the account it is for, in the headers GET /v1/suppliers/{supplier} names (`X-Supplier-Id` and `X-Supplier-Password` for most). The server uses it for that request only and keeps nothing. Errors are `{ error: { kind, message, detail?, code?, supplier? } }`; `kind` is one of invalid, unauthorized, unknown_supplier, not_offered, not_found, not_yet (shipped or invoiced data isn't there yet), auth / not_enabled / refused (the supplier turned the request down), rate_limited, unreachable, bad_response, duplicate, orders_off.",
      license: { name: "MIT" },
    },
    servers: [{ url: origin }],
    components: {
      schemas,
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
      "/health": { get: { summary: "Is the server up", security: [], responses: { "200": ok("ok, the version and how many suppliers it serves") } } },
      "/v1/suppliers": { get: { summary: "The suppliers this server serves", parameters: [query("search", "Words in the id or name"), query("capability", "Only those that answer this: product, inventory, pricing, orderStatus, shipments, invoices, media, mediaChanges"), query("kind", "native or promostandards")], responses: { "200": ok("count and suppliers") } } },
      "/v1/suppliers/{supplier}": get("One supplier: its login headers, environments, what it answers and its own routes", [], "the supplier"),
      "/v1/{supplier}/products/{productId}": get("A product with its parts (colors and sizes)", [path("productId", "The supplier's product or style id")], "the product"),
      "/v1/{supplier}/products/{productId}/inventory": get("Stock per part and warehouse", [path("productId", "The supplier's product or style id"), query("partId", "Only these parts (repeat for several)")], "inventory"),
      "/v1/{supplier}/products/{productId}/pricing": get("Prices per part, with quantity breaks", [path("productId", "The supplier's product or style id"), query("priceType", "Net (default), List or Customer"), query("partId", "One part"), query("fobId", "FOB point (warehouse), PromoStandards only")], "prices"),
      "/v1/{supplier}/products/{productId}/media": withSchema(
        get(
          "A product's pictures (or documents, videos, sound), each with its class types (Primary, Front, Rear, Swatch…), part and color",
          [path("productId", "The supplier's product or style id"), query("type", "Image (default), Video, Audio or Document: one per call"), query("partId", "One part's media, and the whole product's"), query("classType", "One class type, by id (1007) or name (Front)")],
          "media, empty when there's none",
        ),
        "Media",
      ),
      "/v1/{supplier}/media/changes": get("The products whose media changed since a time (PromoStandards Media Content's getMediaDateModified)", [query("since", "ISO time (required)")], "{ since, productIds }"),
      "/v1/{supplier}/orders/{poNumber}": get("Where the supplier's orders under this PO stand. Ask sparingly: suppliers ask for a few calls a day per order at most.", [path("poNumber", "Your PO number")], "the order status"),
      "/v1/{supplier}/orders/{poNumber}/shipments": get("Packages and tracking", [path("poNumber", "Your PO number")], "shipments, empty until something ships"),
      "/v1/{supplier}/invoices": get("Invoices by PO, invoice number, invoice date, or since a time", [query("po", "PO number"), query("invoice", "Invoice number"), query("date", "YYYY-MM-DD"), query("since", "ISO time")], "invoices, empty until invoiced"),
      "/v1/{supplier}/orders": {
        post: {
          summary: `Place a Blank purchase order (PromoStandards PO 1.0.0 sendPO), once. ${poSuppliers} 403 orders_off unless the supplier is in OPENPROMO_ORDERS. 409 duplicate when Order Status shows a live order under the PO; 400 invalid for a supplier without Order Status unless skipDuplicateCheck is true. 424 not_enabled when the supplier doesn't take Blank orders.`,
          parameters: [supplier],
          requestBody: purchaseOrderBody,
          responses: { "201": ok("{ accepted, poNumber, transactionId, total, messages, changes, duplicateCheck }"), ...orderErrors, ...errors },
        },
      },
      "/v1/{supplier}/orders/check": {
        post: {
          summary: `Check a Blank purchase order without sending it (never calls sendPO): the same checks as placing it, Order Status and getSupportedOrderTypes included. ${poSuppliers}`,
          parameters: [supplier],
          requestBody: purchaseOrderBody,
          responses: { "200": ok("{ ok, poNumber, total, currency, lines, changes, duplicateCheck }"), "409": { $ref: "#/components/responses/Error" }, ...errors },
        },
      },
      ...driverPaths,
    },
    "x-schemas-note": "Response shapes are the TypeScript types exported by the openpromo package (Product, Inventory, Pricing, OrderStatus, Shipment, Invoice, Media, and each driver's own).",
  } as const;
}
