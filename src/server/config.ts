/**
 * The server's setup, read from environment variables once at start.
 *
 * OpenPromo is a pass-through: each request brings the supplier login it
 * should use, in headers (`X-SanMar-…` for SanMar, `X-Supplier-…` for other
 * PromoStandards suppliers), and the server keeps none of it. A login set in
 * env vars is only an optional default, for someone who self-hosts for one
 * account. The only thing the server needs is its own API key.
 */
import { checkSupplierConfig, PromoStandardsClient, type PromoStandardsLogin, type PromoStandardsSupplier } from "../promostandards/client.js";
import { SANMAR_PROMOSTANDARDS, SanmarClient, type SanmarEnvironment, type SanmarLogin } from "../sanmar/index.js";
import { OpenPromoError } from "../errors.js";

/** A supplier the server can talk to; logins come with each request. */
export interface SupplierDef {
  id: string;
  name: string;
  /** SanMar's own services as well as PromoStandards. */
  sanmar: boolean;
  promoStandards: PromoStandardsSupplier;
  /** "production", or the supplier's test environment ("edev" for SanMar, "test" for others): the default, a request may override it. */
  environment: string;
  /** A login from env vars, used when a request sends none. */
  defaultLogin?: SanmarLogin | PromoStandardsLogin;
}

/** The clients for one request: built from its headers, or the supplier's default login. */
export interface SupplierEntry {
  id: string;
  name: string;
  sanmar?: SanmarClient;
  promoStandards: PromoStandardsClient;
}

