#!/usr/bin/env node
/**
 * Runs the API on plain Node (`npx openpromo`, `node dist/server/node.js`, or
 * the Docker image). PORT defaults to 8787; HOST to 0.0.0.0.
 */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { ConfigError, createHandler, loadConfig } from "./index.js";

let config: ReturnType<typeof loadConfig> | undefined;
let configError: string | undefined;
try {
  config = loadConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  configError = e.message;
  console.error(`OpenPromo isn't set up yet: ${e.message}`);
}
// Not set up yet (a host such as Vercel or Docker restarts a process that exits): stay up and say what's missing, never any secret.
const handler = config
  ? createHandler(config)
  : async () => Response.json({ ok: false, error: { kind: "not_configured", message: `OpenPromo isn't set up yet: ${configError}` } }, { status: 503, headers: { "Cache-Control": "no-store" } });
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const MAX_BODY = 1_000_000;

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { kind: "invalid", message: "The request body is too large." } }));
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
    const method = req.method ?? "GET";
    const response = await handler(new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks) }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
    else res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { kind: "internal", message: "Something went wrong in OpenPromo." } }));
  }
}).listen(port, host, () => console.info(config ? `OpenPromo listening on http://${host}:${port} (suppliers: ${[...config.suppliers.keys()].join(", ")}; orders ${config.allowOrders ? "on" : "off"})` : `OpenPromo listening on http://${host}:${port}, not set up yet (every request answers 503)`));
