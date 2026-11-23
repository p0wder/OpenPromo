// Vercel entry: every path is rewritten here (vercel.json). The build runs `pnpm build` first.
import { ConfigError, createHandler, loadConfig } from "../dist/server/index.js";

let handler;
let configError;
function app(request) {
  if (!handler && !configError) {
    try {
      handler = createHandler(loadConfig());
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      configError = e.message;
    }
  }
  if (handler) return handler(request);
  // Not set up yet: say what's missing (no secrets in it) instead of failing every request.
  return Response.json({ ok: false, error: { kind: "not_configured", message: `OpenPromo isn't set up yet: ${configError}` } }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export const GET = app;
export const POST = app;
