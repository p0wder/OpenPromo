/** The OpenPromo REST server: `createHandler(loadConfig())` is the whole app. */
export { ConfigError, connectionFor, loadConfig, mayOrder, ordersOffMessage, type ServerConfig, type SupplierDef } from "./config.js";
export { createHandler, describeSupplier, VERSION, type HandlerOptions } from "./handler.js";
export { openApiDocument } from "./openapi.js";
export * from "./schemas.js";
