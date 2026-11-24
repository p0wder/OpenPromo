/** JSON schemas for request bodies, shared by the drivers and the OpenAPI document. */
import { PO_CONTACT_TYPES, PO_LIMITS, PO_QUANTITY_UOMS } from "../promostandards/order.js";

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

const text = (maxLength: number, description?: string) => ({ type: "string", minLength: 1, maxLength, ...(description ? { description } : {}) }) as const;
const PO_ADDRESS = {
  type: "object",
  properties: {
    companyName: text(PO_LIMITS.companyName),
    attentionTo: text(PO_LIMITS.attentionTo),
    address1: text(PO_LIMITS.address1),
    address2: text(PO_LIMITS.address2),
    address3: text(PO_LIMITS.address3),
    city: text(PO_LIMITS.city),
    region: text(PO_LIMITS.region, "State or province code (TX, ON)"),
    postalCode: text(PO_LIMITS.postalCode, "A US ZIP is 12345 or 12345-6789"),
    country: { type: "string", minLength: 2, maxLength: 2, description: "ISO 3166 code; US when not given" },
    email: text(PO_LIMITS.email),
    phone: text(PO_LIMITS.phone),
    comments: { type: "string" },
  },
} as const;

/**
 * The request body for PromoStandards Purchase Order 1.0.0 (Blank orders), at
 * `POST /v1/{supplier}/orders` and `/orders/check`: `PurchaseOrderInput`,
 * money in cents, plus `skipDuplicateCheck`.
 */
export const PURCHASE_ORDER_SCHEMA = {
  type: "object",
  required: ["poNumber", "shipTo", "carrier", "service", "lines"],
  properties: {
    orderType: { type: "string", enum: ["Blank"], description: "Only Blank (undecorated goods), the default" },
    poNumber: text(PO_LIMITS.orderNumber),
    orderDate: { type: "string", description: "ISO 8601 date-time; now when not given" },
    currency: { type: "string", minLength: 3, maxLength: 3, description: "ISO 4217 code; USD when not given" },
    paymentTerms: { type: "string", description: "NET30 and the like" },
    rush: { type: "boolean" },
    termsAndConditions: { type: "string" },
    shipTo: { ...PO_ADDRESS, description: "address1, city, region and postalCode are required unless customerPickup" },
    customerPickup: { type: "boolean", description: "The supplier holds the goods for pickup: no address needed" },
    carrier: text(PO_LIMITS.carrier, 'e.g. "UPS"'),
    service: text(PO_LIMITS.service, 'e.g. "GROUND"'),
    blindShip: { type: "boolean" },
    packingListRequired: { type: "boolean" },
    allowConsolidation: { type: "boolean" },
    shipReferences: { type: "array", maxItems: 2, items: text(PO_LIMITS.shipReference) },
    shipComments: { type: "string" },
    allowPartialShipments: { type: "boolean", description: "Default false: the supplier holds a line until all of it can ship" },
    contacts: {
      type: "array",
      items: { type: "object", required: ["type", "details"], properties: { type: { type: "string", enum: [...PO_CONTACT_TYPES] }, accountName: text(PO_LIMITS.accountName), accountNumber: text(PO_LIMITS.accountNumber), details: PO_ADDRESS } },
    },
    lines: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["productId", "partId", "quantity", "unitPrice"],
        properties: {
          productId: text(PO_LIMITS.productId),
          partId: text(PO_LIMITS.partId),
          quantity: { type: "integer", minimum: 1 },
          unitPrice: { type: "integer", exclusiveMinimum: 0, description: "The buyer's price for one unit, in cents. Required: OpenPromo never looks a price up" },
          uom: { type: "string", enum: [...PO_QUANTITY_UOMS], description: "Default EA" },
          description: { type: "string" },
          lineReferenceId: text(PO_LIMITS.lineReferenceId),
          customerProductId: text(PO_LIMITS.customerProductId),
          customerPartId: text(PO_LIMITS.customerPartId),
          fobId: text(PO_LIMITS.fobId, "The FOB point (warehouse) to ship from"),
          requestedShipDate: { type: "string", description: "ISO 8601 date or date-time" },
          requestedInHandsDate: { type: "string", description: "ISO 8601 date or date-time" },
        },
      },
    },
    total: { type: "integer", description: "The total you expect, in cents: refused when the lines don't add up to it" },
    skipDuplicateCheck: {
      type: "boolean",
      description:
        "Only for a supplier without Order Status, where OpenPromo can't look for an earlier order under the PO: true sends anyway (you checked yourself). With Order Status, OpenPromo always looks first and this changes nothing.",
    },
  },
} as const;
