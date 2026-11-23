/**
 * Building and reading SanMar purchase orders for its own PO service
 * (`getPreSubmitInfo`, `submitPO`), following the Purchase Order Integration
 * Guide v24.6: commas are SanMar's file delimiter, so none may reach it;
 * fields have hard limits; identical lines go as one; `whseNo` only when the
 * account is set up for Warehouse Selection.
 */
import { OpenPromoError } from "../errors.js";
import { asArray, node, text, type SoapBody, type XmlNode } from "../soap.js";
import { SANMAR_PO_LIMITS as L, SANMAR_SHIP_METHODS, SANMAR_WAREHOUSES } from "./constants.js";

export interface SanmarOrderLine {
  /** Style number ("PC54"), with `color` (SanMar's mainframe/catalog color) and `size`. */
  style?: string;
  color?: string;
  size?: string;
  /** Or SanMar's inventory key and size index (SanMar's recommended identity). */
  inventoryKey?: string | number;
  sizeIndex?: string | number;
  quantity: number;
  /** Warehouse number (1–7, 12, 31): only sent when the account uses Warehouse Selection. */
  warehouse?: string;
}

export interface SanmarOrder {
  poNumber: string;
  shipTo: {
    company?: string;
    attention?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    /** Order confirmation and shipping notices. */
    email?: string;
  };
  residential: boolean;
  /** One of `SANMAR_SHIP_METHODS`, or a will-call warehouse code (Warehouse Selection accounts). Default "UPS". */
  shipMethod?: string;
  /** SanMar asks for this to be left blank; at most 100 characters reach it. */
  notes?: string;
  lines: SanmarOrderLine[];
}

export interface SanmarOrderOptions {
  /** The account is set up for Warehouse Selection (SanMar configures this): send each line's warehouse, allow will call. */
  warehouseSelection?: boolean;
}

/** A line as it goes to SanMar, with the caller's line indexes it stands for (identical lines are merged). */
export interface SanmarSentLine {
  style?: string;
  color?: string;
  size?: string;
  inventoryKey?: string;
  sizeIndex?: string;
  quantity: number;
  warehouse?: string;
  sources: number[];
}

export interface BuiltSanmarOrder {
  request: SoapBody;
  lines: SanmarSentLine[];
  /** What was changed so SanMar would take it ("Removed commas from the company name"). */
  changes: string[];
}

const WILL_CALL = new Set<string>(SANMAR_WAREHOUSES.map((w) => w.code));
const METHODS = new Set<string>(SANMAR_SHIP_METHODS.map((m) => m.code));
const WAREHOUSE_IDS = new Set<string>(SANMAR_WAREHOUSES.map((w) => w.id));

const squash = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * The `arg0` SanMar's PO service takes, for `submitPO` and `getPreSubmitInfo`
 * alike. Throws `invalid` listing every problem when the order can't be sent
 * as it stands; tidies what it safely can (commas, spacing, notes length,
 * duplicate lines) and says so in `changes`.
 */
