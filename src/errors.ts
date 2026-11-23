/**
 * The one error OpenPromo throws for anything a supplier said or didn't say.
 * Callers switch on `kind`; `detail` is the supplier's own words (safe to
 * show), `code` its PromoStandards message code when it sent one.
 *
 *  - `auth`: the supplier turned the login down
 *  - `not_enabled`: the login works, but the account isn't switched on for this service
 *  - `not_found`: the supplier has no such product, order or invoice
 *  - `not_yet`: the order exists but hasn't shipped or been invoiced yet (PromoStandards 301)
 *  - `rate_limited`: too many requests; try again shortly
 *  - `unreachable`: no answer (offline, DNS, timeout, gateway)
 *  - `refused`: the supplier answered with its own error
 *  - `invalid`: the request can't be sent as it stands (checked before sending)
 *  - `bad_response`: an answer that couldn't be read
 */
export type OpenPromoErrorKind = "auth" | "not_enabled" | "not_found" | "not_yet" | "rate_limited" | "unreachable" | "refused" | "invalid" | "bad_response";

export interface OpenPromoErrorDetails {
  /** The supplier id ("sanmar"). */
  supplier?: string;
  /** The supplier's own words. */
  detail?: string;
  /** A PromoStandards service message code, or a SOAP fault code. */
  code?: string;
  /** The HTTP status, when there was one. */
  status?: number;
}

const DEFAULT_MESSAGES: Record<OpenPromoErrorKind, string> = {
  auth: "The supplier rejected the login.",
  not_enabled: "The supplier hasn't switched this service on for the account. Ask your rep to enable it.",
  not_found: "The supplier has no such item.",
  not_yet: "The supplier has nothing for this yet. Orders show up after they ship or are invoiced; try again tomorrow.",
  rate_limited: "Too many requests to the supplier. Try again in a minute.",
  unreachable: "Couldn't reach the supplier. Try again shortly.",
  refused: "The supplier refused the request.",
  invalid: "The request can't be sent as it stands.",
  bad_response: "The supplier's answer couldn't be read.",
};

export class OpenPromoError extends Error {
  override readonly name = "OpenPromoError";
  readonly supplier?: string;
  readonly detail?: string;
  readonly code?: string;
  readonly status?: number;
  constructor(
    readonly kind: OpenPromoErrorKind,
    message?: string,
    details: OpenPromoErrorDetails = {},
  ) {
    super(message ?? (details.detail ? `${DEFAULT_MESSAGES[kind]} (${details.detail})` : DEFAULT_MESSAGES[kind]));
    this.supplier = details.supplier;
    this.detail = details.detail;
    this.code = details.code;
    this.status = details.status;
  }
  toJSON() {
    return { kind: this.kind, message: this.message, supplier: this.supplier, detail: this.detail, code: this.code };
  }
}

export const isOpenPromoError = (e: unknown): e is OpenPromoError => e instanceof OpenPromoError;

/** An HTTP answer that isn't OK: 401/403 auth, 429 rate limited, 502/504 unreachable, anything else bad_response. */
export function httpError(supplier: string, status: number, body: string): OpenPromoError {
  if (status === 401 || status === 403) return new OpenPromoError("auth", undefined, { supplier, status });
  if (status === 429) return new OpenPromoError("rate_limited", undefined, { supplier, status });
  if (status === 502 || status === 504) return new OpenPromoError("unreachable", undefined, { supplier, status, detail: `gateway ${status}` });
  return new OpenPromoError("bad_response", undefined, { supplier, status, detail: `HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 200)}` });
}
