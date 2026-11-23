/**
 * Every supplier OpenPromo can serve: the drivers written for a supplier's
 * own API, then the PromoStandards directory, then a server's own additions.
 * Ids are unique; a written driver always wins over a directory entry.
 */
import { DIRECTORY } from "../directory/index.js";
import { checkSupplierConfig } from "../promostandards/client.js";
import { sanmarDriver } from "../sanmar/driver.js";
import { ssActivewearDriver } from "../ssactivewear/driver.js";
import type { SupplierConnection, SupplierDriver } from "./driver.js";
import { promoStandardsDriver, type PromoStandardsListing } from "./promostandards.js";

/** Suppliers with a driver of their own, written for their API. */
export const NATIVE_DRIVERS: readonly SupplierDriver<SupplierConnection>[] = [sanmarDriver as SupplierDriver<SupplierConnection>, ssActivewearDriver as SupplierDriver<SupplierConnection>];

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Problems with a set of drivers (bad or repeated ids, login fields without headers); empty when usable. */
export function checkDrivers(drivers: readonly SupplierDriver[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of drivers) {
    if (!ID.test(d.id)) problems.push(`supplier id "${d.id}" must be lowercase letters, digits and dashes`);
    if (seen.has(d.id)) problems.push(`supplier id "${d.id}" is used twice`);
    seen.add(d.id);
    if (!d.login.length || d.login.some((f) => !f.key || !/^X-[A-Za-z0-9-]+$/.test(f.header))) problems.push(`${d.id}: every login field needs a key and an X- header`);
    if (!d.environments.length || d.environments[0] !== "production") problems.push(`${d.id}: environments must start with "production"`);
  }
  return problems;
}

/**
 * The drivers to serve: written drivers, then the directory (less any id a
 * written driver has), then `extra` PromoStandards listings, which replace a
 * directory entry of the same id. `only`, when given, keeps just those ids.
 */
export function supplierDrivers(opts: { directory?: readonly PromoStandardsListing[]; extra?: readonly PromoStandardsListing[]; only?: readonly string[] } = {}): SupplierDriver[] {
  const native = new Set(NATIVE_DRIVERS.map((d) => d.id));
  const extra = opts.extra ?? [];
  for (const e of extra) {
    if (native.has(e.id)) throw new Error(`"${e.id}" has its own driver; give your supplier another id`);
    const problems = checkSupplierConfig(e);
    if (problems.length) throw new Error(`${e.id ?? "(no id)"}: ${problems.join("; ")}`);
  }
  const extraIds = new Set(extra.map((e) => e.id));
  const listed = [...(opts.directory ?? DIRECTORY).filter((e) => !native.has(e.id) && !extraIds.has(e.id)), ...extra];
  const all: SupplierDriver[] = [...NATIVE_DRIVERS, ...listed.map(promoStandardsDriver)];
  const only = opts.only?.length ? new Set(opts.only) : null;
  return only ? all.filter((d) => only.has(d.id)) : all;
}