export function buildSanmarOrder(order: SanmarOrder, opts: SanmarOrderOptions = {}): BuiltSanmarOrder {
  const problems: string[] = [];
  const changes: string[] = [];
  const field = (label: string, value: string | undefined, max: number, required = false): string => {
    let v = squash(value);
    if (v.includes(",")) {
      v = squash(v.replace(/,/g, " "));
      changes.push(`Removed commas from the ${label} (SanMar can't take them).`);
    }
    if (required && !v) problems.push(`The ${label} is missing.`);
    if (v.length > max) problems.push(`The ${label} is ${v.length} characters; SanMar takes ${max}.`);
    return v;
  };

  const s = order.shipTo;
  const poNum = field("PO number", order.poNumber, L.poNum, true);
  const shipTo = field("ship-to company", s.company, L.shipTo);
  const attention = field("attention line", s.attention, L.attention);
  const shipAddress1 = field("ship-to address", s.address1, L.address, true);
  const shipAddress2 = field("second address line", s.address2, L.address);
  const shipCity = field("ship-to city", s.city, L.city, true);
  const shipState = squash(s.state).toUpperCase();
  if (!/^[A-Z]{2}$/.test(shipState)) problems.push(`The ship-to state must be a two-letter code (got "${squash(s.state)}").`);
  const zip = squash(s.zip).replace(/\s/g, "");
  if (!/^\d{5}(-?\d{4})?$/.test(zip)) problems.push(`The ship-to ZIP must be 5 digits or ZIP+4 (got "${squash(s.zip)}").`);
  const shipEmail = field("email", s.email, L.email);

  let notes = field("notes", order.notes, Number.MAX_SAFE_INTEGER);
  if (notes.length > L.notes) {
    notes = notes.slice(0, L.notes).trimEnd();
    changes.push(`Cut the notes to ${L.notes} characters (SanMar's limit).`);
  }

  const shipMethod = squash(order.shipMethod || "UPS").toUpperCase();
  if (WILL_CALL.has(shipMethod)) {
    if (!opts.warehouseSelection) problems.push(`Will call (${shipMethod}) needs the SanMar account set up for Warehouse Selection.`);
  } else if (!METHODS.has(shipMethod)) problems.push(`SanMar has no ship method "${shipMethod}". Use one of: ${[...METHODS].join(", ")}.`);

  // Identical lines go as one with the total quantity (SanMar asks for this).
  const merged = new Map<string, SanmarSentLine>();
  for (const [i, l] of order.lines.entries()) {
    const n = i + 1;
    const inventoryKey = squash(String(l.inventoryKey ?? ""));
    const sizeIndex = squash(String(l.sizeIndex ?? ""));
    const style = field(`style on line ${n}`, l.style, L.style).toUpperCase();
    const color = field(`color on line ${n}`, l.color, L.color);
    const size = field(`size on line ${n}`, l.size, L.size);
    const byKey = !!inventoryKey && !!sizeIndex;
    if (!byKey && !(style && color && size)) problems.push(`Line ${n} needs a style, color and size (or SanMar's inventory key and size index).`);
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > L.quantity) problems.push(`Line ${n}'s quantity must be a whole number from 1 to ${L.quantity}.`);
    let warehouse: string | undefined;
    if (l.warehouse && opts.warehouseSelection) {
      warehouse = squash(l.warehouse);
      if (!WAREHOUSE_IDS.has(warehouse)) problems.push(`Line ${n}'s warehouse ${warehouse} isn't a SanMar warehouse number.`);
    }
    const key = [byKey ? `k:${inventoryKey}:${sizeIndex}` : `s:${style}|${color.toLowerCase()}|${size.toLowerCase()}`, warehouse ?? ""].join("|");
    const prev = merged.get(key);
    if (prev) {
      prev.quantity += l.quantity;
      prev.sources.push(i);
      continue;
    }
    merged.set(key, { ...(byKey ? { inventoryKey, sizeIndex } : { style, color, size }), quantity: l.quantity, ...(warehouse ? { warehouse } : {}), sources: [i] });
  }
  if (!order.lines.length) problems.push("The order has no lines.");
  const lines = [...merged.values()];
  if (lines.length < order.lines.length) changes.push(`Combined identical lines into one (${order.lines.length} lines sent as ${lines.length}).`);
  if (problems.length) throw new OpenPromoError("invalid", `SanMar can't take this order: ${problems.join(" ")}`, { supplier: "sanmar", detail: problems.join(" ") });

  const request: SoapBody = {
    attention: attention || undefined,
    notes: notes || undefined,
    poNum,
    shipTo: shipTo || undefined,
    shipAddress1,
    shipAddress2: shipAddress2 || undefined,
    shipCity,
    shipState,
    shipZip: zip,
    shipMethod,
    shipEmail: shipEmail || undefined,
    residence: order.residential ? "Y" : "N",
    webServicePoDetailList: lines.map((l) => ({
      ...(l.inventoryKey ? { inventoryKey: l.inventoryKey, sizeIndex: l.sizeIndex } : { style: l.style, color: l.color, size: l.size }),
      quantity: l.quantity,
      ...(l.warehouse ? { whseNo: l.warehouse } : {}),
    })),
  };
  return { request, lines, changes };
}

/* ---------------------------------------------------------------- Pre-submit check */

export interface SanmarPreSubmitLine extends SanmarSentLine {
  /** ok: confirmed in a warehouse; short: not in stock (anywhere, or in the requested warehouse); not_found: SanMar doesn't know the item. */
  status: "ok" | "short" | "not_found";
  /** The warehouse SanMar says it would ship from. */
  shipsFrom?: { id: string; name?: string };
  inventoryKey?: string;
  sizeIndex?: string;
  message?: string;
}

