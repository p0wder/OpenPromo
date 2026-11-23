import { describe, expect, it } from "vitest";
import { buildSanmarOrder, OpenPromoError, SanmarClient, type SanmarOrder } from "../src/index.js";
import { elementsOf, fakeSoap, fixture } from "./helpers.js";

const login = { customerNumber: "188646", username: "webuser", password: "pw" };
const sanmar = (routes: Parameters<typeof fakeSoap>[0], environment: "production" | "edev" = "production") => {
  const fake = fakeSoap(routes);
  return { client: new SanmarClient(login, { fetch: fake.fetch, environment }), calls: fake.calls };
};

const order = (over: Partial<SanmarOrder> = {}): SanmarOrder => ({
  poNumber: "1042-1",
  shipTo: { company: "Acme, Inc.", attention: "Pat", address1: "12 Main ST", city: "Austin", state: "tx", zip: "78701", email: "pat@example.com" },
  residential: false,
  shipMethod: "UPS",
  lines: [
    { style: "pc54", color: "Jet Black", size: "L", quantity: 12 },
    { style: "PC54", color: "jet black", size: "l", quantity: 6 },
    { style: "PC54", color: "Jet Black", size: "2XL", quantity: 6 },
  ],
  ...over,
});

describe("Product Info", () => {
  it("asks the impl namespace with SanMar's login block and reads every color and size with standard prices", async () => {
    const { client, calls } = sanmar({ getProductInfoByStyleColorSize: fixture("sanmar/product-info.xml") });
    const p = await client.productInfo("pc61");
    const xml = calls[0]!.xml;
    expect(calls[0]!.url).toBe("https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort");
    expect(xml).toContain('xmlns:impl="http://impl.webservice.integration.sanmar.com/"');
    expect(xml).toContain("<impl:getProductInfoByStyleColorSize><arg0><style>PC61</style><color></color><size></size></arg0>");
    expect(xml).toContain("<arg1><sanMarCustomerNumber>188646</sanMarCustomerNumber><sanMarUserName>webuser</sanMarUserName><sanMarUserPassword>pw</sanMarUserPassword></arg1>");
    expect(p).toMatchObject({ style: "PC61", title: "Port & Co - Essential Tee. PC61", brand: "Port & Co", category: "T-Shirts", status: "Active" });
    expect(p!.colors.map((c) => [c.name, c.catalogColor, c.sizes.map((s) => [s.size, s.uniqueKey, s.inventoryKey, s.sizeIndex, s.piecePrice, s.casePrice])])).toEqual([
      ["White", "White", [["S", "118032", "11803", "2", 384, 284]]],
      ["Athletic Heather", "Athletic Hthr", [["2XL", "118056", "11805", "6", 584, 484]]],
    ]);
    expect(p!.colors[0]!.sizes[0]).toMatchObject({ pieceSalePrice: 238, caseSalePrice: 238, saleStartDate: "2023-05-01", saleEndDate: "2023-05-06", mapPrice: 238, caseSize: 72 });
    expect(p!.colors[0]!.images).toMatchObject({ product: expect.stringContaining("PC61_white_model_front"), frontFlat: expect.stringContaining("Flat_Front"), backModel: expect.stringContaining("model_back") });
  });

  it("an unknown style is null; a refused login is auth", async () => {
    expect(await sanmar({ getProductInfoByStyleColorSize: fixture("sanmar/product-info-invalid.xml") }).client.productInfo("NOPE")).toBeNull();
    await expect(sanmar({ getProductInfoByStyleColorSize: fixture("sanmar/product-info-auth.xml") }).client.productInfo("PC54")).rejects.toMatchObject({ kind: "auth", detail: "ERROR: User authenticating failed" });
  });
});

