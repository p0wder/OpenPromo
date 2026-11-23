/**
 * Turning PromoStandards' endpoint directory (its Web Service Repository:
 * every member company, and each one's service endpoints) into directory
 * entries. Pure: the sync script fetches, this decides. Field names are read
 * loosely (the repository's JSON has changed case over the years), and
 * everything left out is reported with why, so a sync is reviewable.
 */
import { SUPPORTED_VERSIONS, type PromoStandardsEndpoint } from "../promostandards/client.js";
import type { PromoStandardsService } from "../promostandards/types.js";
import type { PromoStandardsListing } from "../suppliers/promostandards.js";

/** The repository's API, as of this writing. */
export const REPOSITORY = "https://services.promostandards.org/WebServiceRepository/WebServiceRepository.svc/json";

type Json = Record<string, unknown>;

/** The first of these keys present on the object, any case. */
function pick(o: unknown, ...keys: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined && (o as Json)[real] !== undefined && (o as Json)[real] !== null) return (o as Json)[real];
  }
  return undefined;
}
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");

/** A PromoStandards service name (long or short form) as OpenPromo's service key. */
export function serviceKey(name: string): PromoStandardsService | null {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  if (n === "productdata" || n === "product" || n === "pds") return "productData";
  if (n === "inventory" || n === "inv") return "inventory";
  if (n === "productpricingandconfiguration" || n === "pricingandconfiguration" || n === "ppc") return "pricing";
  if (n === "orderstatus" || n === "odrstat") return "orderStatus";
  if (n === "ordershipmentnotification" || n === "osn") return "shipments";
  if (n === "invoice" || n === "invoices" || n === "invc") return "invoices";
  return null;
}

/** A company name as a supplier id: "Alpha Broder, LLC" → "alpha-broder". */
export function supplierId(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(incorporated|inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export interface RepositoryCompany {
  code: string;
  name: string;
  type: string;
}

/** The repository's companies list, read loosely. */
export function readCompanies(json: unknown): RepositoryCompany[] {
  const list = Array.isArray(json) ? json : (pick(json, "companies", "Companies", "d") as unknown[]) ?? [];
  return (Array.isArray(list) ? list : []).map((c) => ({ code: str(pick(c, "Code", "CompanyCode")), name: str(pick(c, "Name", "CompanyName")), type: str(pick(c, "Type", "CompanyType")) })).filter((c) => c.code && c.name);
}

export interface RepositoryEndpoint {
  service: string;
  version: string;
  url: string;
  /** "PROD" or "TEST" (or blank). */
  environment: string;
  status: string;
}

/** One company's endpoints list, read loosely. A service may be a nested object or flat fields. */
export function readEndpoints(json: unknown): RepositoryEndpoint[] {
  const list = Array.isArray(json) ? json : (pick(json, "endpoints", "Endpoints", "d") as unknown[]) ?? [];
  return (Array.isArray(list) ? list : []).map((e) => {
    const service = pick(e, "Service");
    const nested = service && typeof service === "object";
    return {
      service: str(nested ? pick(service, "Name", "ServiceName", "Code") : pick(e, "ServiceName", "Service", "ServiceCode")),
      version: str(nested ? pick(service, "Version", "VersionNumber") : pick(e, "Version", "ServiceVersion", "VersionNumber")),
      url: str(pick(e, "URL", "Url", "EndpointURL", "EndpointUrl")),
      environment: str(pick(e, "Environment", "Env", "Type")).toUpperCase(),
      status: str(pick(e, "Status", "EndpointStatus")),
    };
  });
}

export interface SyncReport {
  listings: PromoStandardsListing[];
  /** Why each company or endpoint was left out. */
  skipped: string[];
}

/**
 * Directory entries from the repository: one per supplier with at least one
 * service OpenPromo can talk. Per service, the highest version OpenPromo
 * supports, its production URL (and test URL when listed). Ids are the
 * company name as a slug; a clash keeps the code appended.
 */
export function listingsFromRepository(companies: readonly RepositoryCompany[], endpointsByCode: ReadonlyMap<string, readonly RepositoryEndpoint[]>): SyncReport {
  const skipped: string[] = [];
  const listings: PromoStandardsListing[] = [];
  const ids = new Map<string, number>();
  for (const c of companies) if (!/distributor/i.test(c.type)) ids.set(supplierId(c.name), (ids.get(supplierId(c.name)) ?? 0) + 1);
  for (const company of [...companies].sort((a, b) => a.name.localeCompare(b.name))) {
    if (/distributor/i.test(company.type)) continue;
    const endpoints: Partial<Record<PromoStandardsService, PromoStandardsEndpoint>> = {};
    const byService = new Map<PromoStandardsService, RepositoryEndpoint[]>();
    for (const ep of endpointsByCode.get(company.code) ?? []) {
      const key = serviceKey(ep.service);
      const label = `${company.name}: ${ep.service} ${ep.version}`;
      if (!key) continue; // a service OpenPromo doesn't speak (Media, Purchase Order, …): not worth a line
      if (/inactive|disabled|retired/i.test(ep.status)) skipped.push(`${label}: listed as ${ep.status}`);
      else if (!SUPPORTED_VERSIONS[key].includes(ep.version)) skipped.push(`${label}: OpenPromo talks ${SUPPORTED_VERSIONS[key].join(", ")}`);
      else if (!/^https:\/\//i.test(ep.url)) skipped.push(`${label}: URL isn't https (${ep.url || "none"})`);
      else byService.set(key, [...(byService.get(key) ?? []), ep]);
    }
    for (const [key, eps] of byService) {
      const best = [...new Set(eps.map((e) => e.version))].sort(compareVersions).at(-1)!;
      const at = eps.filter((e) => e.version === best);
      const prod = at.find((e) => e.environment !== "TEST");
      const test = at.find((e) => e.environment === "TEST");
      if (!prod) {
        skipped.push(`${company.name}: ${key} ${best}: only a test URL is listed`);
        continue;
      }
      endpoints[key] = { version: best, url: prod.url, ...(test ? { testUrl: test.url } : {}) };
    }
    if (!Object.keys(endpoints).length) {
      skipped.push(`${company.name} (${company.code}): no service OpenPromo can talk`);
      continue;
    }
    const slug = supplierId(company.name) || company.code.toLowerCase();
    const id = (ids.get(slug) ?? 0) > 1 ? `${slug}-${company.code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : slug;
    listings.push({ id, name: company.name, code: company.code, endpoints });
  }
  return { listings, skipped };
}

/** data.ts for these listings. */
export function renderDirectoryData(listings: readonly PromoStandardsListing[], syncedAt: string): string {
  const body = listings.map((l) => `  ${JSON.stringify({ id: l.id, name: l.name, code: l.code, endpoints: l.endpoints })},`).join("\n");
  return `/**
 * GENERATED by \`pnpm directory:sync\` from PromoStandards' endpoint directory.
 * Don't edit by hand: fixes go in overrides.ts.
 */
import type { PromoStandardsListing } from "../suppliers/promostandards.js";

export const DIRECTORY_SYNCED_AT: string | null = ${JSON.stringify(syncedAt)};

export const DIRECTORY_DATA: readonly PromoStandardsListing[] = [
${body}
];
`;
}
