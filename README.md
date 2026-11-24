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

`GET /v1/suppliers` lists every supplier the server serves (`?search=`, `?capability=inventory`, `?capability=productList`, `?capability=orders` for those that can take orders, `?kind=native|promostandards`). `GET /v1/suppliers/{id}` says exactly which headers it takes, its environments and its own routes.

## The shared API

| Question | REST | Answer |
| --- | --- | --- |
| Every product it sells, with their part ids | `GET /v1/{supplier}/products` | `ProductList`: `{ count, products: [{ productId, partIds }] }` |
| Which products changed | `GET /v1/{supplier}/products?changedSince=<ISO time>` | `ProductList`, with `changedSince` |
| A product, with its parts (colors and sizes) | `GET /v1/{supplier}/products/{id}` | `Product` |
| Stock per part and warehouse | `GET /v1/{supplier}/products/{id}/inventory[?partId=…]` | `Inventory` |
| Prices per part, with quantity breaks | `GET /v1/{supplier}/products/{id}/pricing?priceType=Net\|List\|Customer` | `Pricing` |
| Where the orders under a PO stand | `GET /v1/{supplier}/orders/{po}` | `{ purchaseOrderNumber, orders: SalesOrder[] }` |
| Packages and tracking | `GET /v1/{supplier}/orders/{po}/shipments` | `{ purchaseOrderNumber, shipments: Shipment[] }` |
| Invoices | `GET /v1/{supplier}/invoices?po=…` (or `invoice=`, `date=`, `since=`) | `{ invoices: Invoice[] }` |
| Pictures, documents and video | `GET /v1/{supplier}/products/{id}/media[?type=Image\|Video\|Audio\|Document&partId=…&classType=…]` | `Media` |
| Which products' media changed | `GET /v1/{supplier}/media/changes?since=<ISO time>` | `{ since, productIds: string[] }` |

