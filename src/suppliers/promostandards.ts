/**
 * Any PromoStandards supplier as a driver, from its endpoints alone: a
 * directory entry or a server's own config becomes a supplier with no code.
 */
import { PromoStandardsClient, type PromoStandardsSupplier } from "../promostandards/client.js";
import type { PromoStandardsService } from "../promostandards/types.js";
import { ID_PASSWORD_LOGIN, type Capability, type SupplierConnection, type SupplierDriver } from "./driver.js";

/** A PromoStandards supplier as the directory lists it. */
export interface PromoStandardsListing extends PromoStandardsSupplier {
  /** PromoStandards' own company code, when the supplier came from its directory. */
  code?: string;
  website?: string;
  notes?: string;
}

const CAPABILITY_OF: Record<PromoStandardsService, Capability> = {
  productData: "product",
  inventory: "inventory",
  pricing: "pricing",
  orderStatus: "orderStatus",
  shipments: "shipments",
  invoices: "invoices",
};

/** A connection that answers from these PromoStandards services, only those the supplier lists. */
export function promoStandardsConnection(client: PromoStandardsClient): SupplierConnection {
  const all: Required<SupplierConnection> = {
    product: (id) => client.getProduct(id),
    inventory: (id, f) => client.getInventory(id, f.partIds?.length ? { partIds: f.partIds } : {}),
    pricing: (id, o) => client.getPricing(id, o),
    orderStatus: (q) => client.getOrderStatus(q),
    shipments: (q) => client.getShipments(q),
    invoices: (q) => client.getInvoices(q),
  };
  const out: SupplierConnection = {};
  for (const [service, capability] of Object.entries(CAPABILITY_OF) as [PromoStandardsService, Capability][]) {
    if (client.has(service)) (out as Record<Capability, unknown>)[capability] = all[capability];
  }
  return out;
}

/** The shared questions a PromoStandards supplier answers: the services it lists at versions OpenPromo talks. */
export function promoStandardsCapabilities(supplier: PromoStandardsSupplier): Capability[] {
  const probe = new PromoStandardsClient(supplier, { id: "", password: "" });
  return (Object.keys(CAPABILITY_OF) as PromoStandardsService[]).filter((s) => probe.has(s)).map((s) => CAPABILITY_OF[s]);
}

/** A PromoStandards supplier as a driver: `X-Supplier-Id` and `X-Supplier-Password`, production or test. */
export function promoStandardsDriver(listing: PromoStandardsListing): SupplierDriver {
  const hasTest = Object.values(listing.endpoints).some((ep) => ep?.testUrl);
  return {
    id: listing.id,
    name: listing.name,
    kind: "promostandards",
    capabilities: promoStandardsCapabilities(listing),
    login: ID_PASSWORD_LOGIN,
    environments: hasTest ? ["production", "test"] : ["production"],
    website: listing.website,
    notes: listing.notes,
    connect: (login, opts) => promoStandardsConnection(new PromoStandardsClient(listing, { id: login.id ?? "", password: login.password ?? "" }, { environment: opts.environment === "test" ? "test" : "production", fetch: opts.fetch })),
  };
}
