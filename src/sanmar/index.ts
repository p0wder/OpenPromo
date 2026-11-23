/**
 * SanMar: its PromoStandards services (through `PromoStandardsClient`) and
 * its own SOAP services: Product Info, Pricing and the PO service. Endpoints,
 * namespaces and element names follow SanMar's Web Services Integration Guide
 * v24.7 and Purchase Order Integration Guide v24.6 (Oct 2026).
 *
 * SanMar removed its web-service IP restriction in July 2018: calls only need
 * outbound port 8080 and TLS 1.2. Its test environment is EDEV
 * (`edev-ws.sanmar.com`), with its own logins issued by SanMar Integration
 * Support.
 */
import { OpenPromoError } from "../errors.js";
import { PromoStandardsClient, type PromoStandardsSupplier } from "../promostandards/client.js";
import { asArray, node, readSoapBody, sendSoap, soapRequest, text, type SoapBody, type XmlNode } from "../soap.js";
import { buildSanmarOrder, readSanmarPreSubmit, sanmarRefusal, type BuiltSanmarOrder, type SanmarOrder, type SanmarOrderOptions, type SanmarPreSubmit } from "./order.js";

export * from "./constants.js";
export * from "./order.js";

export type SanmarEnvironment = "production" | "edev";

const HOSTS: Record<SanmarEnvironment, string> = {
  production: "https://ws.sanmar.com:8080",
  edev: "https://edev-ws.sanmar.com:8080",
};

const ps = (version: string, path: string) => ({ version, url: `${HOSTS.production}/promostandards/${path}`, testUrl: `${HOSTS.edev}/promostandards/${path}` });

/**
 * SanMar's PromoStandards services. Product Data's service address is
 * `ProductDataServiceBindingV2` in the guide's SOAP example (p8); its WSDL is
 * listed as `ProductDataServiceV2.xml` (p30). The others are the WSDL paths.
 */
export const SANMAR_PROMOSTANDARDS: PromoStandardsSupplier = {
  id: "sanmar",
  name: "SanMar",
  endpoints: {
    productData: ps("2.0.0", "ProductDataServiceBindingV2"),
    inventory: ps("2.0.0", "InventoryServiceBindingV2final"),
    pricing: ps("1.0.0", "PricingAndConfigurationServiceBinding"),
    orderStatus: ps("2.0.0", "OrderStatusServiceBindingV2"),
    shipments: ps("1.0.0", "OrderShipmentNotificationServiceBinding"),
    invoices: ps("1.0.0", "InvoiceServiceBindingV1_0_0"),
  },
  // SanMar's prices don't vary by warehouse: any valid FOB id will do (guide p71).
  defaultFobId: "1",
  timeoutMs: 20_000,
};

/** A SanMar web-services login: the customer number and a sanmar.com user. */
export interface SanmarLogin {
  customerNumber: string;
  username: string;
  password: string;
}