**Media.** `Media` is `{ productId, items: MediaItem[] }`; each item has its `url`, `mediaType`, `classTypes` (`{ id, name }`, PromoStandards' class types: 1004 Swatch, 1006 Primary, 1007 Front, 1008 Rear, …) and, when the supplier says, `partId`, `color`, size, dpi, decorations and locations. `type` is one media type per call (Image by default); `classType` is an id (`1007`) or a name (`Front`); `partId` gives that part's media and the whole product's. PromoStandards suppliers answer from Media Content 1.1.0. SanMar answers from its own Product Info images and S&S from its color images, with PromoStandards' class names where they match (front, back as Rear, swatch, the style's main picture as Primary) and OpenPromo's words where none does (`side`, `threeQuarter`, `model`, `flat`, and SanMar's `colorsAvailable`). Their pictures are per color, so an item carries a `partId` only when it shows exactly one part. They only have images, so other types come back empty. Neither can say what changed (SanMar doesn't answer `getMediaDateModified`), so `media/changes` is `not_offered` there: `?capability=media` and `?capability=mediaChanges` on `GET /v1/suppliers` say who answers each.

**The product list.** `GET /v1/{supplier}/products` is every product the supplier sells, as ids only: `{ count, products: [{ productId, partIds }] }`, one entry per product with the part ids it named, each once (ask `products/{id}` for the rest). `?changedSince=<ISO time>` answers the products changed since then, in the same shape, with `changedSince` as sent. Nothing to list is an empty list. PromoStandards suppliers answer from Product Data 2.0.0 (`getProductSellable` with `isSellable` true, and `getProductDateModified`), and so does SanMar, whose guide documents both. S&S answers the list from its styles catalog (product ids are its numeric style ids, `partIds` empty) but can't say what changed. They are two questions: `?capability=productList` (496 suppliers after the last sync) and `?capability=productChanges` (495) on `GET /v1/suppliers` say who answers each. It is the whole catalog in one call, so ask it once a day at most and never per search.

A supplier that can't answer a question says so (`404 not_offered`) before asking for a login. The full API, every supplier's own routes included, is at `GET /openapi.json` (OpenAPI 3.1). Money is in cents. The shapes are the TypeScript types the package exports. Errors look like this:

```json
{ "error": { "kind": "not_enabled", "message": "…", "supplier": "sanmar", "code": "104", "detail": "This account is unauthorized to use this service." } }
```

| `kind` | HTTP | Meaning |
| --- | --- | --- |
| `invalid` | 400 | The request can't be sent as it stands. Nothing reached the supplier. |
| `unauthorized` | 401 | Missing or wrong OpenPromo API key. |
| `orders_off` | 403 | Placing orders with this supplier is switched off on this server. The message names the supplier and `OPENPROMO_ORDERS`. |
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
| `POST /v1/{supplier}/orders/check` | Every PromoStandards supplier that lists Purchase Order 1.0.0: check a Blank order without sending it |
| `POST /v1/{supplier}/orders` | The same suppliers: place a Blank order (`sendPO`) |

Placing orders is off unless the supplier is listed in `OPENPROMO_ORDERS` (see [Placing orders](#placing-orders)).

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
| `OPENPROMO_ORDERS` | | The suppliers that may place real orders, as comma-separated ids (`sanmar,ssactivewear,acme`). `on` means SanMar and S&S Activewear only, the written drivers that take orders, never a directory supplier. Unset or `off` means none. An id this server doesn't serve stops it at start. |
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
| Order Shipment Notification | `shipments` | 1.0.0, 2.0.0, 2.1.0 (2.x also gives each package's ship-from and ship-to addresses, weight, dimensions and freight terms) |
| Invoice | `invoices` | 1.0.0 |
| Media Content | `media` | 1.1.0 (pictures, documents and video; also gives which products' media changed) |
| Purchase Order | `purchaseOrder` | 1.0.0 (Blank orders: `POST /v1/{id}/orders`, see [Placing orders](#placing-orders)) |

A config with a version it can't talk or a URL that isn't `https` is refused at start.

**3. A supplier with its own API.** Write a driver (`src/suppliers/driver.ts` is the whole contract) and add it to `NATIVE_DRIVERS` in `src/suppliers/registry.ts`. A driver says:

- its `id`, `name`, and which shared questions it answers (`capabilities`);
- its login fields and the header each comes in (`X-Supplier-Id` and `X-Supplier-Password` if it has an id and a secret);
- its environments, production first;
- `connect(login)`: a connection whose methods answer in the shared shapes;
- optionally, its own `routes` (`write: true` for anything that places something real).

The handler, the supplier list, the docs and the default-login env vars all come from that. `src/ssactivewear/` is a complete example: a client, pure functions from the supplier's JSON to the shared shapes (tested without a network), orders, and the driver.

## The directory

`src/directory/data.ts` is generated from PromoStandards' own endpoint directory (its Web Service Repository) by `pnpm directory:sync`. The last sync (2026-11-23) found 558 suppliers with 2,460 endpoints OpenPromo can talk, out of 1,040 suppliers listed; 448 of them list Purchase Order 1.0.0 (the 450 live PO listings, less two companies that list it twice; 11 more are still in review), 31 of those with a test URL, and only 64 of the 448 also list Order Status; 137 of them answer shipments (96 at Order Shipment Notification 1.0.0, 35 at 2.0.0, 6 at 2.1.0), and 510 list Media Content 1.1.0. SanMar and S&S are among them, but their drivers answer media from their own APIs and can't say what changed, so `?capability=media` lists 510 suppliers and `?capability=mediaChanges` 508. Media Content left out: seven suppliers list only 1.0.0 (an eighth only a deprecated 1.0.0), three list 1.1.0 at a URL that isn't https, and three are still in review. SanMar's listing gives exactly the endpoints its driver uses. For each supplier it keeps, per service, the highest version OpenPromo talks, with its test URL when one is listed. It prints everything it leaves out and why (a version OpenPromo doesn't talk, a URL that isn't https, a service listed inactive). The most common versions it can't use yet are Product Data 1.0.0 (479 endpoints) and Inventory 1.2.1 (132): supporting those is how most listed suppliers would gain stock and product data. A GitHub workflow runs it weekly and opens a pull request when anything changed. Hand fixes go in `src/directory/overrides.ts`, never in the generated file. A supplier with its own driver is never served from the directory.

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

Ordering is switched on per supplier. `GET /v1/suppliers?capability=orders` lists every supplier that can take orders here (448 after the last sync: SanMar, S&S and 446 directory suppliers), whether or not this server allows it. `OPENPROMO_ORDERS` lists the ids that may place real orders: `OPENPROMO_ORDERS=sanmar` lets SanMar order and refuses S&S, and `OPENPROMO_ORDERS=acme` lets a PromoStandards supplier with Purchase Order 1.0.0 order. `on` means SanMar and S&S Activewear, the suppliers with written drivers, and never a directory supplier, so an install that had `on` orders from just those two as before. `on` combines with ids (`on,acme`). Unset or `off` means no supplier orders. An id that isn't a supplier on this server (a typo, or one left out by `OPENPROMO_ENABLED_SUPPLIERS`) is a config error at start, naming it. A supplier that isn't listed answers every route that places an order with `403 orders_off`, naming the supplier and the variable, before anything reaches it. `GET /v1/suppliers/{id}` says whether it may order here (`ordersAllowed`, and `allowed` on each of its write routes).

The SanMar and S&S order routes check the order before sending (anything over the supplier's limits, a bad ZIP or an unknown ship method comes back `invalid`, with nothing placed), merge identical lines, and say every change they made in `changes`. Both first ask the supplier for live orders under the PO number and refuse with 409 if there are any. A send the supplier didn't answer (`unreachable` or `bad_response`) may still have gone through: look the PO up before sending again.

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

**PromoStandards suppliers** (`POST /v1/{supplier}/orders`, for every supplier that lists Purchase Order 1.0.0 at an https URL; `GET /v1/suppliers/{id}` lists the route when it does). List the supplier's id in `OPENPROMO_ORDERS` first. The body is one shape for all of them (the `PurchaseOrder` schema at `/openapi.json`), money in cents:

```json
{
  "poNumber": "1042-1",
  "shipTo": { "companyName": "Acme", "attentionTo": "Pat", "address1": "12 Main St", "city": "Austin", "region": "TX", "postalCode": "78701", "country": "US" },
  "carrier": "UPS",
  "service": "GROUND",
  "lines": [{ "productId": "PC54", "partId": "118032", "quantity": 12, "unitPrice": 312 }]
}
```

Before sending, in this order: the supplier is in `OPENPROMO_ORDERS` (else `403 orders_off`); the order passes every check below (else `400 invalid`, saying all of it); the supplier lists Order Status, so OpenPromo can look for an earlier copy (else `400 invalid` saying it can't, unless the body has `"skipDuplicateCheck": true` because you made sure yourself); the supplier takes Blank orders (`getSupportedOrderTypes`, else `424 not_enabled`); and Order Status shows no live order under the PO (else `409 duplicate`, with those orders). `skipDuplicateCheck` changes nothing for a supplier with Order Status: OpenPromo always looks. Then it sends once and answers `201` with `{ accepted, poNumber, transactionId, total, messages, changes, duplicateCheck }` (`duplicateCheck` is `orderStatus` or `skipped`). Keep the `transactionId`. A supplier's refusal is `refused`, `auth` or `not_enabled` (424), nothing placed; `unreachable` or `bad_response` means it may have gone through, so look the PO up before sending again. `POST /v1/{supplier}/orders/check` takes the same body and makes the same checks (Order Status and the order types included) without ever calling `sendPO`, whether or not ordering is on, and answers `200` with the lines, total, currency and changes as they would be sent.

**PromoStandards Purchase Order 1.0.0** (in the library too: `PromoStandardsClient.sendPurchaseOrder(order)`, which checks neither `OPENPROMO_ORDERS` nor Order Status, and `buildPurchaseOrder(order)` to check one without sending). Blank orders only (undecorated goods); Sample, Simple and Configured orders aren't built. Every line carries the buyer's own `unitPrice` in cents: OpenPromo never looks a price up or guesses one, and a line without one is `invalid`. It checks every required field, length and code list in the PO 1.0.0 schema (PO number 64, address lines and company 35, city 30, region 3, postal code 10, ISO country and currency codes), totals each line and the order, merges identical lines, and fills in only the currency (USD), the ship-to country (US) and the order date (now), each said in `changes`. It sends once, never retried, and answers the supplier's `transactionId`. A service message with severity Error is the supplier's refusal (nothing placed); an answer with no `transactionId`, a 5xx or no answer at all is `bad_response` or `unreachable`, and the order may have gone through. `getSupportedOrderTypes()` says which order types a supplier takes.

### Before allowing a PromoStandards supplier to order

Listing Purchase Order 1.0.0 in PromoStandards' directory isn't proof a supplier takes orders from you through it. For each one, before adding its id to `OPENPROMO_ORDERS`:

1. **Get PO service access and a test login from the supplier.** Ask for PO 1.0.0 to be switched on for your account, a test account where it has one, and its PO guide (what it wants beyond the schema: contacts, descriptions, payment terms). `environments` on `GET /v1/suppliers/{id}` includes `test` when the directory lists a test URL for any of its services; a test order needs one for Purchase Order (31 suppliers list one) and, for the duplicate check, for Order Status. A test request to a service with no test URL is `400 invalid`, with nothing sent.
2. **Send a Blank test order with `X-Supplier-Environment: test`** where the supplier lists a test URL. Run `POST /v1/{id}/orders/check` first (it works with ordering off, never sends, and also confirms Blank in `getSupportedOrderTypes`), then add the id to `OPENPROMO_ORDERS` on a test install only and send the order with the test header and the test login. Mark the PO as a test (`TEST-…`) and use the supplier's test items. Without Order Status (most directory suppliers) or without a test URL for it, the duplicate check can't run: confirm by hand there is no earlier copy and send `"skipDuplicateCheck": true`. With no test URL at all, agree with the supplier how to send a first order it will catch and cancel. Keep the `transactionId`. `unreachable` or `bad_response` means it may have gone through: ask the supplier before sending again.
3. **Confirm with the supplier that it arrived as intended, and that it was cancelled**: the lines, quantities, prices, ship-to, carrier and service as sent.
4. **Only then add the supplier's id to `OPENPROMO_ORDERS`** on the production server. `on` never covers a directory supplier.

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
- **Order Shipment Notification 2.0.0 and 2.1.0.** The test fixtures are built from the official schemas, not from a supplier's live answer.
- **Product Data's product list.** `getProductSellable` and `getProductDateModified` are read against fixtures built from the official Product Data 2.0.0 schema; no supplier has been called with them yet. SanMar's guide shows `getProductSellable` with a `productId` and lists it as optional; OpenPromo asks without one, for the whole catalog, so check SanMar answers that (and how long it takes) on your account.
- **Media Content 1.1.0.** The reader is tested against fixtures built from the official schema. None of the 508 directory suppliers that list it has been called yet. SanMar's and S&S's media come from the image fields Inkline already reads; the class types given to each view are OpenPromo's choice.
- **Purchase Order 1.0.0.** Not checked against a live account: requests are checked against the official schema and the test fixtures are built from it. None of the 446 directory suppliers served with it (SanMar and S&S also list it, but order through their own services) has been sent one yet, and each supplier's own PO guide may ask for more (a contact, a description, its own payment terms). Follow [the runbook](#before-allowing-a-promostandards-supplier-to-order) for each.
- **S&S style lookups by name.** `/v2/styles/{identifier}` with a part number or "Brand Style" (numeric style ids are proven).

## Changes

**Unreleased.** The product list: `GET /v1/{supplier}/products` and `?changedSince=`, the `productList` and `productChanges` capabilities (SanMar's and every Product Data 2.0.0 supplier's capabilities gain both, S&S's gains `productList`), `ProductList` and `ListedProduct` in `/openapi.json`, and in the library `PromoStandardsClient.getProductsSellable()` and `getProductsChanged(since)`, and `productList`/`productChanges` on a connection. `OPENPROMO_ORDERS` is a list of the suppliers that may order (`on` still means SanMar and S&S). `orders_off` names the supplier. `GET /v1/suppliers/{id}` gives `ordersAllowed`. In the library, `ServerConfig.allowOrders` is now `orders` (a set of ids), checked with `mayOrder(config, id)`. PromoStandards Purchase Order 1.0.0 for Blank orders in the library: `buildPurchaseOrder`, `PromoStandardsClient.sendPurchaseOrder` and `getSupportedOrderTypes`, with `purchaseOrder` as an `endpoints` key. `POST /v1/{supplier}/orders` and `/orders/check` for every PromoStandards supplier that lists Purchase Order 1.0.0, with the double-order guard (`409 duplicate`, or `400 invalid` without Order Status unless `skipDuplicateCheck`); the `PurchaseOrder` body schema in `/openapi.json`. In the library, `promoStandardsDriver` connections carry `ps` (the client) and such a driver has `PURCHASE_ORDER_ROUTES`. The directory sync now reads Purchase Order (`PO`): 448 suppliers list it, so each has the order routes (ordering stays off until its id is in `OPENPROMO_ORDERS`), and `GET /v1/suppliers?capability=orders` lists who can take orders; `capabilities` are unchanged.

**0.2.0.** One API for every supplier. S&S Activewear. The supplier directory and registry. `GET /v1/sanmar/products/{style}` now answers the shared `Product` (from SanMar's PromoStandards Product Data); SanMar's Product Info moved to `/v1/sanmar/native/product-info/{style}`, and `pricing` without `priceType` to `/v1/sanmar/native/pricing/{style}`. `/health` reports a count of suppliers, not their ids.

## License

MIT
