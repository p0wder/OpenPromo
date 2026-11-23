/**
 * The server's setup, read from environment variables once at start.
 *
 * OpenPromo is a pass-through: each request brings the supplier login it
 * should use, in the headers its supplier's driver names, and the server
 * keeps none of it. A login set in env vars is only an optional default, for
 * someone who self-hosts for one account. Its names follow one rule for every
 * supplier: `{SUPPLIER}_{FIELD}` (SANMAR_USERNAME, SSACTIVEWEAR_API_KEY,
 * ALPHABRODER_ID). The only thing the server needs is its own API key.
 */
import { OpenPromoError } from "../errors.js";
import { envPrefix, loginEnvVar, type SupplierConnection, type SupplierDriver, type SupplierLogin } from "../suppliers/driver.js";
import type { PromoStandardsListing } from "../suppliers/promostandards.js";
import { checkDrivers, supplierDrivers } from "../suppliers/registry.js";

/** A supplier the server serves: its driver, and the defaults from env vars. */
export interface SupplierDef {
  id: string;
  name: string;
  driver: SupplierDriver;
  /** The environment used when a request doesn't say. */
  environment: string;
  /** A login from env vars, used when a request sends none. */
  defaultLogin?: SupplierLogin;
}

export interface ServerConfig {
  /** Callers send one as `Authorization: Bearer <key>`. */
  apiKeys: string[];
  /**
   * The suppliers that may place real orders on this server (OPENPROMO_ORDERS).
   * Empty unless the owner names them. Check it with `mayOrder`.
   */
  orders: ReadonlySet<string>;
  suppliers: Map<string, SupplierDef>;
  /** The environment variables, for drivers' own settings (never logins: those are read here). */
  env: Record<string, string | undefined>;
  /** For tests: the transport every client uses. */
  fetch?: typeof fetch;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

/** A supplier in OPENPROMO_SUPPLIERS: a PromoStandards listing, optionally with a default login and environment. */
interface CustomSupplier extends PromoStandardsListing {
  login?: { id: string; password: string };
  environment?: "production" | "test";
}

/** OPENPROMO_ORDERS words for "the written drivers that take orders" and for "none" (`on` and `off` as before; the others as `on` and `off` were always read). */
const ON = /^(1|true|on|yes)$/i;
const OFF = /^(0|false|off|no)$/i;

/**
 * OPENPROMO_ORDERS: comma-separated supplier ids that may place real orders.
 * `on` means the written drivers that take orders (SanMar and S&S Activewear),
 * never a directory supplier, so an install that had `on` orders from the same
 * suppliers as before. Unset or `off` means none. An id the server doesn't
 * serve is a `ConfigError` naming it.
 */
function ordersFrom(value: string | undefined, drivers: SupplierDriver[]): Set<string> {
  const words = (value ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  if (words.some((w) => OFF.test(w))) {
    if (words.length > 1) throw new ConfigError("OPENPROMO_ORDERS: `off` can't be combined with supplier ids. Leave it unset or `off` for none, or list the ids that may order.");
    return new Set();
  }
  const orders = new Set<string>();
  const unknown: string[] = [];
  for (const w of words) {
    if (ON.test(w)) {
      for (const d of drivers) if (d.kind === "native" && d.routes?.some((r) => r.write)) orders.add(d.id);
    } else if (drivers.some((d) => d.id === w)) orders.add(w);
    else unknown.push(w);
  }
  if (unknown.length) throw new ConfigError(`OPENPROMO_ORDERS names suppliers this server doesn't serve: ${unknown.join(", ")}. Use ids from GET /v1/suppliers (e.g. sanmar, ssactivewear), \`on\` for SanMar and S&S, or \`off\`.`);
  return orders;
}

/** Whether this supplier may place real orders on this server. Every write route checks it for its own supplier. */
export const mayOrder = (config: Pick<ServerConfig, "orders">, supplierId: string) => config.orders.has(supplierId);

/** What a write route answers when its supplier may not order: the supplier, and the variable to set. */
export const ordersOffMessage = (def: Pick<SupplierDef, "id" | "name">) =>
  `Placing orders with ${def.name} is switched off on this server. Add ${def.id} to OPENPROMO_ORDERS (a comma-separated list of supplier ids) to allow it.`;

/** The config from env, or a `ConfigError` saying exactly what's wrong. */
export function loadConfig(env: Env = process.env, opts: { fetch?: typeof fetch; drivers?: SupplierDriver[] } = {}): ServerConfig {
  const apiKeys = (env.OPENPROMO_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!apiKeys.length) throw new ConfigError("Set OPENPROMO_API_KEY to a long random string (e.g. `openssl rand -hex 32`). Callers send it as `Authorization: Bearer <key>`.");
  if (apiKeys.some((k) => k.length < 24)) throw new ConfigError("OPENPROMO_API_KEY must be at least 24 characters.");

  let custom: CustomSupplier[] = [];
  if (env.OPENPROMO_SUPPLIERS) {
    try {
      custom = JSON.parse(env.OPENPROMO_SUPPLIERS) as CustomSupplier[];
    } catch {
      throw new ConfigError("OPENPROMO_SUPPLIERS must be a JSON array of supplier configs (see README).");
    }
    if (!Array.isArray(custom)) throw new ConfigError("OPENPROMO_SUPPLIERS must be a JSON array.");
    for (const s of custom) if (s.login && (!s.login.id || !s.login.password)) throw new ConfigError(`OPENPROMO_SUPPLIERS: ${s.id}: login needs both id and password (or leave it out)`);
  }
  const only = (env.OPENPROMO_ENABLED_SUPPLIERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  let drivers: SupplierDriver[];
  try {
    drivers = opts.drivers ?? supplierDrivers({ extra: custom.map(({ login: _l, environment: _e, ...listing }) => listing), only });
  } catch (e) {
    throw new ConfigError(`OPENPROMO_SUPPLIERS: ${(e as Error).message}`);
  }
  const problems = checkDrivers(drivers);
  if (problems.length) throw new ConfigError(problems.join("; "));
  const unknown = only.filter((id) => !drivers.some((d) => d.id === id));
  if (unknown.length) throw new ConfigError(`OPENPROMO_ENABLED_SUPPLIERS names suppliers OpenPromo doesn't have: ${unknown.join(", ")}.`);

  const suppliers = new Map<string, SupplierDef>();
  for (const driver of drivers) {
    const own = custom.find((c) => c.id === driver.id);
    const environment = (env[`${envPrefix(driver.id)}_ENVIRONMENT`] || own?.environment || driver.environments[0]!).toLowerCase();
    if (!driver.environments.includes(environment)) throw new ConfigError(`${envPrefix(driver.id)}_ENVIRONMENT must be ${driver.environments.map((e) => `"${e}"`).join(" or ")}.`);
    const fields = driver.login.map((f) => [f.key, env[loginEnvVar(driver.id, f.key)]] as const);
    if (fields.some(([, v]) => v) && !fields.every(([, v]) => v)) {
      throw new ConfigError(`A default ${driver.name} login needs all of ${driver.login.map((f) => loginEnvVar(driver.id, f.key)).join(", ")} (or none: callers then send their own in headers).`);
    }
    const defaultLogin = fields.every(([, v]) => v) ? Object.fromEntries(fields) as SupplierLogin : own?.login ? { id: own.login.id, password: own.login.password } : undefined;
    suppliers.set(driver.id, { id: driver.id, name: driver.name, driver, environment, defaultLogin });
  }

  return { apiKeys, orders: ordersFrom(env.OPENPROMO_ORDERS, drivers), suppliers, env, fetch: opts.fetch };
}

/** The header that picks a supplier's environment. */
export const environmentHeader = (driver: SupplierDriver) => driver.environmentHeader ?? "X-Supplier-Environment";

/**
 * The connection for this request: the login in its headers, else the
 * supplier's default login, else `invalid` naming the headers to send.
 */
export function connectionFor(def: SupplierDef, headers: Headers, config: Pick<ServerConfig, "fetch">): SupplierConnection {
  const { driver } = def;
  const h = (name: string) => headers.get(name)?.trim() || undefined;
  const given = driver.login.map((f) => [f.key, h(f.header)] as const);
  const names = driver.login.map((f) => f.header);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
  if (given.some(([, v]) => v) && !given.every(([, v]) => v)) throw new OpenPromoError("invalid", `Send all of ${list}.`, { supplier: def.id });
  const login = given.every(([, v]) => v) ? (Object.fromEntries(given) as SupplierLogin) : def.defaultLogin;
  if (!login) throw new OpenPromoError("invalid", `Send your ${def.name} login with the request: ${list} (${driver.login.map((f) => f.label).join(", ")}).`, { supplier: def.id });
  const environment = (h(environmentHeader(driver)) ?? def.environment).toLowerCase();
  if (!driver.environments.includes(environment)) throw new OpenPromoError("invalid", `${environmentHeader(driver)} must be ${driver.environments.map((e) => `"${e}"`).join(" or ")}.`, { supplier: def.id });
  return driver.connect(login, { environment, fetch: config.fetch });
}
