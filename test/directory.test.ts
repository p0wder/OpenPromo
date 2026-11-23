import { describe, expect, it } from "vitest";
import { checkSupplierConfig, DIRECTORY, NATIVE_DRIVERS, supplierDrivers } from "../src/index.js";
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
    expect(["Alpha Broder, LLC", "Hit Promotional Products, Inc.", "Bic Graphic USA", "S&S Activewear"].map(supplierId)).toEqual(["alpha-broder", "hit-promotional-products", "bic-graphic-usa", "s-and-s-activewear"]);
  });

  it("reads the repository's JSON loosely: either case, nested or flat services", () => {
    expect(readCompanies([{ Code: "ACME", Name: "Acme Promo", Type: "Supplier" }, { code: "X" }])).toEqual([{ code: "ACME", name: "Acme Promo", type: "Supplier" }]);
    expect(readEndpoints([{ Service: { Name: "Inventory", Version: "2.0.0" }, URL: "https://a/inv", Environment: "PROD", Status: "Active" }, { ServiceName: "OSN", Version: "1.0.0", url: "https://a/osn" }])).toEqual([
      { service: "Inventory", version: "2.0.0", url: "https://a/inv", environment: "PROD", status: "Active" },
      { service: "OSN", version: "1.0.0", url: "https://a/osn", environment: "", status: "" },
    ]);
  });

  it("keeps the highest version OpenPromo talks, with its test URL; reports everything it leaves out", () => {
    const companies = [
      { code: "ACME", name: "Acme Promo, Inc.", type: "Supplier" },
      { code: "OLD", name: "Old Co", type: "Supplier" },
      { code: "DIST", name: "Some Distributor", type: "Distributor" },
    ];
    const endpoints = new Map([
      [
        "ACME",
        [
          { service: "Order Status", version: "1.0.0", url: "https://acme.example/os1", environment: "PROD", status: "Active" },
          { service: "Order Status", version: "2.0.0", url: "https://acme.example/os2", environment: "PROD", status: "Active" },
          { service: "Order Status", version: "2.0.0", url: "https://test.acme.example/os2", environment: "TEST", status: "Active" },
          { service: "Inventory", version: "1.2.1", url: "https://acme.example/inv", environment: "PROD", status: "Active" },
          { service: "Invoice", version: "1.0.0", url: "http://acme.example/inv", environment: "PROD", status: "Active" },
          { service: "Media Content", version: "1.1.0", url: "https://acme.example/media", environment: "PROD", status: "Active" },
        ],
      ],
      ["OLD", [{ service: "Inventory", version: "2.0.0", url: "https://old.example/inv", environment: "PROD", status: "Inactive" }]],
    ]);
    const { listings, skipped } = listingsFromRepository(companies, endpoints);
    expect(listings).toEqual([{ id: "acme-promo", name: "Acme Promo, Inc.", code: "ACME", endpoints: { orderStatus: { version: "2.0.0", url: "https://acme.example/os2", testUrl: "https://test.acme.example/os2" } } }]);
    expect(skipped).toEqual([
      "Acme Promo, Inc.: Inventory 1.2.1: OpenPromo talks 2.0.0",
      "Acme Promo, Inc.: Invoice 1.0.0: URL isn't https (http://acme.example/inv)",
      "Old Co: Inventory 2.0.0: listed as Inactive",
      "Old Co (OLD): no service OpenPromo can talk",
    ]);
    // What it writes is valid TypeScript data the directory reads back.
    expect(renderDirectoryData(listings, "2026-11-23")).toContain('{"id":"acme-promo","name":"Acme Promo, Inc.","code":"ACME","endpoints":{"orderStatus":{"version":"2.0.0","url":"https://acme.example/os2","testUrl":"https://test.acme.example/os2"}}},');
  });

  it("two companies with the same name keep their codes apart", () => {
    const ep = [{ service: "Inventory", version: "2.0.0", url: "https://x.example/inv", environment: "PROD", status: "" }];
    const { listings } = listingsFromRepository(
      [
        { code: "A1", name: "Acme", type: "Supplier" },
        { code: "A2", name: "Acme Inc", type: "Supplier" },
      ],
      new Map([["A1", ep], ["A2", ep]]),
    );
    expect(listings.map((l) => l.id)).toEqual(["acme-a1", "acme-a2"]);
  });
});
