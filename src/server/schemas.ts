/** JSON schemas for request bodies, shared by the drivers and the OpenAPI document. */

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

/** The request body for S&S Activewear orders. */
export const SS_ORDER_SCHEMA = {
  type: "object",
  required: ["poNumber", "shipTo", "lines"],
  properties: {
    poNumber: { type: "string", maxLength: 50 },
    shipTo: {
      type: "object",
      required: ["address1", "city", "state", "zip"],
      properties: { company: { type: "string", maxLength: 50 }, attention: { type: "string", maxLength: 50 }, address1: { type: "string" }, address2: { type: "string" }, city: { type: "string", maxLength: 50 }, state: { type: "string", minLength: 2, maxLength: 2 }, zip: { type: "string" }, email: { type: "string", maxLength: 100 } },
      description: "address1 and address2 are sent joined, 100 characters at most together",
    },
    residential: { type: "boolean" },
    shipMethod: { type: "string", description: "An S&S ship method code: 1 Ground (default), 16 3 Day Select, 3 2nd Day Air, 2 Next Day Air, 6 Will call" },
    warehouse: { type: "string", description: "Ship every line from this S&S warehouse (IL, KS, NV, TX, GA, NJ, OH); else S&S picks" },
    shipBlind: { type: "boolean" },
    lines: {
      type: "array",
      minItems: 1,
      items: { type: "object", required: ["sku", "quantity"], properties: { sku: { type: "string", description: "An S&S SKU (a partId)" }, quantity: { type: "integer", minimum: 1 }, warehouse: { type: "string" } } },
    },
  },
} as const;
