/**
 * A small SOAP 1.1 transport: builds an envelope from a namespace, an
 * operation and a body object (every value escaped), posts it with a timeout
 * through an injectable `fetch`, parses the answer, and turns no answer,
 * gateway errors and SOAP faults into `OpenPromoError`. It knows no supplier.
 */
import { XMLParser } from "fast-xml-parser";
import { httpError, OpenPromoError } from "./errors.js";

/** A body value: text, a nested element, repeated elements (an array), or left out (null/undefined). */
export type SoapValue = string | number | boolean | null | undefined | SoapBody | SoapValue[];
/** Child elements in order; a key may carry its own prefix ("ns:queryType"). */
export interface SoapBody {
  [element: string]: SoapValue;
}

export interface SoapEnvelopeSpec {
  /** The operation's namespace URI. */
  namespace: string;
  /** The operation element ("getPricing", "GetInventoryLevelsRequest"). */
  operation: string;
  body: SoapBody;
  /** Prefix bound to `namespace` for the operation element (default "ns"). */
  prefix?: string;
  /** Further prefixes to declare, e.g. `{ shar: ".../SharedObjects/" }`. */
  namespaces?: Record<string, string>;
  /** Prefix put on every child element that has none; unqualified when not given. */
  childPrefix?: string;
}

// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXml(value: string): string {
  return value.replace(ILLEGAL_XML, "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

const NAME = /^([A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*$/;

function elements(body: SoapBody, childPrefix: string | undefined): string {
  let out = "";
  for (const [key, value] of Object.entries(body)) {
    if (!NAME.test(key)) throw new Error(`Not an XML element name: ${key}`);
    const tag = key.includes(":") || !childPrefix ? key : `${childPrefix}:${key}`;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) throw new Error(`Nested arrays aren't elements: ${key}`);
      const inner = typeof v === "object" ? elements(v, childPrefix) : escapeXml(String(v));
      out += `<${tag}>${inner}</${tag}>`;
    }
  }
  return out;
}

/** The whole request document. */
export function buildSoapEnvelope(spec: SoapEnvelopeSpec): string {
  const prefix = spec.prefix ?? "ns";
  const declared = { [prefix]: spec.namespace, ...spec.namespaces };
  const xmlns = Object.entries(declared)
    .map(([p, uri]) => ` xmlns:${p}="${escapeXml(uri)}"`)
    .join("");
  const op = `${prefix}:${spec.operation}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"${xmlns}>
  <soapenv:Header/>
  <soapenv:Body>
    <${op}>${elements(spec.body, spec.childPrefix)}</${op}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/* ---------------------------------------------------------------- Reading answers */

/** Namespace prefixes and attributes dropped; every value a string. */
export const soapParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });

export interface SoapFault {
  code: string;
  message: string;
  detail?: unknown;
}

export type XmlNode = Record<string, unknown>;

/** One or many of an element, always as a list. */
export const asArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null || (v as unknown) === "" ? [] : Array.isArray(v) ? v : [v]);

/** An element's text ("" when absent or not text). */
export const text = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/** An element as a node, when it is one. */
export const node = (v: unknown): XmlNode | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as XmlNode) : undefined);

/** A SOAP 1.1 (`faultcode`/`faultstring`) or 1.2 (`Code`/`Reason`) fault. */
function readFault(fault: XmlNode): SoapFault {
  const code = text(fault.faultcode) || text(node(fault.Code)?.Value) || "Fault";
  const reason = node(fault.Reason);
  const message = text(fault.faultstring) || text(reason?.Text) || text(fault.Reason) || "SOAP fault";
  return { code, message, detail: fault.detail ?? fault.Detail };
}

/** The envelope's Body and any fault in it; null when the text isn't a SOAP envelope at all. */
export function readSoapBody(xml: string): { body: XmlNode; fault: SoapFault | null } | null {
  let doc: XmlNode;
  try {
    doc = soapParser.parse(xml) as XmlNode;
  } catch {
    return null;
  }
  const body = node(node(doc?.Envelope)?.Body);
  if (!body) return null;
  const fault = node(body.Fault);
  return { body, fault: fault ? readFault(fault) : null };
}

/* ---------------------------------------------------------------- Sending */

export interface SoapCall extends SoapEnvelopeSpec {
  /** Who the answer is from, for errors. */
  supplier: string;
  url: string;
  /** The SOAPAction header ("" when the service doesn't use one). */
  soapAction?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SoapReply {
  status: number;
  ok: boolean;
  /** The raw answer, for when it isn't SOAP. */
  text: string;
  /** The parsed Body (prefixes dropped); null when the answer isn't a SOAP envelope. */
  body: XmlNode | null;
  fault: SoapFault | null;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Why there was no answer, in a few words that are safe to show. */
function noAnswer(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";
  const code = err?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup failed";
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return code === "ECONNREFUSED" ? "connection refused" : "connection reset";
  return err?.message || "no answer";
}

/**
 * Sends the call and reads whatever comes back. Throws only when nothing came
 * back (offline, DNS, timeout): `unreachable`. Use it when the caller must
 * judge the answer itself (placing an order); otherwise use `soapRequest`.
 */
export async function sendSoap(call: SoapCall): Promise<SoapReply> {
  const fetchImpl = call.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(call.url, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: call.soapAction ?? "" },
      body: buildSoapEnvelope(call),
      signal: AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    throw new OpenPromoError("unreachable", undefined, { supplier: call.supplier, detail: noAnswer(e) });
  }
  const raw = await res.text().catch(() => "");
  const parsed = readSoapBody(raw);
  return { status: res.status, ok: res.ok, text: raw, body: parsed?.body ?? null, fault: parsed?.fault ?? null };
}

/**
 * An error for an answer that can't be used, or null when it can: a SOAP
 * fault is `refused` with the fault's words; a non-OK status maps as
 * `httpError` does; an OK answer that isn't SOAP is `bad_response`.
 */
export function soapReplyError(supplier: string, reply: SoapReply): OpenPromoError | null {
  if (reply.fault) return new OpenPromoError("refused", undefined, { supplier, detail: reply.fault.message, code: reply.fault.code, status: reply.status });
  if (!reply.ok) return httpError(supplier, reply.status, reply.text);
  if (!reply.body) return new OpenPromoError("bad_response", undefined, { supplier, detail: "not a SOAP answer", status: reply.status });
  return null;
}

/** Sends the call and returns the Body, throwing an `OpenPromoError` for anything else. */
export async function soapRequest(call: SoapCall): Promise<XmlNode> {
  const reply = await sendSoap(call);
  const err = soapReplyError(call.supplier, reply);
  if (err) throw err;
  return reply.body!;
}
