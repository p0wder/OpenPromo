/**
 * S&S Activewear's REST API v2 (https://api.ssactivewear.com/V2/Default.aspx)
 * on one login: HTTP Basic auth with the account number and API key, JSON
 * with `mediaType=json` on every call. This is the transport Inkline has run
 * in production: when S&S turns a login down it tries the Canadian API host
 * and the two fields the wrong way round before giving up, and it never
 * retries a write on another host, so an order can't go out twice.
 */
import { httpError, OpenPromoError } from "../errors.js";
import type { SsOrder, SsProduct, SsStyle } from "./types.js";

export interface SsActivewearLogin {
  accountNumber: string;
  apiKey: string;
}

/** Remembers which sign-in variant worked for a login, between clients (the server keeps none: each request tries in order). */
export interface SsSignInMemory {
  get(): number | undefined;
  set(variant: number | undefined): void;
}

export interface SsActivewearClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Start with the Canadian host (api.ssactivewear.ca) for a Canadian account. */
  region?: "us" | "ca";
  signIn?: SsSignInMemory;
}

const US_API = "https://api.ssactivewear.com/v2";
const CA_API = "https://api.ssactivewear.ca/v2";

/** Ways to sign in, tried in order when S&S answers 401/403. */
export const SS_SIGN_IN_VARIANTS = [
  { label: "api.ssactivewear.com", base: US_API, swap: false },
  { label: "api.ssactivewear.ca (Canadian accounts)", base: CA_API, swap: false },
  { label: "api.ssactivewear.com with account number and API key swapped", base: US_API, swap: true },
] as const;

const SUPPLIER = "ssactivewear";
const list = <T>(v: T[] | T | null | undefined): T[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);
const same = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export class SsActivewearClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly memory: SsSignInMemory;
  constructor(
    private readonly login: SsActivewearLogin,
    opts: SsActivewearClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    let remembered: number | undefined = opts.region === "ca" ? 1 : undefined;
    this.memory = opts.signIn ?? { get: () => remembered, set: (v) => (remembered = v) };
  }

  private credentials(swap: boolean) {
    const [user, pass] = swap ? [this.login.apiKey, this.login.accountNumber] : [this.login.accountNumber, this.login.apiKey];
    return "Basic " + btoa(`${user}:${pass}`);
  }

  /** A read. Null when S&S answers 404 (it has nothing under that identifier). */
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
    const qs = new URLSearchParams({ mediaType: "json", ...params });
    const known = this.memory.get();
    const all = SS_SIGN_IN_VARIANTS.map((_, i) => i);
    const order = known === undefined ? all : [known, ...all.filter((i) => i !== known)];
    const rejected: string[] = [];
    let unreachable = 0;
    for (const i of order) {
      const variant = SS_SIGN_IN_VARIANTS[i]!;
      let res: Response;
      try {
        res = await this.fetchImpl(`${variant.base}${path}?${qs}`, { headers: { Authorization: this.credentials(variant.swap), Accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        unreachable++;
        rejected.push(`${variant.label}: unreachable (${(e as Error).message})`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const detail = (await res.text().catch(() => "")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
        rejected.push(`${variant.label}: ${res.status}${detail ? ` "${detail}"` : ""}`);
        if (known === i) this.memory.set(undefined);
        continue;
      }
      if (this.memory.get() !== i) this.memory.set(i);
      if (res.status === 404) return null;
      if (!res.ok) throw httpError(SUPPLIER, res.status, await res.text().catch(() => ""));
      try {
        return (await res.json()) as T;
      } catch {
        throw new OpenPromoError("bad_response", undefined, { supplier: SUPPLIER, status: res.status, detail: "the answer wasn't JSON" });
      }
    }
    if (unreachable && rejected.length === unreachable) throw new OpenPromoError("unreachable", undefined, { supplier: SUPPLIER, detail: rejected.join("; ") });
    const diagnostic = [
      `Tried ${rejected.join("; ")}`,
      `account number is ${this.login.accountNumber.length} characters${/^\d+$/.test(this.login.accountNumber) ? " (digits only)" : " and is not all digits (S&S account numbers are numeric)"}`,
      `API key is ${this.login.apiKey.length} characters`,
    ].join(" · ");
    throw new OpenPromoError("auth", undefined, { supplier: SUPPLIER, detail: diagnostic, status: 401 });
  }

  /**
   * A write, on the sign-in variant a read already proved (the US host unless
   * a read found otherwise). Never retried: a request that may have reached
   * S&S must not go out twice. Throws only when S&S can't be reached.
   */
  async post(path: string, body: unknown, timeoutMs = 45_000): Promise<Response> {
    const variant = SS_SIGN_IN_VARIANTS[this.memory.get() ?? 0]!;
    return this.fetchImpl(`${variant.base}${path}?mediaType=json`, {
      method: "POST",
      headers: { Authorization: this.credentials(variant.swap), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** The whole styles catalog (several thousand). S&S suggests fetching it once a day, not per search. */
  async styles(): Promise<SsStyle[]> {
    return list(await this.get<SsStyle[]>("/styles/"));
  }

  /**
   * One style, by S&S's numeric style id, or by part number or "Brand Style"
   * (S&S's `/styles/{identifier}`; the non-numeric forms are as we read S&S's
   * docs, unconfirmed). Null when S&S has none.
   */
  async style(identifier: string): Promise<SsStyle | null> {
    return list(await this.get<SsStyle[]>(`/styles/${encodeURIComponent(identifier.trim())}`))[0] ?? null;
  }

  /** Every color and size (SKU) of a style, with prices and stock per warehouse. */
  async products(styleId: string | number): Promise<SsProduct[]> {
    return list(await this.get<SsProduct[]>("/products/", { styleid: String(styleId) }));
  }

  /** The orders S&S has filed under this identifier (a PO, order or invoice number: S&S's `/orders/{identifier}`). */
  async orders(identifier: string, opts: { lines?: boolean } = {}): Promise<SsOrder[]> {
    return list(await this.get<SsOrder[]>(`/orders/${encodeURIComponent(identifier.trim())}`, opts.lines ? { lines: "true" } : {}));
  }

  /** The account's orders filed under exactly this PO number; [] when none. */
  async ordersByPo(poNumber: string, opts: { lines?: boolean } = {}): Promise<SsOrder[]> {
    return (await this.orders(poNumber, opts)).filter((o) => same(o.poNumber, poNumber));
  }

  /**
   * Orders invoiced between two days (YYYY-MM-DD), with their lines. The
   * parameter names are as we read S&S's docs (unconfirmed), so the answer is
   * also kept to the range here: an ignored filter still answers only what was asked.
   */
  async ordersInvoiced(from: string, to: string): Promise<SsOrder[]> {
    const found = list(await this.get<SsOrder[]>("/orders/", { invoicestartdate: from, invoiceenddate: to, lines: "true" }));
    return found.filter((o) => {
      const d = String(o.invoiceDate ?? "").slice(0, 10);
      return !d || (d >= from && d <= to);
    });
  }
}
