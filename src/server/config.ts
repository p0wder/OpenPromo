/**
 * The server's setup, read from environment variables once at start. One
 * install serves the owner's own accounts: every supplier login comes from
 * here, and the API never receives or stores anyone else's.
 */
import { checkSupplierConfig, PromoStandardsClient, type PromoStandardsSupplier } from "../promostandards/client.js";
import { SanmarClient, type SanmarEnvironment } from "../sanmar/index.js";

export interface SupplierEntry {
  id: string;
  name: string;
  /** SanMar's own services as well as PromoStandards. */
  sanmar?: SanmarClient;
  promoStandards: PromoStandardsClient;
  /** Which PromoStandards services this supplier has configured. */
  services: string[];
  environment: string;
}

export interface ServerConfig {
  /** Callers send it as `Authorization: Bearer <key>`. */
  apiKeys: string[];
  /** Placing orders is off unless the owner turns it on. */
  allowOrders: boolean;
  /** The SanMar account is set up for Warehouse Selection (lines may name a warehouse; will call allowed). */
  sanmarWarehouseSelection: boolean;
  suppliers: Map<string, SupplierEntry>;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

interface CustomSupplier extends PromoStandardsSupplier {
  login: { id: string; password: string };
  environment?: "production" | "test";
}

/** The config from env, or a `ConfigError` saying exactly what's missing. */
export function loadConfig(env: Env = process.env, opts: { fetch?: typeof fetch } = {}): ServerConfig {
  const apiKeys = (env.OPENPROMO_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!apiKeys.length) throw new ConfigError("Set OPENPROMO_API_KEY to a long random string (e.g. `openssl rand -hex 32`). Callers send it as `Authorization: Bearer <key>`.");
  if (apiKeys.some((k) => k.length < 24)) throw new ConfigError("OPENPROMO_API_KEY must be at least 24 characters.");

  const suppliers = new Map<string, SupplierEntry>();
  const sanmarFields = [env.SANMAR_CUSTOMER_NUMBER, env.SANMAR_USERNAME, env.SANMAR_PASSWORD];
  if (sanmarFields.some(Boolean)) {
    if (!sanmarFields.every(Boolean)) throw new ConfigError("Set all three of SANMAR_CUSTOMER_NUMBER, SANMAR_USERNAME and SANMAR_PASSWORD (or none).");
    const environment = (env.SANMAR_ENVIRONMENT || "production").toLowerCase();
    if (environment !== "production" && environment !== "edev") throw new ConfigError('SANMAR_ENVIRONMENT must be "production" or "edev".');
    const sanmar = new SanmarClient({ customerNumber: env.SANMAR_CUSTOMER_NUMBER!, username: env.SANMAR_USERNAME!, password: env.SANMAR_PASSWORD! }, { environment: environment as SanmarEnvironment, fetch: opts.fetch });
    const ps = sanmar.promoStandards();
    suppliers.set("sanmar", { id: "sanmar", name: "SanMar", sanmar, promoStandards: ps, services: Object.keys(ps.supplier.endpoints), environment });
  }

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
      if (!s.login?.id || !s.login?.password) problems.push("login.id and login.password are required");
      if (suppliers.has(s.id)) problems.push(`supplier id "${s.id}" is used twice`);
      if (problems.length) throw new ConfigError(`OPENPROMO_SUPPLIERS: ${s.id ?? "(no id)"}: ${problems.join("; ")}`);
      const { login, environment = "production", ...supplier } = s;
      suppliers.set(s.id, { id: s.id, name: s.name, promoStandards: new PromoStandardsClient(supplier, login, { environment, fetch: opts.fetch }), services: Object.keys(s.endpoints), environment });
    }
  }
  if (!suppliers.size) throw new ConfigError("No supplier is configured. Set SANMAR_CUSTOMER_NUMBER, SANMAR_USERNAME and SANMAR_PASSWORD, or OPENPROMO_SUPPLIERS.");

  const yes = (v: string | undefined) => /^(1|true|on|yes)$/i.test(v ?? "");
  return { apiKeys, allowOrders: yes(env.OPENPROMO_ORDERS), sanmarWarehouseSelection: yes(env.SANMAR_WAREHOUSE_SELECTION), suppliers };
}
