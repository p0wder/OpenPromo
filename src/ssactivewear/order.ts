/**
 * Placing purchase orders with S&S's Orders API (`POST /v2/orders/`). An
 * order is checked before anything is sent: a field over S&S's limits, an
 * unknown ship method or a bad ZIP comes back `invalid`, with nothing placed.
 * Identical lines (same SKU and warehouse) go as one.
 */
import { OpenPromoError } from "../errors.js";
import type { SsActivewearClient } from "./client.js";
import type { SsOrder } from "./types.js";

/** S&S's ship method codes as Inkline uses them. S&S has others: any numeric code is sent as it is. */
export const SS_SHIP_METHODS: readonly { code: string; label: string }[] = [
  { code: "1", label: "Ground" },
  { code: "16", label: "3 Day Select" },
  { code: "3", label: "2nd Day Air" },
  { code: "2", label: "Next Day Air" },
  { code: "6", label: "Will call (pick up)" },
];

/** Field limits (characters) as Inkline sends S&S orders. The address is line 1 and line 2 joined. */
export const SS_ORDER_LIMITS = { company: 50, attention: 50, address: 100, city: 50, email: 100, poNumber: 50 } as const;

export interface SsOrderLineInput {
  /** S&S's SKU ("B00760004"), as `GET /v1/ssactivewear/products/{styleId}` lists each part. */
  sku: string;
  quantity: number;
  /** Ship this line from one S&S warehouse ("IL", "NV"); else S&S picks. */
  warehouse?: string;
}

export interface SsOrderInput {
  poNumber: string;
  shipTo: { company?: string; attention?: string; address1: string; address2?: string; city: string; state: string; zip: string; email?: string };
  residential?: boolean;
  /** An S&S ship method code (default "1", Ground). */
  shipMethod?: string;
  /** Ship every line from one warehouse; a line's own warehouse wins. */
  warehouse?: string;
  /** Ship without S&S's name on the packing slip. */
  shipBlind?: boolean;
  lines: SsOrderLineInput[];
}

/** What S&S's Orders API takes. */
export interface SsOrderRequest {
  shippingAddress: { customer: string; attn: string; address: string; city: string; state: string; zip: string; residential: boolean };
  shippingMethod: string;
  shipBlind: boolean;
  poNumber: string;
  emailConfirmation: string;
  testOrder: false;
  autoselectWarehouse: boolean;
  rejectLineErrors: true;
  lines: { identifier: string; qty: number; warehouseAbbr?: string }[];
}

export interface BuiltSsOrder {
  request: SsOrderRequest;
  /** What OpenPromo changed (merged lines, a defaulted ship method). */
  changes: string[];
}

const ZIP = /^(\d{5}(-?\d{4})?|[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d)$/;
const clean = (v: string | undefined | null) => (v ?? "").replace(/\s+/g, " ").trim();

/** The request S&S takes for this order, or `invalid` saying everything that's wrong (nothing is sent). */
export function buildSsOrder(order: SsOrderInput): BuiltSsOrder {
  const problems: string[] = [];
  const changes: string[] = [];
  const check = (label: string, value: string, max: number, required = false) => {
    if (required && !value) problems.push(`${label} is required`);
    else if (value.length > max) problems.push(`${label} is ${value.length} characters; S&S takes ${max}`);
    return value;
  };
  const s = order?.shipTo ?? ({} as SsOrderInput["shipTo"]);
  const poNumber = check("poNumber", clean(order?.poNumber), SS_ORDER_LIMITS.poNumber, true);
  const address = check("the address (address1 and address2)", [clean(s.address1), clean(s.address2)].filter(Boolean).join(", "), SS_ORDER_LIMITS.address, true);
  const city = check("city", clean(s.city), SS_ORDER_LIMITS.city, true);
  const company = check("company", clean(s.company), SS_ORDER_LIMITS.company);
  const attention = check("attention", clean(s.attention), SS_ORDER_LIMITS.attention);
  const email = check("email", clean(s.email), SS_ORDER_LIMITS.email);
  const state = clean(s.state).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) problems.push("state must be a two-letter code");
  const zip = clean(s.zip);
  if (!ZIP.test(zip)) problems.push(`ZIP "${zip}" isn't a US ZIP or Canadian postal code`);
  let shipMethod = clean(order?.shipMethod);
  if (!shipMethod) {
    shipMethod = "1";
    changes.push("ship method: Ground (1), S&S's default");
  } else if (!/^\d+$/.test(shipMethod)) problems.push(`ship method "${shipMethod}" isn't an S&S ship method code (${SS_SHIP_METHODS.map((m) => `${m.code} ${m.label}`).join(", ")})`);
  const orderWarehouse = clean(order?.warehouse).toUpperCase() || undefined;

  const lines = new Map<string, { identifier: string; qty: number; warehouseAbbr?: string }>();
  if (!Array.isArray(order?.lines) || !order.lines.length) problems.push("an order needs at least one line");
  for (const [i, l] of (Array.isArray(order?.lines) ? order.lines : []).entries()) {
    const sku = clean(l?.sku);
    if (!sku) problems.push(`line ${i + 1} has no sku`);
    if (!Number.isInteger(l?.quantity) || l.quantity < 1) problems.push(`line ${i + 1} quantity must be a whole number of at least 1`);
    if (!sku || !Number.isInteger(l?.quantity) || l.quantity < 1) continue;
    const warehouse = clean(l.warehouse).toUpperCase() || orderWarehouse;
    const key = `${sku.toUpperCase()}|${warehouse ?? ""}`;
    const at = lines.get(key);
    if (at) {
      at.qty += l.quantity;
      changes.push(`line ${i + 1} (${sku}) merged into the earlier line for the same SKU${warehouse ? ` and warehouse ${warehouse}` : ""}`);
    } else lines.set(key, { identifier: sku, qty: l.quantity, ...(warehouse ? { warehouseAbbr: warehouse } : {}) });
  }
  if (problems.length) throw new OpenPromoError("invalid", `S&S can't take this order as it stands: ${problems.join("; ")}.`, { supplier: "ssactivewear", detail: problems.join("; ") });

  const sent = [...lines.values()];
  return {
    request: {
      shippingAddress: { customer: company, attn: attention, address, city, state, zip, residential: order.residential === true },
      shippingMethod: shipMethod,
      shipBlind: order.shipBlind === true,
      poNumber,
      emailConfirmation: email,
      testOrder: false,
      autoselectWarehouse: !sent.some((l) => l.warehouseAbbr),
      rejectLineErrors: true,
      lines: sent,
    },
    changes,
  };
}

