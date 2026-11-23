/** The OpenPromo REST server: `createHandler(loadConfig())` is the whole app. */
export { ConfigError, connectionFor, loadConfig, type ServerConfig, type SupplierDef } from "./config.js";
export { createHandler, describeSupplier, VERSION, type HandlerOptions } from "./handler.js";
export { openApiDocument } from "./openapi.js";
export * from "./schemas.js";
