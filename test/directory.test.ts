import { describe, expect, it } from "vitest";
import { checkSupplierConfig, DIRECTORY, NATIVE_DRIVERS, SANMAR_PROMOSTANDARDS, supplierDrivers } from "../src/index.js";
import { fixture } from "./helpers.js";
import { listingsFromRepository, readCompanies, readEndpoints, renderDirectoryData, serviceKey, supplierId } from "../src/directory/sync.js";
import { DIRECTORY_OVERRIDES } from "../src/directory/overrides.js";

describe("the directory as shipped", () => {
  it("every entry is a usable PromoStandards supplier with a unique id that no written driver has", () => {
    const native = new Set(NATIVE_DRIVERS.map((d) => d.id));
    const seen = new Set<string>();
    for (const entry of DIRECTORY) {
      expect(checkSupplierConfig(entry), entry.id).toEqual([]);
      expect(seen.has(entry.id), `${entry.id} twice`).toBe(false);
      seen.add(entry.id);
    }
    expect(() => supplierDrivers()).not.toThrow();
    expect(supplierDrivers().filter((d) => native.has(d.id)).every((d) => d.kind === "native")).toBe(true);
  });

  it("is synced: hundreds of suppliers, and the ones that have their own driver aren't served twice", () => {
    expect(DIRECTORY.length).toBeGreaterThan(400);
    const ids = new Set(DIRECTORY.map((d) => d.id));
    expect(ids.has("s-and-s-activewear")).toBe(false);
    expect(supplierDrivers().find((d) => d.id === "sanmar")!.kind).toBe("native");
    expect(supplierDrivers().filter((d) => d.id === "sanmar")).toHaveLength(1);
  });

  it("every hand-kept skip says why", () => {
    for (const [id, why] of Object.entries(DIRECTORY_OVERRIDES.skip)) expect(why.trim().length, id).toBeGreaterThan(5);
  });
});