export interface SanmarClientOptions {
  /** "edev" is SanMar's test environment (its own logins). Default "production". */
  environment?: SanmarEnvironment;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/* ---------------------------------------------------------------- What SanMar answers */

/** Money in cents. */
export interface SanmarSize {
  size: string;
  sizeIndex?: string;
  inventoryKey?: string;
  /** Inventory key + size index: the PromoStandards `partId` on orders, shipments and invoices. */
  uniqueKey?: string;
  /** SanMar's standard piece price (5 or fewer of a style and color): the same for every account. */
  piecePrice?: number;
  casePrice?: number;
  pieceSalePrice?: number;
  caseSalePrice?: number;
  saleStartDate?: string;
  saleEndDate?: string;
  mapPrice?: number;
  caseSize?: number;
  pieceWeight?: number;
}

export interface SanmarColor {
  /** The display name ("Athletic Heather"). */
  name: string;
  /** SanMar's mainframe name, the one orders take ("Athletic Hthr"). */
  catalogColor: string;
  swatchUrl?: string;
  squareUrl?: string;
  images: { product?: string; frontFlat?: string; backFlat?: string; frontModel?: string; backModel?: string; sideModel?: string; threeQuarterModel?: string };
  sizes: SanmarSize[];
}

export interface SanmarProduct {
  style: string;
  title: string;
  description?: string;
  brand?: string;
  category?: string;
  /** Active, New, Coming Soon, Regular, Discontinued. */
  status?: string;
  availableSizes?: string;
  colors: SanmarColor[];
}

/** One row of the Pricing service, in cents. `myPrice` is the account's own price. */
export interface SanmarPrice {
  style: string;
  color: string;
  size: string;
  inventoryKey?: string;
  sizeIndex?: string;
  piecePrice?: number;
  casePrice?: number;
  salePrice?: number;
  myPrice?: number;
  incentivePrice?: number;
  saleStartDate?: string;
  saleEndDate?: string;
}

export type SanmarSubmitResult = { accepted: true; message: string; poNumber: string; changes: string[] };

/* ---------------------------------------------------------------- Reading answers */

const IMPL_NS = "http://impl.webservice.integration.sanmar.com/";
const PO_NS = "http://webservice.integration.sanmar.com/";

const dollars = (v: unknown): number | undefined => {
  const s = text(v).replace(/[$,\s]/g, "");
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};
const opt = (v: unknown) => text(v) || undefined;
const num = (v: unknown) => {
  const n = Number(text(v));
  return text(v) && Number.isFinite(n) ? n : undefined;
};
/** SanMar's dates ("2026-12-31", "12/31/2026", a timestamp) as YYYY-MM-DD. */
export function sanmarDate(v: unknown): string | undefined {
  const s = text(v);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  return /^(\d{4}-\d{2}-\d{2})/.exec(s)?.[1];
}

/** SanMar's own `return`, throwing its error message (`errorOccured` or `errorOccurred`) as the right kind. */
function sanmarReturn(body: XmlNode, response: string): XmlNode {
  const ret = node(node(body[response])?.return);
  if (!ret) throw new OpenPromoError("bad_response", undefined, { supplier: "sanmar", detail: `no ${response} in the answer` });
  if (text(ret.errorOccurred ?? ret.errorOccured).toLowerCase() === "true") throw sanmarRefusal(text(ret.message) || "unknown error");
  return ret;
}

/** Product Info's answer as one product; null when SanMar has no such style. */
export function readSanmarProductInfo(body: XmlNode, style: string): SanmarProduct | null {
  let ret: XmlNode;
  try {
    ret = sanmarReturn(body, "getProductInfoByStyleColorSizeResponse");
  } catch (e) {
    if (e instanceof OpenPromoError && e.kind === "not_found") return null;
    throw e;
  }
  const items = asArray(ret.listResponse as XmlNode | XmlNode[] | undefined);
  const first = node(items[0]?.productBasicInfo);
  if (!first) return null;
  const colors = new Map<string, SanmarColor>();
  for (const item of items) {
    const info = node(item.productBasicInfo) ?? {};
    const img = node(item.productImageInfo) ?? {};
    const price = node(item.productPriceInfo) ?? {};
    const name = text(info.color) || text(info.catalogColor) || "Default";
    let color = colors.get(name);
    if (!color) {
      color = {
        name,
        catalogColor: text(info.catalogColor) || name,
        swatchUrl: opt(img.colorSwatchImage),
        squareUrl: opt(img.colorSquareImage),
        images: {
          product: opt(img.colorProductImage),
          frontFlat: opt(img.frontFlat),
          backFlat: opt(img.backFlat),
          frontModel: opt(img.frontModel),
          backModel: opt(img.backModel),
          sideModel: opt(img.sideModel),
          threeQuarterModel: opt(img.threeQModel),
        },
        sizes: [],
      };
      colors.set(name, color);
    }
    const size = text(info.size);
    if (!size || color.sizes.some((s) => s.size === size)) continue;
    color.sizes.push({
      size,
      sizeIndex: opt(info.sizeIndex),
      inventoryKey: opt(info.inventoryKey),
      uniqueKey: opt(info.uniqueKey),
      piecePrice: dollars(price.piecePrice),
      casePrice: dollars(price.casePrice),
      pieceSalePrice: dollars(price.pieceSalePrice),
      caseSalePrice: dollars(price.caseSalePrice),
      saleStartDate: sanmarDate(price.saleStartDate),
      saleEndDate: sanmarDate(price.saleEndDate),
      mapPrice: dollars(price.mapPrice),
      caseSize: num(info.caseSize),
      pieceWeight: num(info.pieceWeight),
    });
  }
  return {
    style: text(first.style) || style,
    title: text(first.productTitle) || style,
    description: opt(first.productDescription),
    brand: opt(first.brandName),
    category: opt(first.category),
    status: opt(first.productStatus),
    availableSizes: opt(first.availableSizes),
    colors: [...colors.values()],
  };
}

/** The Pricing service's rows. */
export function readSanmarPricing(body: XmlNode): SanmarPrice[] {
  const ret = sanmarReturn(body, "getPricingResponse");
  return asArray(ret.listResponse as XmlNode | XmlNode[] | undefined).map((r) => ({
    style: text(r.style),
    color: text(r.color),
    size: text(r.size),
    inventoryKey: opt(r.inventoryKey),
    sizeIndex: opt(r.sizeIndex),
    piecePrice: dollars(r.piecePrice),
    casePrice: dollars(r.casePrice),
    salePrice: dollars(r.salePrice),
    myPrice: dollars(r.myPrice),
    incentivePrice: dollars(r.incentivePrice),
    saleStartDate: sanmarDate(r.saleStartDate),
    saleEndDate: sanmarDate(r.saleEndDate),
  }));
}

/** For tests and tools: the same readers on raw XML. */
export const parseSanmarProductInfo = (xml: string, style: string) => {
  const body = readSoapBody(xml)?.body;
  return body ? readSanmarProductInfo(body, style) : null;
};
export const parseSanmarPricing = (xml: string) => {
  const body = readSoapBody(xml)?.body;
  return body ? readSanmarPricing(body) : [];
};

/* ---------------------------------------------------------------- The client */

/** SanMar on one login. */
export class SanmarClient {
  readonly environment: SanmarEnvironment;
  private readonly host: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  constructor(
    private readonly login: SanmarLogin,
    opts: SanmarClientOptions = {},
  ) {
    this.environment = opts.environment ?? "production";
    this.host = HOSTS[this.environment];
    this.fetchImpl = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** SanMar's PromoStandards services on this login (id and password are the sanmar.com user; no customer number). */
  promoStandards(): PromoStandardsClient {
    return new PromoStandardsClient(SANMAR_PROMOSTANDARDS, { id: this.login.username, password: this.login.password }, { environment: this.environment === "edev" ? "test" : "production", fetch: this.fetchImpl });
  }

  private auth(): SoapBody {
    return { sanMarCustomerNumber: this.login.customerNumber, sanMarUserName: this.login.username, sanMarUserPassword: this.login.password };
  }

  private call(port: string, namespace: string, prefix: string, operation: string, arg0: SoapBody, timeoutMs = this.timeoutMs) {
    return soapRequest({ supplier: "sanmar", url: `${this.host}/SanMarWebService/${port}`, namespace, prefix, operation, body: { arg0, arg1: this.auth() }, timeoutMs, fetch: this.fetchImpl });
  }

  /** Product Info for a style (every color and size), with SanMar's standard prices. Null when SanMar has no such style. */
  async productInfo(style: string, filter: { color?: string; size?: string } = {}): Promise<SanmarProduct | null> {
    const id = style.trim().toUpperCase();
    const body = await this.call("SanMarProductInfoServicePort", IMPL_NS, "impl", "getProductInfoByStyleColorSize", { style: id, color: filter.color ?? "", size: filter.size ?? "" });
    return readSanmarProductInfo(body, id);
  }

  /**
   * The Pricing service for a style (or one color and size): piece, case,
   * sale and incentive prices, and `myPrice`, the account's own price. SanMar
   * updates prices once or twice a year and sales on Mondays and Wednesdays,
   * so cache answers.
   */
  async pricing(style: string, filter: { color?: string; size?: string } = {}): Promise<SanmarPrice[]> {
    const body = await this.call("SanMarPricingServicePort", IMPL_NS, "impl", "getPricing", { style: style.trim().toUpperCase(), color: filter.color ?? "", size: filter.size ?? "" });
    return readSanmarPricing(body);
  }

  /** Checks an order without placing it: per line, whether it's in stock and where it would ship from. */
  async preSubmitOrder(order: SanmarOrder, opts: SanmarOrderOptions = {}): Promise<SanmarPreSubmit & { changes: string[] }> {
    const built = buildSanmarOrder(order, opts);
    const body = await this.call("SanMarPOServicePort", PO_NS, "web", "getPreSubmitInfo", built.request);
    return { ...readSanmarPreSubmit(body, built.lines), changes: built.changes };
  }

  /**
   * Places the order. SanMar answers only "PO Submission successful" (no
   * order number: it files the order under your PO number). Throws `invalid`
   * before sending, `refused` when SanMar turned it down (nothing placed),
   * and `unreachable` or `bad_response` when the answer didn't say: then the
   * order may have gone through, so look it up by PO number (Order Status)
   * before sending again.
   */
  async submitOrder(order: SanmarOrder, opts: SanmarOrderOptions = {}): Promise<SanmarSubmitResult> {
    const built: BuiltSanmarOrder = buildSanmarOrder(order, opts);
    const reply = await sendSoap({ supplier: "sanmar", url: `${this.host}/SanMarWebService/SanMarPOServicePort`, namespace: PO_NS, prefix: "web", operation: "submitPO", body: { arg0: built.request, arg1: this.auth() }, timeoutMs: Math.max(this.timeoutMs, 45_000), fetch: this.fetchImpl });
    if (reply.fault) throw new OpenPromoError("refused", undefined, { supplier: "sanmar", detail: reply.fault.message, code: reply.fault.code, status: reply.status });
    const ret = reply.body ? node(node(reply.body.submitPOResponse)?.return) : undefined;
    if (!ret) {
      if (reply.status >= 502) throw new OpenPromoError("unreachable", undefined, { supplier: "sanmar", status: reply.status, detail: `HTTP ${reply.status}` });
      throw new OpenPromoError("bad_response", undefined, { supplier: "sanmar", status: reply.status, detail: `HTTP ${reply.status}: no submitPOResponse` });
    }
    const message = text(ret.message);
    if (text(ret.errorOccurred ?? ret.errorOccured).toLowerCase() === "true" || /^error\b/i.test(message)) throw sanmarRefusal(message.replace(/^error:?\s*/i, "") || "unknown error");
    return { accepted: true, message: message || "PO Submission successful", poNumber: text(built.request.poNum as string), changes: built.changes };
  }
}
