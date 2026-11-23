# OpenPromo

A free, open-source REST API for PromoStandards and SanMar web services that you host yourself. Run it on your own accounts, pay nobody per call, and read the code that talks to your suppliers.

Suppliers publish their catalog, stock, pricing, order status, tracking and invoices as SOAP web services, mostly to the [PromoStandards](https://promostandards.org) schemas. OpenPromo turns those into plain JSON over HTTPS. It is also a TypeScript library, so an app can call suppliers directly with no server in between.

- **Your logins stay with you.** One install serves your own accounts. Supplier logins live in your environment variables and go nowhere but the supplier.
- **It asks only when you ask.** There's no polling and no background jobs. Every call is one request to the supplier, made when you make it.
- **It's checked against the suppliers' own documents.** Request and response shapes come from SanMar's Web Services Integration Guide v24.7 and Purchase Order Integration Guide v24.6 (October 2026). The test fixtures say which page each one comes from.

## What it covers

| Service | Versions | REST |
| --- | --- | --- |
| PromoStandards Product Data | 2.0.0 | `GET /v1/{supplier}/products/{id}` |
| PromoStandards Inventory | 2.0.0 | `GET /v1/{supplier}/products/{id}/inventory` |
| PromoStandards Pricing and Configuration | 1.0.0 | `GET /v1/{supplier}/products/{id}/pricing?priceType=Net\|List\|Customer` |
| PromoStandards Order Status | 1.0.0, 2.0.0 | `GET /v1/{supplier}/orders/{po}` |
| PromoStandards Order Shipment Notification | 1.0.0 | `GET /v1/{supplier}/orders/{po}/shipments` |
| PromoStandards Invoice | 1.0.0 | `GET /v1/{supplier}/invoices?po=…` (or `invoice=`, `date=`, `since=`) |
| SanMar Product Info | | `GET /v1/sanmar/products/{style}` |
| SanMar Pricing (with your own `myPrice`) | | `GET /v1/sanmar/products/{style}/pricing` |
| SanMar PO service: check (`getPreSubmitInfo`) | | `POST /v1/sanmar/orders/preview` |
| SanMar PO service: place (`submitPO`) | | `POST /v1/sanmar/orders` (off unless `OPENPROMO_ORDERS=on`) |

The full API is described at `GET /openapi.json` (OpenAPI 3.1). Money is in cents. Errors look like this:

```json
{ "error": { "kind": "not_enabled", "message": "…", "supplier": "sanmar", "code": "104", "detail": "This account is unauthorized to use this service." } }
```

| `kind` | HTTP | Meaning |
| --- | --- | --- |
| `invalid` | 400 | The request can't be sent as it stands. Nothing reached the supplier. |
| `unauthorized` | 401 | Missing or wrong OpenPromo API key. |
| `orders_off` | 403 | Placing orders is switched off on this server. |
| `not_found` / `not_yet` | 404 | The supplier has no such item, or it hasn't shipped or been invoiced yet. |
| `duplicate` | 409 | The supplier already has a live order under that PO number. Nothing was sent. |
| `auth` / `not_enabled` / `refused` | 424 | The supplier turned down your login, hasn't switched the service on, or refused the request. |
| `rate_limited` | 429 | Too many requests to the supplier. |
| `bad_response` / `unreachable` | 502 / 504 | The supplier's answer couldn't be read, or it didn't answer. |

## Run it

You need a long random API key (`openssl rand -hex 32`) and your supplier logins. Copy `.env.example` to `.env` and fill it in.

**Vercel.** Fork this repo and import it as a new Vercel project. Set the environment variables from `.env.example` and deploy. SanMar has had no IP restriction since July 2018, so no static IP is needed. Calls go out on port 8080 with TLS 1.2.

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
curl -H "Authorization: Bearer $OPENPROMO_API_KEY" http://localhost:8787/v1/sanmar/products/PC54/inventory
```

## Configuration

| Variable | Required | What it does |
| --- | --- | --- |
| `OPENPROMO_API_KEY` | Yes | At least 24 characters. Callers send it as `Authorization: Bearer <key>`. Comma-separate several keys to rotate one. |
| `SANMAR_CUSTOMER_NUMBER`, `SANMAR_USERNAME`, `SANMAR_PASSWORD` | For SanMar | Your customer number and a sanmar.com web-services user. Set all three or none. |
| `SANMAR_ENVIRONMENT` | | `production` (the default) or `edev`, SanMar's test environment. EDEV has its own logins, which SanMar Integration Support issues. |
| `SANMAR_WAREHOUSE_SELECTION` | | `on` only if SanMar set your account up for Warehouse Selection. Lines can then name a warehouse, and will call (`REN`, `CIN`, …) is allowed. |
| `OPENPROMO_ORDERS` | | `on` lets `POST /v1/sanmar/orders` place real orders. It's off by default. |
| `OPENPROMO_SUPPLIERS` | | Other PromoStandards suppliers, as JSON (see below). |
| `PORT`, `HOST` | | For the Node server. Defaults are `8787` and `0.0.0.0`. |

### Other PromoStandards suppliers

Any supplier that implements the services above works once you give it its endpoints. Each supplier publishes them in the [PromoStandards directory](https://promostandards.org) or in its own integration guide.

```json
[
  {
    "id": "acme",
    "name": "Acme Promo",
    "endpoints": {
      "inventory": { "version": "2.0.0", "url": "https://ps.acme.example/inventory/v2" },
      "orderStatus": { "version": "1.0.0", "url": "https://ps.acme.example/orderstatus" }
    },
    "login": { "id": "your-id", "password": "your-password" }
  }
]
```

OpenPromo checks the config at start and refuses to run with a version it can't talk or a URL that isn't `https`.

## Use it as a library

```ts
import { SanmarClient, PromoStandardsClient } from "openpromo";

const sanmar = new SanmarClient({ customerNumber: "…", username: "…", password: "…" });
const product = await sanmar.productInfo("PC54"); // colors, sizes, uniqueKeys, standard prices
const prices = await sanmar.pricing("PC54"); // includes myPrice, your account's own price
const stock = await sanmar.promoStandards().getInventory("PC54");
const [status] = await sanmar.promoStandards().getOrderStatus({ poNumber: "1042-1" });
```

Every client takes the login it should use and keeps no state, so one process can serve many accounts. Pass `fetch` to supply your own transport, for tests or a proxy. Everything throws `OpenPromoError` with a `kind`, as in the table above.

## Placing SanMar orders

`POST /v1/sanmar/orders` takes this body:

```json
{
  "poNumber": "1042-1",
  "shipTo": { "company": "Acme", "attention": "Pat", "address1": "12 Main ST", "city": "Austin", "state": "TX", "zip": "78701", "email": "pat@example.com" },
  "residential": false,
  "shipMethod": "UPS",
  "lines": [{ "style": "PC54", "color": "Jet Black", "size": "L", "quantity": 12 }]
}
```

Before sending, OpenPromo applies SanMar's rules:

- It removes commas from every field. Commas are SanMar's file delimiter.
- It refuses any field over SanMar's limits: PO 28, company 28, address 35, city 28, email 105.
- It cuts notes to 100 characters.
- It checks the ZIP and the ship method.
- It merges identical lines into one.
- It sends a warehouse only on Warehouse Selection accounts.

Every change it made comes back in `changes`.

It also asks SanMar's Order Status for the PO number first and refuses (409) if SanMar already has a live order under it. A send that SanMar didn't answer (`unreachable` or `bad_response`) may still have gone through. Look the PO up before sending again.

SanMar wants each account to certify ordering on EDEV first: a multi-line test order to a real address, which SanMar reviews, before turning on production PO integration. Run with `SANMAR_ENVIRONMENT=edev` and your EDEV login for that.

## Be gentle with suppliers

SanMar sets no hard limits but asks for discretion (guide pp. 13–17):

- **Order status and shipments:** at most three calls a day per PO, and none in the first two hours after placing it.
- **Invoices:** after 3 p.m. Pacific, a day after shipping.
- **Prices:** these change once or twice a year (sales on Mondays and Wednesdays), so cache them.
- **Whole catalog:** use SanMar's FTP files (EPDD, `sanmar_dip.txt`), not per-style calls.

OpenPromo never polls. What you call is what SanMar sees.

## What hasn't been checked against a live account

Every shape here comes from SanMar's published guides, but none has been called with a real login yet. Run each endpoint once against your account and report anything that differs:

- **Product Data address.** SanMar's guide gives two paths for Product Data: `ProductDataServiceBindingV2` in its example call, and `ProductDataServiceV2.xml` for the WSDL. OpenPromo uses the first.
- **SanMar's wording for a disabled service.** The "not enabled" message for SanMar's own services isn't documented. OpenPromo reads anything mentioning "not enabled / not authorized" as `not_enabled`.

## License

MIT