/** S&S's reason for refusing an order, from its JSON answer (`{ errors: [{ message }] }` or `{ message }`), else the start of the body. */
export function ssOrderError(text: string): string {
  try {
    const j = JSON.parse(text) as unknown;
    const obj = (Array.isArray(j) ? { errors: j } : j) as Record<string, unknown>;
    const errors = obj.errors ?? obj.Errors;
    if (Array.isArray(errors)) {
      const msgs = errors.map((e) => (typeof e === "string" ? e : String((e as Record<string, unknown>)?.message ?? (e as Record<string, unknown>)?.Message ?? ""))).filter(Boolean);
      if (msgs.length) return msgs.join(" ");
    }
    const m = obj.message ?? obj.Message ?? obj.error;
    if (m) return String(m);
  } catch {
    /* not JSON */
  }
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export interface SsOrderPlaced {
  accepted: true;
  poNumber: string;
  /** S&S may split one PO by warehouse: one entry per S&S order. */
  orders: { orderNumber: string; warehouse?: string }[];
  changes: string[];
}

/**
 * Places the order. Throws `invalid` before sending; `auth`, `rate_limited`
 * or `refused` when S&S turned it down (nothing placed); `unreachable` or
 * `bad_response` when the answer didn't say: then the order may have gone
 * through, so look it up by PO number before sending again.
 */
export async function placeSsOrder(client: SsActivewearClient, order: SsOrderInput): Promise<SsOrderPlaced> {
  const built = buildSsOrder(order);
  const supplier = "ssactivewear";
  let res: Response;
  try {
    res = await client.post("/orders/", built.request);
  } catch (e) {
    throw new OpenPromoError("unreachable", "S&S didn't answer, so the order may or may not have been placed. Look the PO up before sending again.", { supplier, detail: (e as Error).message });
  }
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) throw new OpenPromoError("auth", "S&S rejected the account number or API key; the order wasn't placed.", { supplier, status: res.status });
  if (res.status === 429) throw new OpenPromoError("rate_limited", "S&S is busy (rate limit); the order wasn't placed.", { supplier, status: 429 });
  if (res.status >= 500) throw new OpenPromoError("unreachable", `S&S answered ${res.status}, so the order may or may not have been placed. Look the PO up before sending again.`, { supplier, status: res.status });
  if (!res.ok) throw new OpenPromoError("refused", undefined, { supplier, status: res.status, detail: ssOrderError(text) || `HTTP ${res.status}` });
  let placed: SsOrder[] = [];
  try {
    const j = JSON.parse(text) as SsOrder[] | SsOrder;
    placed = (Array.isArray(j) ? j : [j]).filter((o) => o && typeof o === "object");
  } catch {
    /* unreadable: below */
  }
  const orders = placed.flatMap((o) => (o.orderNumber !== undefined && String(o.orderNumber).trim() ? [{ orderNumber: String(o.orderNumber).trim(), ...(o.warehouseAbbr ? { warehouse: o.warehouseAbbr } : {}) }] : []));
  if (!orders.length) throw new OpenPromoError("bad_response", "S&S answered without an order number, so the order may or may not have been placed. Look the PO up before sending again.", { supplier, status: res.status });
  return { accepted: true, poNumber: built.request.poNumber, orders, changes: built.changes };
}