describe("Pricing", () => {
  it("reads salePrice and myPrice (the account's own) from getPricing", async () => {
    const { client, calls } = sanmar({ getPricing: fixture("sanmar/pricing.xml") });
    const rows = await client.pricing("lpc61");
    expect(calls[0]!.url).toBe("https://ws.sanmar.com:8080/SanMarWebService/SanMarPricingServicePort");
    expect(rows).toEqual([{ style: "lpc61", color: "lime", size: "m", inventoryKey: "46389", sizeIndex: "3", piecePrice: 359, casePrice: 259, salePrice: 199, myPrice: 176, incentivePrice: 176, saleStartDate: "2017-06-26", saleEndDate: "2017-07-02" }]);
  });
});

describe("building a PO", () => {
  it("removes commas, merges identical lines, upper-cases the state and leaves whseNo out by default", () => {
    const built = buildSanmarOrder(order({ lines: [...order().lines.slice(0, 2).map((l) => ({ ...l, warehouse: "4" })), order().lines[2]!] }));
    expect(built.request).toMatchObject({ poNum: "1042-1", shipTo: "Acme Inc.", shipState: "TX", shipZip: "78701", shipMethod: "UPS", residence: "N" });
    expect(built.request.webServicePoDetailList).toEqual([
      { style: "PC54", color: "Jet Black", size: "L", quantity: 18 },
      { style: "PC54", color: "Jet Black", size: "2XL", quantity: 6 },
    ]);
    expect(built.lines.map((l) => l.sources)).toEqual([[0, 1], [2]]);
    expect(built.changes).toEqual(["Removed commas from the ship-to company (SanMar can't take them).", "Combined identical lines into one (3 lines sent as 2)."]);
  });

  it("sends whseNo and allows will call only on Warehouse Selection accounts", () => {
    const lines = [{ style: "PC54", color: "Jet Black", size: "L", quantity: 1, warehouse: "4" }];
    expect(buildSanmarOrder(order({ lines, shipMethod: "REN" }), { warehouseSelection: true }).request.webServicePoDetailList).toEqual([{ style: "PC54", color: "Jet Black", size: "L", quantity: 1, whseNo: "4" }]);
    expect(() => buildSanmarOrder(order({ lines, shipMethod: "REN" }))).toThrow(/Will call \(REN\) needs the SanMar account set up for Warehouse Selection/);
  });

  it("refuses what SanMar can't take, every problem at once, before sending", () => {
    let err: OpenPromoError | undefined;
    try {
      buildSanmarOrder(order({ poNumber: "X".repeat(30), shipMethod: "USPS", shipTo: { address1: "1 Very Long Street Name That Goes On And On", city: "Austin", state: "Texas", zip: "787" }, lines: [{ style: "PC54", quantity: 0 }] }));
    } catch (e) {
      err = e as OpenPromoError;
    }
    expect(err).toMatchObject({ kind: "invalid" });
    expect(err!.detail).toBe(
      [
        "The PO number is 30 characters; SanMar takes 28.",
        "The ship-to address is 43 characters; SanMar takes 35.",
        'The ship-to state must be a two-letter code (got "Texas").',
        'The ship-to ZIP must be 5 digits or ZIP+4 (got "787").',
        'SanMar has no ship method "USPS". Use one of: UPS, UPS 2ND DAY, UPS 2ND DAY AM, UPS 3RD DAY, UPS NEXT DAY, UPS NEXT DAY EA, UPS NEXT DAY SV, UPS SATURDAY, USPS PP, USPS APP, PSST, TRUCK.',
        "Line 1 needs a style, color and size (or SanMar's inventory key and size index).",
        "Line 1's quantity must be a whole number from 1 to 999999.",
      ].join(" "),
    );
  });

  it("cuts notes to SanMar's 100 characters, and takes inventory key + size index lines", () => {
    const built = buildSanmarOrder(order({ notes: "n".repeat(150), lines: [{ inventoryKey: 20828, sizeIndex: 5, quantity: 2 }] }));
    expect((built.request.notes as string).length).toBe(100);
    expect(built.changes).toContain("Cut the notes to 100 characters (SanMar's limit).");
    expect(built.request.webServicePoDetailList).toEqual([{ inventoryKey: "20828", sizeIndex: "5", quantity: 2 }]);
  });
});