describe("syncing from PromoStandards' repository", () => {
  it("reads service names long and short", () => {
    expect(["Product Data", "PDS", "Inventory", "INV", "Product Pricing and Configuration", "PPC", "Order Status", "ODRSTAT", "Order Shipment Notification", "OSN", "Invoice", "INVC", "Media Content", "Purchase Order"].map(serviceKey)).toEqual([
      "productData",
      "productData",
      "inventory",
      "inventory",
      "pricing",
      "pricing",
      "orderStatus",
      "orderStatus",
      "shipments",
      "shipments",
      "invoices",
      "invoices",
      null,
      null,
    ]);
  });

  it("makes ids from company names", () => {
    expect(["Alpha Broder, LLC", "Hit Promotional Products, Inc.", "Bic Graphic USA", "S&S Activewear", "PCNA (Leed's, Bullet, Trimark)", "Tom\u2019s Caps"].map(supplierId)).toEqual(["alpha-broder", "hit-promotional-products", "bic-graphic-usa", "s-and-s-activewear", "pcna-leeds-bullet-trimark", "toms-caps"]);
  });

  it("reads the repository's endpoints as it answers them: nested service, both URLs on one entry, ?wsdl dropped", () => {
    const sanmar = readEndpoints(JSON.parse(fixture("promostandards-repository/sanmar-endpoints.json")));
    expect(sanmar).toContainEqual({ service: "Product", version: "2.0.0", url: "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2", testUrl: "https://edev-ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2", status: "Production" });
    expect(readEndpoints({ success: false, message: "Invalid company code" })).toEqual([]);
    expect(readCompanies([{ Code: "ACME", Name: "Acme Promo", Type: "Supplier" }, { code: "X" }])).toEqual([{ code: "ACME", name: "Acme Promo", type: "Supplier" }]);
  });

  it("SanMar's own listing gives exactly the endpoints OpenPromo's SanMar driver uses", () => {
    const { listings } = listingsFromRepository([{ code: "SanMar", name: "SanMar", type: "Supplier" }], new Map([["SanMar", readEndpoints(JSON.parse(fixture("promostandards-repository/sanmar-endpoints.json")))]]));
    expect(listings[0]!.endpoints).toEqual(SANMAR_PROMOSTANDARDS.endpoints);
  });

  it("keeps the highest version OpenPromo talks, live suppliers only; reports everything it leaves out", () => {
    const companies = [
      { code: "ACME", name: "Acme Promo, Inc.", type: "Supplier" },
      { code: "OLD", name: "Old Co", type: "Supplier" },
      { code: "DIST", name: "Some Distributor", type: "Distributor" },
      { code: "SP", name: "Some Service Provider", type: "Service Provider" },
    ];
    const ep = (service: string, version: string, url: string, extra: Partial<{ testUrl: string; status: string }> = {}) => ({ service, version, url, testUrl: "", status: "Production", ...extra });
    const endpoints = new Map([
      [
        "ACME",
        [
          ep("ODRSTAT", "1.0.0", "https://acme.example/os1"),
          ep("ODRSTAT", "2.0.0", "https://acme.example/os2", { testUrl: "https://test.acme.example/os2" }),
          ep("INV", "1.2.1", "https://acme.example/inv"),
          ep("INVC", "1.0.0", "http://acme.example/invc"),
          ep("MED", "1.1.0", "https://acme.example/media"),
        ],
      ],
      ["OLD", [ep("INV", "2.0.0", "https://old.example/inv", { status: "In Review" })]],
      ["SP", [ep("INV", "2.0.0", "https://sp.example/inv")]],
    ]);
    const { listings, skipped } = listingsFromRepository(companies, endpoints);
    expect(listings).toEqual([{ id: "acme-promo", name: "Acme Promo, Inc.", code: "ACME", endpoints: { orderStatus: { version: "2.0.0", url: "https://acme.example/os2", testUrl: "https://test.acme.example/os2" } } }]);
    expect(skipped).toEqual([
      "Acme Promo, Inc.: INV 1.2.1: OpenPromo talks 2.0.0",
      "Acme Promo, Inc.: INVC 1.0.0: URL isn't https (http://acme.example/invc)",
      "Old Co: INV 2.0.0: listed as In Review",
      "Old Co (OLD): no service OpenPromo can talk",
    ]);
    expect(renderDirectoryData(listings, "2026-11-23")).toContain('{"id":"acme-promo","name":"Acme Promo, Inc.","code":"ACME","endpoints":{"orderStatus":{"version":"2.0.0","url":"https://acme.example/os2","testUrl":"https://test.acme.example/os2"}}},');
  });

  it("a supplier listing OSN 1.0.0, 2.0.0 and 2.1.0 ends up on 2.1.0, whatever order they're listed in", () => {
    const ep = (version: string, url: string, testUrl = "") => ({ service: "OSN", version, url, testUrl, status: "Production" });
    const endpoints = new Map([["MULTI", [ep("2.1.0", "https://multi.example/osn21", "https://test.multi.example/osn21"), ep("1.0.0", "https://multi.example/osn1"), ep("2.0.0", "https://multi.example/osn2")]]]);
    const { listings, skipped } = listingsFromRepository([{ code: "MULTI", name: "Multi Version Co", type: "Supplier" }], endpoints);
    expect(listings).toEqual([{ id: "multi-version", name: "Multi Version Co", code: "MULTI", endpoints: { shipments: { version: "2.1.0", url: "https://multi.example/osn21", testUrl: "https://test.multi.example/osn21" } } }]);
    expect(skipped).toEqual([]);
    expect(checkSupplierConfig({ id: listings[0]!.id, name: listings[0]!.name, endpoints: listings[0]!.endpoints })).toEqual([]);
  });

  it("two companies with the same name keep their codes apart", () => {
    const ep = [{ service: "INV", version: "2.0.0", url: "https://x.example/inv", testUrl: "", status: "Production" }];
    const { listings } = listingsFromRepository(
      [
        { code: "A1", name: "Acme", type: "Supplier" },
        { code: "A2", name: "Acme Inc", type: "Supplier" },
      ],
      new Map([["A1", ep], ["A2", ep]]),
    );
    expect(listings.map((l) => l.id)).toEqual(["acme-a1", "acme-a2"]);
    // The same company listed twice under one code is one supplier.
    const twice = listingsFromRepository([{ code: "MG", name: "Magnet Guys", type: "Supplier" }, { code: "MG", name: "Magnet Guys", type: "Supplier" }], new Map([["MG", ep]]));
    expect(twice.listings.map((l) => l.id)).toEqual(["magnet-guys"]);
  });
});
