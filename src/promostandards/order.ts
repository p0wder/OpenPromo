/**
 * PromoStandards Purchase Order 1.0.0 (`sendPO`), Blank orders only:
 * undecorated goods, which is what a print shop orders. Built from the
 * official schema (POService.wsdl, SendPORequest.xsd, SharedObjectsPO.xsd,
 * promostandards.org purchaseOrder-1.0.0-1.zip). An order is checked against
 * the schema's required fields, lengths and code lists before anything is
 * sent: anything wrong comes back `invalid`, saying all of it. Every line
 * carries the buyer's own `unitPrice`; OpenPromo never looks a price up or
 * guesses one. Identical lines go as one, and that is said in `changes`.
 *
 * Namespaces, as the schema puts them: `SendPORequest`, `PO`, the PO's own
 * fields (orderType … rush, the arrays, termsAndConditions), `LineItem` and
 * its own fields (lineNumber, lineType, allowPartialShipments,
 * lineItemTotal, the dates, customerProductId, PartArray) are in the
 * service namespace (`ns:`). wsVersion, id, password, currency, Contact,
 * Shipment, description, Quantity, fobId, ToleranceDetails, unitPrice,
 * productId and Part, with everything inside them, are SharedObjects
 * (`shar:`, the client's default).
 */
import { OpenPromoError } from "../errors.js";
import type { SoapBody } from "../soap.js";

/* ---------------------------------------------------------------- The schema's code lists */

/** `OrderTypeType`. Only Blank is built here; Sample, Simple and Configured (decoration, artwork, proofs) are a later epic. */
export const PO_ORDER_TYPES = ["Blank", "Configured", "Sample", "Simple"] as const;
export type PurchaseOrderType = (typeof PO_ORDER_TYPES)[number];

/** `ContactTypeType`. */
export const PO_CONTACT_TYPES = ["Art", "Bill", "Expeditor", "Order", "Sales", "Sold"] as const;
export type PurchaseOrderContactType = (typeof PO_CONTACT_TYPES)[number];

/** `QuantityUomType`. */
export const PO_QUANTITY_UOMS = ["BX", "CA", "DZ", "EA", "KT", "PK", "PR", "RL", "SL", "ST", "TH"] as const;
export type PurchaseOrderUom = (typeof PO_QUANTITY_UOMS)[number];

/** `CurrencyCodeType` (iso4217-currency-code.xsd as PO 1.0.0 ships it). */
const CURRENCIES = new Set(
  "AFA ALL DZD AON ARS AMD AWG AUD ATS AZM BSD BHD BDT BBD BYR BEF BZD BMD BTN BOB BAM BWP BRL BND BGL BIF KHR CAD CVE KYD XOF XAF XPF CLP CNY COP KMF CDF CRC HRK CUP CYP CZK DKK DEM DJF DOP NLG XCD ECS EGP SVC ERN EEK ETB EUR FKP FJD FIM FRF GMD GEL GHC GIP GRD GTQ GYD HTG HNL HKD HUF ISK INR IDR IRR IQD IEP ILS ITL JMD JPY JOD KZT KES KWD KGS LAK LVL LBP LSL LRD LYD LTL LUF MOP MKD MGF MWK MYR MVR MTL MRO MUR MXN MDL MNT MAD MZM MMK NAD NPR ANG ZRN NZD NIC NGN KPW NOK PKR PAB PGK PYG PEN PHP PLN PTE QAR OMR ROL RUR RWF STD SAR SCR SLL SGD SKK SIT SBD SOS ZAR KRW ESP LKR SHP GBP SDP SRG SZL SEK CHF SYP TWD TJR TZS THB TPE TOP TTD TND TRL TMM AED UGX UAH UYU USD UZS VUV VEB VND WST YER YUM ZMK ZWD".split(" "),
);

/** `ISO3166CountyCode` (iso3166-country-code.xsd as PO 1.0.0 ships it). */
const COUNTRIES = new Set(
  "AF AX AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BA BW BV BR IO BN BG BF BI KH CM CA CV KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI KP KR KW KG LA LV LB LS LR LY LI LT LU MO MK MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN MS MA MZ MM NA NR NP NL AN NC NZ NI NE NG NU NF MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW SH KN LC PM VC WS SM ST SA SN CS SC SL SG SK SI SB SO ZA GS ES LK SD SR SJ SZ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV UG UA AE GB US UM UY UZ VU VE VN VG VI WF EH YE ZM ZW".split(" "),
);