export interface ServerConfig {
  /** Callers send one as `Authorization: Bearer <key>`. */
  apiKeys: string[];
  /** Placing orders is off unless the owner turns it on. */
  allowOrders: boolean;
  /** The default for SanMar accounts set up for Warehouse Selection; a request may say `X-SanMar-Warehouse-Selection: on`. */
  sanmarWarehouseSelection: boolean;
  suppliers: Map<string, SupplierDef>;
  /** For tests: the transport every client uses. */
  fetch?: typeof fetch;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

interface CustomSupplier extends PromoStandardsSupplier {
  /** Optional default login; requests normally send their own. */
  login?: PromoStandardsLogin;
  environment?: "production" | "test";
}

const yes = (v: string | null | undefined) => /^(1|true|on|yes)$/i.test(v ?? "");

/** The config from env, or a `ConfigError` saying exactly what's wrong. */
export function loadConfig(env: Env = process.env, opts: { fetch?: typeof fetch } = {}): ServerConfig {
  const apiKeys = (env.OPENPROMO_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!apiKeys.length) throw new ConfigError("Set OPENPROMO_API_KEY to a long random string (e.g. `openssl rand -hex 32`). Callers send it as `Authorization: Bearer <key>`.");
  if (apiKeys.some((k) => k.length < 24)) throw new ConfigError("OPENPROMO_API_KEY must be at least 24 characters.");

  const suppliers = new Map<string, SupplierDef>();
  const environment = (env.SANMAR_ENVIRONMENT || "production").toLowerCase();
  if (environment !== "production" && environment !== "edev") throw new ConfigError('SANMAR_ENVIRONMENT must be "production" or "edev".');
  const sanmarFields = [env.SANMAR_CUSTOMER_NUMBER, env.SANMAR_USERNAME, env.SANMAR_PASSWORD];
  if (sanmarFields.some(Boolean) && !sanmarFields.every(Boolean)) throw new ConfigError("A default SanMar login needs all three of SANMAR_CUSTOMER_NUMBER, SANMAR_USERNAME and SANMAR_PASSWORD (or none: callers then send their own in headers).");
  // SanMar is always available: callers send their login with each request.
  suppliers.set("sanmar", {
    id: "sanmar",
    name: "SanMar",
    sanmar: true,
    promoStandards: SANMAR_PROMOSTANDARDS,
    environment,
    defaultLogin: sanmarFields.every(Boolean) ? { customerNumber: env.SANMAR_CUSTOMER_NUMBER!, username: env.SANMAR_USERNAME!, password: env.SANMAR_PASSWORD! } : undefined,
  });

  if (env.OPENPROMO_SUPPLIERS) {
    let list: CustomSupplier[];
    try {
      list = JSON.parse(env.OPENPROMO_SUPPLIERS) as CustomSupplier[];
    } catch {
      throw new ConfigError("OPENPROMO_SUPPLIERS must be a JSON array of supplier configs (see README).");
    }
    if (!Array.isArray(list)) throw new ConfigError("OPENPROMO_SUPPLIERS must be a JSON array.");
    for (const s of list) {
      const problems = checkSupplierConfig(s);
      if (s.login && (!s.login.id || !s.login.password)) problems.push("login needs both id and password (or leave it out)");
      if (suppliers.has(s.id)) problems.push(`supplier id "${s.id}" is used twice`);
      if (problems.length) throw new ConfigError(`OPENPROMO_SUPPLIERS: ${s.id ?? "(no id)"}: ${problems.join("; ")}`);
      const { login, environment: env2 = "production", ...supplier } = s;
      suppliers.set(s.id, { id: s.id, name: s.name, sanmar: false, promoStandards: supplier, environment: env2, defaultLogin: login });
    }
  }

  return { apiKeys, allowOrders: yes(env.OPENPROMO_ORDERS), sanmarWarehouseSelection: yes(env.SANMAR_WAREHOUSE_SELECTION), suppliers, fetch: opts.fetch };
}

/** Request headers that carry supplier logins: never logged, never stored. */
export const LOGIN_HEADERS = ["x-sanmar-customer-number", "x-sanmar-username", "x-sanmar-password", "x-supplier-id", "x-supplier-password"] as const;

/**
 * The clients for this request: the login in its headers, else the
 * supplier's default login, else `invalid` saying which headers to send.
 * `X-SanMar-Environment: edev` (or `X-Supplier-Environment: test`) picks the
 * supplier's test environment.
 */
export function clientsFor(def: SupplierDef, headers: Headers, config: Pick<ServerConfig, "fetch">): SupplierEntry {
  const h = (name: string) => headers.get(name)?.trim() || undefined;
  if (def.sanmar) {
    const given = [h("x-sanmar-customer-number"), h("x-sanmar-username"), h("x-sanmar-password")];
    if (given.some(Boolean) && !given.every(Boolean)) throw new OpenPromoError("invalid", "Send all three of X-SanMar-Customer-Number, X-SanMar-Username and X-SanMar-Password.", { supplier: def.id });
    const login = given.every(Boolean) ? { customerNumber: given[0]!, username: given[1]!, password: given[2]! } : (def.defaultLogin as SanmarLogin | undefined);
    if (!login) throw new OpenPromoError("invalid", "Send your SanMar login with the request: X-SanMar-Customer-Number, X-SanMar-Username and X-SanMar-Password (your sanmar.com web-services user).", { supplier: def.id });
    const environment = (h("x-sanmar-environment") ?? def.environment).toLowerCase();
    if (environment !== "production" && environment !== "edev") throw new OpenPromoError("invalid", 'X-SanMar-Environment must be "production" or "edev".', { supplier: def.id });
    const sanmar = new SanmarClient(login, { environment: environment as SanmarEnvironment, fetch: config.fetch });
    return { id: def.id, name: def.name, sanmar, promoStandards: sanmar.promoStandards() };
  }
  const given = [h("x-supplier-id"), h("x-supplier-password")];
  if (given.some(Boolean) && !given.every(Boolean)) throw new OpenPromoError("invalid", "Send both X-Supplier-Id and X-Supplier-Password.", { supplier: def.id });
  const login = given.every(Boolean) ? { id: given[0]!, password: given[1]! } : (def.defaultLogin as PromoStandardsLogin | undefined);
  if (!login) throw new OpenPromoError("invalid", `Send your ${def.name} PromoStandards login with the request: X-Supplier-Id and X-Supplier-Password.`, { supplier: def.id });
  const environment = (h("x-supplier-environment") ?? def.environment).toLowerCase();
  if (environment !== "production" && environment !== "test") throw new OpenPromoError("invalid", 'X-Supplier-Environment must be "production" or "test".', { supplier: def.id });
  return { id: def.id, name: def.name, promoStandards: new PromoStandardsClient(def.promoStandards, login, { environment, fetch: config.fetch }) };
}