describe("the PO service", () => {
  it("pre-submit uses the webservice namespace (not impl) and reads lines from return.response", async () => {
    const { client, calls } = sanmar({ getPreSubmitInfo: fixture("sanmar/presubmit-ok.xml") });
    const check = await client.preSubmitOrder(order({ lines: [{ style: "K500", color: "white", size: "m", quantity: 5 }] }));
    expect(calls[0]!.url).toBe("https://ws.sanmar.com:8080/SanMarWebService/SanMarPOServicePort");
    expect(calls[0]!.xml).toContain('xmlns:web="http://webservice.integration.sanmar.com/"');
    expect(calls[0]!.xml).toContain("<web:getPreSubmitInfo><arg0>");
    expect(check).toMatchObject({ ok: true, lines: [{ style: "K500", status: "ok", shipsFrom: { id: "1", name: "Seattle, WA" }, inventoryKey: "20860", sizeIndex: "3", sources: [0] }] });
  });

  it("pre-submit marks a line short when SanMar has no stock, instead of failing the order", async () => {
    const { client } = sanmar({ getPreSubmitInfo: fixture("sanmar/presubmit-short.xml") });
    const check = await client.preSubmitOrder(order({ lines: [{ style: "K420", color: "Black", size: "S", quantity: 900 }] }));
    expect(check.ok).toBe(false);
    expect(check.lines).toEqual([expect.objectContaining({ style: "K420", status: "short", message: "Requested Quantity is not in stock from any warehouse or from requested warehouse" })]);
    expect(check.lines[0]!.shipsFrom).toBeUndefined();
  });

  it("submits, and reads SanMar's 'Error: …' as refused (nothing placed)", async () => {
    const ok = sanmar({ submitPO: fixture("sanmar/submit-ok.xml") });
    expect(await ok.client.submitOrder(order())).toEqual({ accepted: true, message: "PO Submission successful", poNumber: "1042-1", changes: expect.any(Array) });
    expect(elementsOf(ok.calls[0]!.xml, "quantity")).toEqual(["18", "6"]);
    await expect(sanmar({ submitPO: fixture("sanmar/submit-error.xml") }).client.submitOrder(order())).rejects.toMatchObject({ kind: "refused", detail: "Ship to state is invalid" });
  });

  it("no answer or a gateway error on submit is unreachable (it may have gone through); a bad order sends nothing", async () => {
    await expect(sanmar({ submitPO: new Error("socket hang up") }).client.submitOrder(order())).rejects.toMatchObject({ kind: "unreachable" });
    await expect(sanmar({ submitPO: { status: 504, body: "" } }).client.submitOrder(order())).rejects.toMatchObject({ kind: "unreachable" });
    const bad = sanmar({ submitPO: fixture("sanmar/submit-ok.xml") });
    await expect(bad.client.submitOrder(order({ lines: [] }))).rejects.toMatchObject({ kind: "invalid" });
    expect(bad.calls).toHaveLength(0);
  });

  it("EDEV sends everything to edev-ws, PromoStandards included", async () => {
    const { client, calls } = sanmar({ getPricing: fixture("sanmar/pricing.xml"), GetInventoryLevelsRequest: fixture("promostandards/inventory-2.0.0.xml") }, "edev");
    await client.pricing("PC54");
    await client.promoStandards().getInventory("K420");
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["edev-ws.sanmar.com:8080", "edev-ws.sanmar.com:8080"]);
    // PromoStandards logs in with the sanmar.com user alone.
    expect(calls[1]!.xml).toContain("<shar:id>webuser</shar:id><shar:password>pw</shar:password>");
    expect(calls[1]!.xml).not.toContain("188646");
  });
});
