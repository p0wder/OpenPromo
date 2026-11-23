/**
 * Any PromoStandards supplier as a driver, from its endpoints alone: a
 * directory entry or a server's own config becomes a supplier with no code.
 */
import { PromoStandardsClient, type PromoStandardsSupplier } from "../promostandards/client.js";
import type { Media, PromoStandardsService } from "../promostandards/types.js";
import { ID_PASSWORD_LOGIN, type Capability, type SupplierConnection, type SupplierDriver } from "./driver.js";
import { hasClassType, type MediaFilter } from "./media.js";

/** A PromoStandards supplier as the directory lists it. */
export interface PromoStandardsListing extends PromoStandardsSupplier {
  /** PromoStandards' own company code, when the supplier came from its directory. */
  code?: string;
  website?: string;
  notes?: string;
}

/** The shared questions each service answers. */
const CAPABILITY_OF: Record<PromoStandardsService, readonly Capability[]> = {
  productData: ["product"],
  inventory: ["inventory"],
  pricing: ["pricing"],
  orderStatus: ["orderStatus"],
  shipments: ["shipments"],
  invoices: ["invoices"],
  media: ["media", "mediaChanges"],
};

/** Media Content's `classType` is a number: a class type's name is matched on the answer instead. */
async function psMedia(client: PromoStandardsClient, productId: string, f: MediaFilter): Promise<Media> {
  const classType = f.classType?.trim();
  const media = await client.getMedia(productId, { mediaType: f.mediaType, partId: f.partId, classType: classType && /^\d+$/.test(classType) ? classType : undefined });
  return classType ? { ...media, items: media.items.filter((m) => hasClassType(m, classType)) } : media;
}

/** A connection that answers from these PromoStandards services, only those the supplier lists. */
export function promoStandardsConnection(client: PromoStandardsClient): SupplierConnection {
  const all: Required<SupplierConnection> = {
    product: (id) => client.getProduct(id),
    inventory: (id, f) => client.getInventory(id, f.partIds?.length ? { partIds: f.partIds } : {}),
    pricing: (id, o) => client.getPricing(id, o),
    orderStatus: (q) => client.getOrderStatus(q),
    shipments: (q) => client.getShipments(q),
    invoices: (q) => client.getInvoices(q),
    media: (id, f) => psMedia(client, id, f),
    mediaChanges: (since) => client.getMediaChanges(since),
  };
  const out: SupplierConnection = {};
  for (const [service, capabilities] of Object.entries(CAPABILITY_OF) as [PromoStandardsService, readonly Capability[]][]) {
    if (client.has(service)) for (const capability of capabilities) (out as Record<Capability, unknown>)[capability] = all[capability];
  }
  return out;
}

/** The shared questions a PromoStandards supplier answers: the services it lists at versions OpenPromo talks. */
export function promoStandardsCapabilities(supplier: PromoStandardsSupplier): Capability[] {
  const probe = new PromoStandardsClient(supplier, { id: "", password: "" });
  return (Object.entries(CAPABILITY_OF) as [PromoStandardsService, readonly Capability[]][]).filter(([s]) => probe.has(s)).flatMap(([, c]) => c);
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
