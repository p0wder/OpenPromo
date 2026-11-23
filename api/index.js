// Vercel entry: every path is rewritten here (vercel.json). The build runs `pnpm build` first.
import { createHandler, loadConfig } from "../dist/server/index.js";

let handler;
function app(request) {
  handler ??= createHandler(loadConfig());
  return handler(request);
}

export const GET = app;
export const POST = app;