export interface SanmarPreSubmit {
  ok: boolean;
  lines: SanmarPreSubmitLine[];
  message?: string;
}

const flag = (v: unknown) => text(v).toLowerCase() === "true";
const NOT_FOUND = /invalid|not found|no such|does not exist|discontinued|not available for (?:sale|order)/i;
const WAREHOUSE_IN = /warehouse\s*'?(\d{1,2})'?/i;

/** `getPreSubmitInfo`'s answer, matched to the lines sent (by position, else by style, color and size, else inventory key). */
export function readSanmarPreSubmit(body: XmlNode, sent: readonly SanmarSentLine[]): SanmarPreSubmit {
  const ret = node(node(body.getPreSubmitInfoResponse)?.return);
  if (!ret) throw new OpenPromoError("bad_response", undefined, { supplier: "sanmar", detail: "no getPreSubmitInfoResponse in the answer" });
  const response = node(ret.response);
  const rows = asArray((response?.webServicePoDetailList ?? ret.webServicePoDetailList) as XmlNode | XmlNode[] | undefined);
  const failed = flag(ret.errorOccurred ?? ret.errorOccured);
  const message = text(ret.message) || undefined;
  // An error with no lines to pin it on is about the whole order (a login or address problem).
  if (failed && !rows.length) throw sanmarRefusal(message ?? "unknown error");
  const keyOf = (r: { style?: unknown; color?: unknown; size?: unknown }) => [r.style, r.color, r.size].map((v) => text(v).toLowerCase()).join("|");
  const taken = new Set<number>();
  const lines = sent.map((l, i): SanmarPreSubmitLine => {
    const fits = (r: XmlNode | undefined) => !!r && (l.inventoryKey ? text(r.inventoryKey) === l.inventoryKey || !text(r.inventoryKey) : keyOf(r) === keyOf(l));
    const at = !taken.has(i) && fits(rows[i]) ? i : rows.findIndex((r, j) => !taken.has(j) && fits(r));
    if (at < 0) return { ...l, status: failed ? "short" : "ok", ...(failed && message ? { message } : {}) };
    taken.add(at);
    const r = rows[at]!;
    const said = text(r.message) || undefined;
    const lineFailed = flag(r.errorOccured ?? r.errorOccurred);
    const whse = text(r.whseNo) || WAREHOUSE_IN.exec(said ?? "")?.[1];
    const status = lineFailed ? (NOT_FOUND.test(said ?? "") ? "not_found" : "short") : "ok";
    return {
      ...l,
      status,
      ...(text(r.inventoryKey) ? { inventoryKey: text(r.inventoryKey) } : {}),
      ...(text(r.sizeIndex) ? { sizeIndex: text(r.sizeIndex) } : {}),
      ...(whse && status === "ok" ? { shipsFrom: { id: whse, name: SANMAR_WAREHOUSES.find((w) => w.id === whse)?.name } } : {}),
      ...(said ? { message: said } : {}),
    };
  });
  return { ok: lines.every((l) => l.status === "ok"), lines, ...(message ? { message } : {}) };
}

/* ---------------------------------------------------------------- SanMar's own error messages */

const AUTH = /user\s*authenticat\w*\s*fail|authentication\s*failed|invalid\s*(?:user|password|login|credentials)/i;
const NOT_ENABLED = /not (?:been )?(?:enabled|activated|set ?up|authori[sz]ed)\b|web ?services?\b.*\bnot\b/i;
const INVALID_ITEM = /invalid style|style.*not found|no product/i;

/** SanMar's own `errorOccur(r)ed` message as an error of the right kind. */
export function sanmarRefusal(message: string): OpenPromoError {
  const detail = message.slice(0, 300);
  if (AUTH.test(message)) return new OpenPromoError("auth", undefined, { supplier: "sanmar", detail });
  if (NOT_ENABLED.test(message)) return new OpenPromoError("not_enabled", undefined, { supplier: "sanmar", detail });
  if (INVALID_ITEM.test(message)) return new OpenPromoError("not_found", undefined, { supplier: "sanmar", detail });
  return new OpenPromoError("refused", undefined, { supplier: "sanmar", detail });
}