/** The schema's `maxLength`s (characters). Every one also has `minLength` 1: an empty value is left out, or refused where it's required. */
export const PO_LIMITS = {
  orderNumber: 64,
  carrier: 64,
  service: 64,
  shipReference: 64,
  productId: 64,
  partId: 64,
  fobId: 64,
  lineReferenceId: 64,
  customerProductId: 64,
  customerPartId: 64,
  accountName: 64,
  accountNumber: 64,
  attentionTo: 35,
  companyName: 35,
  address1: 35,
  address2: 35,
  address3: 35,
  city: 30,
  region: 3,
  postalCode: 10,
  email: 128,
  phone: 32,
} as const;

/* ---------------------------------------------------------------- What the caller gives */

/** A `ContactDetails`: the ship-to address, or a contact's. */
export interface PurchaseOrderAddress {
  companyName?: string;
  attentionTo?: string;
  address1?: string;
  address2?: string;
  address3?: string;
  city?: string;
  /** State or province, as its code ("TX", "ON"): 3 characters at most. */
  region?: string;
  postalCode?: string;
  /** ISO 3166 two-letter code; "US" when not given. */
  country?: string;
  email?: string;
  phone?: string;
  comments?: string;
}

export interface PurchaseOrderContact {
  type: PurchaseOrderContactType;
  accountName?: string;
  accountNumber?: string;
  details: PurchaseOrderAddress;
}

export interface PurchaseOrderLineInput {
  /** The supplier's product id (style). */
  productId: string;
  /** The supplier's part id (one color and size), as Product Data or Pricing and Configuration lists it. */
  partId: string;
  /** A whole number of at least 1. */
  quantity: number;
  /** The buyer's price for one unit, in cents (a whole number above 0). Required: OpenPromo never looks one up. */
  unitPrice: number;
  /** Default "EA". */
  uom?: PurchaseOrderUom;
  description?: string;
  /** The buyer's own id for this line. */
  lineReferenceId?: string;
  customerProductId?: string;
  customerPartId?: string;
  /** The FOB point (warehouse) to ship from, from Pricing and Configuration's getFobPoints. */
  fobId?: string;
  /** ISO 8601 date or date-time. */
  requestedShipDate?: string;
  requestedInHandsDate?: string;
}

/** A Blank purchase order, the one shape every PromoStandards supplier takes. */
export interface PurchaseOrderInput {
  /** Only "Blank" (the default) is built. */
  orderType?: PurchaseOrderType;
  /** The buyer's PO number (`orderNumber`), 64 characters at most. */
  poNumber: string;
  /** ISO 8601 date-time; now when not given. */
  orderDate?: string;
  /** ISO 4217 code; "USD" when not given. */
  currency?: string;
  /** "NET30" and the like. */
  paymentTerms?: string;
  rush?: boolean;
  /** Required by the schema; sent empty when not given. */
  termsAndConditions?: string;
  shipTo: PurchaseOrderAddress;
  /** The supplier will hold the goods for pickup: then no address is needed. */
  customerPickup?: boolean;
  /** `FreightDetails`: both required ("UPS", "GROUND"). */
  carrier: string;
  service: string;
  blindShip?: boolean;
  packingListRequired?: boolean;
  allowConsolidation?: boolean;
  /** Ship-to references the supplier prints on the shipment: two at most. */
  shipReferences?: string[];
  shipComments?: string;
  /** Default false: the supplier holds a line until all of it can ship. */
  allowPartialShipments?: boolean;
  contacts?: PurchaseOrderContact[];
  lines: PurchaseOrderLineInput[];
  /** The total the caller expects, in cents: refused when the lines don't add up to it. */
  total?: number;
}

/* ---------------------------------------------------------------- What is sent */

/** One line as it is sent, for the caller's records. Money in cents. */
export interface PurchaseOrderSentLine {
  lineNumber: number;
  productId: string;
  partId: string;
  quantity: number;
  uom: PurchaseOrderUom;
  unitPrice: number;
  lineTotal: number;
}

