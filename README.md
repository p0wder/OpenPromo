# OpenPromo

A free, open-source REST API for promotional-product and apparel suppliers that you host yourself. One set of paths and one set of answers for every supplier: SanMar, S&S Activewear, and any supplier that runs PromoStandards web services. Run it on your own accounts, pay nobody per call, and read the code that talks to your suppliers.

Suppliers publish their catalog, stock, pricing, order status, tracking and invoices as web services: mostly SOAP, to the [PromoStandards](https://promostandards.org) schemas, and some as their own REST APIs. OpenPromo turns them all into the same plain JSON over HTTPS. It is also a TypeScript library, so an app can call suppliers directly with no server in between.

- **One API for every supplier.** `GET /v1/{supplier}/products/{id}/inventory` answers in the same shape for SanMar, S&S or Acme Promo. What only one supplier does (placing a SanMar order, S&S's catalog) is that supplier's own route, listed at `GET /v1/suppliers/{supplier}`.
- **A pass-through for any account.** Each request brings the supplier login it should use, in headers, and OpenPromo keeps none of it: no database and no logging of headers. One install can serve any number of accounts. To self-host for a single account, you can instead set that login as a default in env vars.
- **It asks only when you ask.** There's no polling and no background jobs. Every call is one request to the supplier, made when you make it.
- **Adding a supplier is data, not code**, for any PromoStandards supplier (see [Adding a supplier](#adding-a-supplier)).

## Suppliers

| Supplier | id | How | Login headers |
| --- | --- | --- | --- |
| SanMar | `sanmar` | Its PromoStandards services, plus its own SOAP services (Product Info, Pricing with your `myPrice`, the PO service) | `X-SanMar-Customer-Number`, `X-SanMar-Username`, `X-SanMar-Password` |
| S&S Activewear | `ssactivewear` | Its REST API v2 | `X-Supplier-Id` (account number), `X-Supplier-Password` (API key) |
| Every supplier in the [directory](#the-directory) | from the company name (`alpha-broder`) | PromoStandards | `X-Supplier-Id`, `X-Supplier-Password` (your PromoStandards login for that supplier) |

`GET /v1/suppliers` lists every supplier the server serves (`?search=`, `?capability=inventory`, `?kind=native|promostandards`). `GET /v1/suppliers/{id}` says exactly which headers it takes, its environments and its own routes.

## The shared API

| Question | REST | Answer |
| --- | --- | --- |
| A product, with its parts (colors and sizes) | `GET /v1/{supplier}/products/{id}` | `Product` |
| Stock per part and warehouse | `GET /v1/{supplier}/products/{id}/inventory[?partId=…]` | `Inventory` |
| Prices per part, with quantity breaks | `GET /v1/{supplier}/products/{id}/pricing?priceType=Net\|List\|Customer` | `Pricing` |
| Where the orders under a PO stand | `GET /v1/{supplier}/orders/{po}` | `{ purchaseOrderNumber, orders: SalesOrder[] }` |
| Packages and tracking | `GET /v1/{supplier}/orders/{po}/shipments` | `{ purchaseOrderNumber, shipments: Shipment[] }` |
| Invoices | `GET /v1/{supplier}/invoices?po=…` (or `invoice=`, `date=`, `since=`) | `{ invoices: Invoice[] }` |

A supplier that can't answer a question says so (`404 not_offered`) before asking for a login. The full API, every supplier's own routes included, is at `GET /openapi.json` (OpenAPI 3.1). Money is in cents. The shapes are the TypeScript types the package exports. Errors look like this:

```json
{ "error": { "kind": "not_enabled", "message": "…", "supplier": "sanmar", "code": "104", "detail": "This account is unauthorized to use this service." } }
```

| `kind` | HTTP | Meaning |
| --- | --- | --- |
| `invalid` | 400 | The request can't be sent as it stands. Nothing reached the supplier. |
| `unauthorized` | 401 | Missing or wrong OpenPromo API key. |
| `orders_off` | 403 | Placing orders is switched off on this server. |
| `unknown_supplier` / `not_offered` / `unknown_route` | 404 | No such supplier on this server, it doesn't answer that question, or no such path. |
| `not_found` / `not_yet` | 404 | The supplier has no such item, or it hasn't shipped or been invoiced yet. |
| `duplicate` | 409 | The supplier already has a live order under that PO number. Nothing was sent. |
| `auth` / `not_enabled` / `refused` | 424 | The supplier turned down your login, hasn't switched the service on, or refused the request. |
| `rate_limited` | 429 | Too many requests to the supplier. |
| `bad_response` / `unreachable` | 502 / 504 | The supplier's answer couldn't be read, or it didn't answer. |

### Each supplier's own routes

| Route | What |
| --- | --- |
| `GET /v1/sanmar/native/product-info/{style}` | SanMar Product Info: colors, images, inventory keys, standard prices |
| `GET /v1/sanmar/native/pricing/{style}` | SanMar's Pricing service, with `myPrice` (your account's own price) |
| `POST /v1/sanmar/orders/preview` | Check a SanMar order without placing it (`getPreSubmitInfo`) |
| `POST /v1/sanmar/orders` | Place a SanMar order (`submitPO`) |
| `GET /v1/ssactivewear/native/styles[?search=&limit=]` | S&S's styles catalog (S&S asks for it once a day, not per search) |
| `GET /v1/ssactivewear/native/products/{styleId}` | S&S's own products answer: every SKU, its field names, dollars |
| `POST /v1/ssactivewear/orders` | Place an S&S order |

Placing orders is off unless `OPENPROMO_ORDERS=on`.

## Run it

All the server needs is a long random API key (`openssl rand -hex 32`) in `OPENPROMO_API_KEY`. Supplier logins come with each request.

**Vercel.** Fork this repo and import it as a new Vercel project. Set `OPENPROMO_API_KEY` and deploy. Until it's set, every request answers 503 saying what's missing. No supplier here needs a static IP.

**Docker:**

```bash
docker build -t openpromo .
docker run --env-file .env -p 8787:8787 openpromo
```

**Node 20+:**

```bash
pnpm install && pnpm build
node --env-file=.env dist/server/node.js
```

Then try it:

```bash
curl http://localhost:8787/v1/ssactivewear/products/39/inventory \
  -H "Authorization: Bearer $OPENPROMO_API_KEY" \
  -H "X-Supplier-Id: 123456" -H "X-Supplier-Password: your-s-and-s-api-key"
```

## Sending a login

Every `/v1` call needs the server's API key, plus the login of the account it is for, in the headers `GET /v1/suppliers/{id}` names. The server uses the login for that one request and keeps nothing. It never logs these headers. Only send them over HTTPS. A request without a login uses the server's default login for that supplier if one is set in env vars; otherwise it answers 400 and names the headers to send.

`X-Supplier-Environment: test` (for SanMar, `X-SanMar-Environment: edev`) uses the supplier's test environment, where it has one.

## Configuration

| Variable | Required | What it does |
| --- | --- | --- |
| `OPENPROMO_API_KEY` | Yes | At least 24 characters. Callers send it as `Authorization: Bearer <key>`. Comma-separate several keys to rotate one. |
| `{SUPPLIER}_{FIELD}` | | An optional default login, for requests that send none (self-hosting for one account). The supplier id upper-cased, dashes as underscores, then the field: `SANMAR_CUSTOMER_NUMBER`, `SANMAR_USERNAME`, `SANMAR_PASSWORD`; `SSACTIVEWEAR_ACCOUNT_NUMBER`, `SSACTIVEWEAR_API_KEY`; `ALPHA_BRODER_ID`, `ALPHA_BRODER_PASSWORD`. Set all of a supplier's fields or none. |
| `{SUPPLIER}_ENVIRONMENT` | | That supplier's default environment: `production`, or its test environment (`edev` for SanMar, `test` for PromoStandards suppliers that list test URLs). |
| `SANMAR_WAREHOUSE_SELECTION` | | The default for `X-SanMar-Warehouse-Selection`: `on` only if SanMar set the account up for Warehouse Selection. |
| `OPENPROMO_ORDERS` | | `on` lets the order routes place real orders. It's off by default. |
| `OPENPROMO_ENABLED_SUPPLIERS` | | Comma-separated ids: serve only these (default: every supplier). |
| `OPENPROMO_SUPPLIERS` | | Your own PromoStandards suppliers, as JSON (see below). |
| `PORT`, `HOST` | | For the Node server. Defaults are `8787` and `0.0.0.0`. |

## Adding a supplier

There are three ways, from least to most work.

**1. It's in the directory.** Nothing to do: it's served at `/v1/{id}`.

**2. A PromoStandards supplier the directory doesn't have, or has wrong.** Add it to `src/directory/overrides.ts` (`add`, `patch` or `skip`, each with why) and send a pull request, or, for your server only, set `OPENPROMO_SUPPLIERS`:

```json
[
  {
    "id": "acme",
    "name": "Acme Promo",
    "endpoints": {
      "inventory": { "version": "2.0.0", "url": "https://ps.acme.example/inventory/v2" },
      "orderStatus": { "version": "2.0.0", "url": "https://ps.acme.example/orderstatus", "testUrl": "https://test.acme.example/orderstatus" }
    }
  }
]
```

Services and versions OpenPromo talks (the `endpoints` key, then the versions):

| Service | `endpoints` key | Versions |
| --- | --- | --- |
| Product Data | `productData` | 2.0.0 |
| Inventory | `inventory` | 2.0.0 |
| Pricing and Configuration | `pricing` | 1.0.0 |
| Order Status | `orderStatus` | 1.0.0, 2.0.0 |
| Order Shipment Notification | `shipments` | 1.0.0, 2.0.0 (2.0.0 also gives each package's ship-from and ship-to addresses, weight, dimensions and freight terms) |
| Invoice | `invoices` | 1.0.0 |

A config with a version it can't talk or a URL that isn't `https` is refused at start.

**3. A supplier with its own API.** Write a driver (`src/suppliers/driver.ts` is the whole contract) and add it to `NATIVE_DRIVERS` in `src/suppliers/registry.ts`. A driver says:

- its `id`, `name`, and which shared questions it answers (`capabilities`);
- its login fields and the header each comes in (`X-Supplier-Id` and `X-Supplier-Password` if it has an id and a secret);
- its environments, production first;
- `connect(login)`: a connection whose methods answer in the shared shapes;
- optionally, its own `routes` (`write: true` for anything that places something real).

The handler, the supplier list, the docs and the default-login env vars all come from that. `src/ssactivewear/` is a complete example: a client, pure functions from the supplier's JSON to the shared shapes (tested without a network), orders, and the driver.

## The directory

`src/directory/data.ts` is generated from PromoStandards' own endpoint directory (its Web Service Repository) by `pnpm directory:sync`. The last sync (2026-11-23) found 558 suppliers with 1,490 endpoints OpenPromo can talk, out of 1,040 suppliers listed. SanMar's listing gives exactly the endpoints its driver uses. For each supplier it keeps, per service, the highest version OpenPromo talks, with its test URL when one is listed. It prints everything it leaves out and why (a version OpenPromo doesn't talk, a URL that isn't https, a service listed inactive). The most common versions it can't use yet are Product Data 1.0.0 (479 endpoints) and Inventory 1.2.1 (132): supporting those is how most listed suppliers would gain stock and product data. A GitHub workflow runs it weekly and opens a pull request when anything changed. Hand fixes go in `src/directory/overrides.ts`, never in the generated file. A supplier with its own driver is never served from the directory.

## Use it as a library

```ts
import { SanmarClient, SsActivewearClient, ssActivewearConnection, supplierDrivers } from "openpromo";

const sanmar = new SanmarClient({ customerNumber: "…", username: "…", password: "…" });
const prices = await sanmar.pricing("PC54"); // includes myPrice, your account's own price

const ss = ssActivewearConnection(new SsActivewearClient({ accountNumber: "…", apiKey: "…" }));
const stock = await ss.inventory("39", {}); // the shared Inventory shape

// Any supplier by id, the same way the server does it:
const acme = supplierDrivers().find((d) => d.id === "acme")!.connect({ id: "…", password: "…" }, { environment: "production" });
```

Every client takes the login it should use and keeps no state, so one process can serve many accounts. Pass `fetch` to supply your own transport, for tests or a proxy. Everything throws `OpenPromoError` with a `kind`, as in the table above.

## Placing orders

Both order routes check the order before sending (anything over the supplier's limits, a bad ZIP or an unknown ship method comes back `invalid`, with nothing placed), merge identical lines, and say every change they made in `changes`. Both first ask the supplier for live orders under the PO number and refuse with 409 if there are any. A send the supplier didn't answer (`unreachable` or `bad_response`) may still have gone through: look the PO up before sending again.

**SanMar** (`POST /v1/sanmar/orders`):

```json
{
  "poNumber": "1042-1",
  "shipTo": { "company": "Acme", "attention": "Pat", "address1": "12 Main ST", "city": "Austin", "state": "TX", "zip": "78701", "email": "pat@example.com" },
  "residential": false,
  "shipMethod": "UPS",
  "lines": [{ "style": "PC54", "color": "Jet Black", "size": "L", "quantity": 12 }]
}
```

It removes commas from every field (SanMar's file delimiter), refuses fields over SanMar's limits (PO 28, company 28, address 35, city 28, email 105), cuts notes to 100 characters, and sends a warehouse only on Warehouse Selection accounts. SanMar wants each account to certify ordering on EDEV first: a multi-line test order to a real address, which SanMar reviews, before turning on production PO integration.

**S&S Activewear** (`POST /v1/ssactivewear/orders`):

```json
{
  "poNumber": "1042-1",
  "shipTo": { "company": "Acme", "attention": "Pat", "address1": "12 Main St", "address2": "Suite 4", "city": "Austin", "state": "TX", "zip": "78701", "email": "pat@example.com" },
  "shipMethod": "1",
  "lines": [{ "sku": "B00760004", "quantity": 12, "warehouse": "IL" }]
}
```

Lines are S&S SKUs (the `partId`s of `GET /v1/ssactivewear/products/{styleId}`). Ship methods are S&S's codes (1 Ground, the default; 16 3 Day Select; 3 2nd Day Air; 2 Next Day Air; 6 Will call). S&S may split one PO across warehouses: each S&S order comes back in `orders`.

## Be gentle with suppliers

- **Order status and shipments:** a few calls a day per PO at most (SanMar asks for three, and none in the first two hours after placing it).
- **Invoices:** after 3 p.m. Pacific, a day after shipping (SanMar).
- **Prices:** these change rarely, so cache them.
- **Whole catalog:** use the supplier's bulk files (SanMar's EPDD and `sanmar_dip.txt`) or S&S's styles list once a day, not per-style calls.

OpenPromo never polls. What you call is what the supplier sees.

## What hasn't been checked against a live account

Every shape comes from the suppliers' published guides, and S&S's catalog calls are the ones Inkline runs in production. These haven't been called with a real login yet. Run each once against your account and report anything that differs:

- **SanMar's wording for a disabled service.** The "not enabled" message for SanMar's own services isn't documented. OpenPromo reads anything mentioning "not enabled / not authorized" as `not_enabled`.
- **S&S's order fields.** Status words, tracking, invoice and line fields on `/v2/orders/{po}?lines=true`, the order post's answer, and the invoiced-between-dates parameters are named as we read S&S's docs.
- **S&S style lookups by name.** `/v2/styles/{identifier}` with a part number or "Brand Style" (numeric style ids are proven).

## Changes

**0.2.0.** One API for every supplier. S&S Activewear. The supplier directory and registry. `GET /v1/sanmar/products/{style}` now answers the shared `Product` (from SanMar's PromoStandards Product Data); SanMar's Product Info moved to `/v1/sanmar/native/product-info/{style}`, and `pricing` without `priceType` to `/v1/sanmar/native/pricing/{style}`. `/health` reports a count of suppliers, not their ids.

## License

MIT
