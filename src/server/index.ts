/** The OpenPromo REST server: `createHandler(loadConfig())` is the whole app. */
export { ConfigError, loadConfig, type ServerConfig, type SupplierEntry } from "./config.js";
export { createHandler, type HandlerOptions } from "./handler.js";
export { openApiDocument } from "./openapi.js";