export interface BuiltPurchaseOrder {
  /** The `PO` element's children, namespace prefixes on the service's own fields (`ns:`); the rest are SharedObjects. */
  request: SoapBody;
  poNumber: string;
  /** `totalAmount`, cents. */
  total: number;
  currency: string;
  lines: PurchaseOrderSentLine[];
  /** What OpenPromo changed or filled in (merged lines, a defaulted currency, country or order date). */
  changes: string[];
}

export interface BuildPurchaseOrderOptions {
  /** The supplier, for errors. */
  supplier?: string;
  /** The clock for a defaulted order date (tests). */
  now?: Date;
}

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const money = (cents: number) => (cents / 100).toFixed(2);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_ZIP = /^\d{5}(-\d{4})?$/;

/**
 * The `PO` a supplier's `sendPO` takes for this Blank order, or `invalid`
 * saying everything that's wrong (nothing is sent).
 */
export function buildPurchaseOrder(order: PurchaseOrderInput, opts: BuildPurchaseOrderOptions = {}): BuiltPurchaseOrder {
  const problems: string[] = [];
  const changes: string[] = [];
  /** A text field: refused when required and empty or over the schema's length; left out (undefined) when empty. */
  const field = (label: string, value: unknown, max?: number, required = false): string | undefined => {
    const v = clean(value);
    if (!v) {
      if (required) problems.push(`${label} is required`);
      return undefined;
    }
    if (max !== undefined && v.length > max) problems.push(`${label} is ${v.length} characters, over the PO schema's ${max}`);
    return v;
  };
  const dateTime = (label: string, value: unknown): string | undefined => {
    const v = clean(value);
    if (!v) return undefined;
    if (DATE.test(v) && !Number.isNaN(Date.parse(v))) {
      changes.push(`${label}: ${v} sent as ${v}T00:00:00 (the schema takes a date and time)`);
      return `${v}T00:00:00`;
    }
    if (!DATE_TIME.test(v) || Number.isNaN(Date.parse(v))) {
      problems.push(`${label} "${v}" isn't an ISO 8601 date or date-time`);
      return undefined;
    }
    return v;
  };
  const address = (label: string, a: PurchaseOrderAddress | undefined, needStreet: boolean): SoapBody => {
    const s = a ?? {};
    const out: SoapBody = {
      attentionTo: field(`${label} attentionTo`, s.attentionTo, PO_LIMITS.attentionTo),
      companyName: field(`${label} companyName`, s.companyName, PO_LIMITS.companyName),
      address1: field(`${label} address1`, s.address1, PO_LIMITS.address1, needStreet),
      address2: field(`${label} address2`, s.address2, PO_LIMITS.address2),
      address3: field(`${label} address3`, s.address3, PO_LIMITS.address3),
      city: field(`${label} city`, s.city, PO_LIMITS.city, needStreet),
      region: field(`${label} region`, clean(s.region).toUpperCase(), PO_LIMITS.region, needStreet),
      postalCode: field(`${label} postalCode`, s.postalCode, PO_LIMITS.postalCode, needStreet),
    };
    let country = clean(s.country).toUpperCase();
    if (!country && needStreet) {
      country = "US";
      changes.push(`${label} country: US, as none was given`);
    }
    if (country && !COUNTRIES.has(country)) problems.push(`${label} country "${country}" isn't an ISO 3166 two-letter code`);
    out.country = country || undefined;
    if (country === "US" && typeof out.postalCode === "string" && !US_ZIP.test(out.postalCode)) problems.push(`${label} postalCode "${out.postalCode}" isn't a US ZIP`);
    out.email = field(`${label} email`, s.email, PO_LIMITS.email);
    if (typeof out.email === "string" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) problems.push(`${label} email "${out.email}" isn't an email address`);
    out.phone = field(`${label} phone`, s.phone, PO_LIMITS.phone);
    out.comments = field(`${label} comments`, s.comments);
    return out;
  };

  const supplier = opts.supplier;
  const orderType = order?.orderType ?? "Blank";
  if (orderType !== "Blank") problems.push(`orderType "${String(orderType)}" isn't built yet: OpenPromo sends Blank orders only`);
  const poNumber = field("poNumber", order?.poNumber, PO_LIMITS.orderNumber, true) ?? "";

  let orderDate = dateTime("orderDate", order?.orderDate);
  if (!clean(order?.orderDate)) {
    orderDate = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    changes.push(`orderDate: ${orderDate}, now, as none was given`);
  }

  let currency = clean(order?.currency).toUpperCase();
  if (!currency) {
    currency = "USD";
    changes.push("currency: USD, as none was given");
  } else if (!CURRENCIES.has(currency)) problems.push(`currency "${currency}" isn't an ISO 4217 code the PO schema lists`);

  const pickup = order?.customerPickup === true;
  const shipTo = address("shipTo", order?.shipTo, !pickup);
  const carrier = field("carrier", order?.carrier, PO_LIMITS.carrier, true);
  const service = field("service", order?.service, PO_LIMITS.service, true);
  const refs = Array.isArray(order?.shipReferences) ? order.shipReferences.map((r, i) => field(`shipReferences ${i + 1}`, r, PO_LIMITS.shipReference)).filter((r): r is string => !!r) : [];
  if (refs.length > 2) problems.push(`shipReferences has ${refs.length} entries, over the PO schema's 2`);

  const contacts: SoapBody[] = [];
  for (const [i, c] of (Array.isArray(order?.contacts) ? order.contacts : []).entries()) {
    const label = `contact ${i + 1}`;
    if (!PO_CONTACT_TYPES.includes(c?.type)) problems.push(`${label} type "${String(c?.type)}" isn't one of ${PO_CONTACT_TYPES.join(", ")}`);
    contacts.push({
      accountName: field(`${label} accountName`, c?.accountName, PO_LIMITS.accountName),
      accountNumber: field(`${label} accountNumber`, c?.accountNumber, PO_LIMITS.accountNumber),
      contactType: c?.type,
      ContactDetails: address(label, c?.details, false),
    });
  }

  /* Lines: checked, then identical ones (everything but quantity the same) merged. */
  interface Line extends PurchaseOrderSentLine {
    from: number;
    description: string;
    lineReferenceId?: string;
    customerProductId?: string;
    customerPartId?: string;
    fobId?: string;
    requestedShipDate?: string;
    requestedInHandsDate?: string;
  }
  const lines = new Map<string, Line>();
  let skipped = false;
  const input = Array.isArray(order?.lines) ? order.lines : [];
  if (!input.length) problems.push("an order needs at least one line");
  for (const [i, l] of input.entries()) {
    const n = i + 1;
    const productId = field(`line ${n} productId`, l?.productId, PO_LIMITS.productId, true);
    const partId = field(`line ${n} partId`, l?.partId, PO_LIMITS.partId, true);
    const quantityOk = Number.isInteger(l?.quantity) && l.quantity >= 1;
    if (!quantityOk) problems.push(`line ${n} quantity must be a whole number of at least 1`);
    const priceOk = Number.isInteger(l?.unitPrice) && l.unitPrice > 0;
    if (l?.unitPrice === undefined || l?.unitPrice === null) problems.push(`line ${n} has no unitPrice: every line carries the buyer's price, in cents (OpenPromo never looks one up)`);
    else if (!priceOk) problems.push(`line ${n} unitPrice must be a whole number of cents above 0`);
    const uom = (clean(l?.uom).toUpperCase() || "EA") as PurchaseOrderUom;
    if (!PO_QUANTITY_UOMS.includes(uom)) problems.push(`line ${n} uom "${uom}" isn't one of ${PO_QUANTITY_UOMS.join(", ")}`);
    const line = {
      description: clean(l?.description),
      lineReferenceId: field(`line ${n} lineReferenceId`, l?.lineReferenceId, PO_LIMITS.lineReferenceId),
      customerProductId: field(`line ${n} customerProductId`, l?.customerProductId, PO_LIMITS.customerProductId),
      customerPartId: field(`line ${n} customerPartId`, l?.customerPartId, PO_LIMITS.customerPartId),
      fobId: field(`line ${n} fobId`, l?.fobId, PO_LIMITS.fobId),
      requestedShipDate: dateTime(`line ${n} requestedShipDate`, l?.requestedShipDate),
      requestedInHandsDate: dateTime(`line ${n} requestedInHandsDate`, l?.requestedInHandsDate),
    };
    if (!productId || !partId || !quantityOk || !priceOk || !PO_QUANTITY_UOMS.includes(uom)) {
      skipped = true;
      continue;
    }
    const key = JSON.stringify([productId.toUpperCase(), partId.toUpperCase(), uom, line]);
    const at = lines.get(key);
    if (at) {
      if (at.unitPrice !== l.unitPrice) {
        problems.push(`line ${n} is the same as line ${at.from} but at a different unitPrice (${l.unitPrice} and ${at.unitPrice} cents)`);
        skipped = true;
        continue;
      }
      at.quantity += l.quantity;
      changes.push(`line ${n} (${productId} ${partId}) merged into line ${at.from}, the same part`);
    } else lines.set(key, { from: n, lineNumber: 0, productId, partId, quantity: l.quantity, uom, unitPrice: l.unitPrice, lineTotal: 0, ...line });
  }

  const sent = [...lines.values()].map((l, i) => ({ ...l, lineNumber: i + 1, lineTotal: l.quantity * l.unitPrice }));
  const total = sent.reduce((sum, l) => sum + l.lineTotal, 0);
  // The caller's total is checked once every line is good (else the sum means nothing).
  if (order?.total !== undefined && !skipped && order.total !== total) {
    problems.push(`the lines add up to ${total} cents, not the ${order.total} given as total`);
  }
  if (problems.length) throw new OpenPromoError("invalid", `This purchase order can't be sent as it stands: ${problems.join("; ")}.`, { supplier, detail: problems.join("; ") });

  const quantity = (value: number, uom: string): SoapBody => ({ uom, value });
  const request: SoapBody = {
    "ns:orderType": "Blank",
    "ns:orderNumber": poNumber,
    "ns:orderDate": orderDate,
    "ns:totalAmount": money(total),
    "ns:paymentTerms": clean(order.paymentTerms) || undefined,
    "ns:rush": order.rush === true,
    currency,
    "ns:OrderContactArray": contacts.length ? { Contact: contacts } : undefined,
    "ns:ShipmentArray": {
      Shipment: {
        shipReferences: refs.length ? refs : undefined,
        comments: clean(order.shipComments) || undefined,
        allowConsolidation: order.allowConsolidation === true,
        blindShip: order.blindShip === true,
        packingListRequired: order.packingListRequired === true,
        FreightDetails: { carrier, service },
        ShipTo: { customerPickup: pickup, ContactDetails: shipTo, shipmentId: 1 },
      },
    },
    "ns:LineItemArray": {
      "ns:LineItem": sent.map((l) => ({
        "ns:lineNumber": l.lineNumber,
        "ns:lineReferenceId": l.lineReferenceId,
        description: l.description,
        "ns:lineType": "New",
        Quantity: quantity(l.quantity, l.uom),
        fobId: l.fobId,
        ToleranceDetails: { tolerance: "ExactOnly" },
        "ns:allowPartialShipments": order.allowPartialShipments === true,
        unitPrice: money(l.unitPrice),
        "ns:lineItemTotal": money(l.lineTotal),
        "ns:requestedShipDate": l.requestedShipDate,
        "ns:requestedInHandsDate": l.requestedInHandsDate,
        productId: l.productId,
        "ns:customerProductId": l.customerProductId,
        "ns:PartArray": {
          Part: {
            partId: l.partId,
            customerPartId: l.customerPartId,
            customerSupplied: false,
            Quantity: quantity(l.quantity, l.uom),
            unitPrice: money(l.unitPrice),
            extendedPrice: money(l.lineTotal),
          },
        },
      })),
    },
    "ns:termsAndConditions": clean(order.termsAndConditions),
  };
  return {
    request,
    poNumber,
    total,
    currency,
    lines: sent.map(({ lineNumber, productId, partId, quantity, uom, unitPrice, lineTotal }) => ({ lineNumber, productId, partId, quantity, uom, unitPrice, lineTotal })),
    changes,
  };
}

/** What a supplier said to a sent PO it took. */
export interface PurchaseOrderPlaced {
  accepted: true;
  poNumber: string;
  /** The supplier's id for this submission: keep it with the order. */
  transactionId: string;
  /** `totalAmount` as sent, cents. */
  total: number;
  /** Warnings and information the supplier sent with it. */
  messages: { code: string; description: string; severity: string }[];
  changes: string[];
}
