/**
 * OpenPromo: supplier web services (PromoStandards, SanMar, S&S Activewear)
 * as plain TypeScript, the same shapes for every supplier, and a REST server
 * on top (`openpromo/server`). Every call takes the login it should use;
 * nothing here reads environment variables or keeps state.
 */
export * from "./errors.js";
export * from "./soap.js";
export * from "./promostandards/types.js";
export * from "./promostandards/client.js";
export * from "./promostandards/order.js";
export * from "./sanmar/index.js";
export * from "./sanmar/driver.js";
export * from "./ssactivewear/index.js";
export * from "./suppliers/driver.js";
export * from "./suppliers/media.js";
export * from "./suppliers/promostandards.js";
export * from "./suppliers/registry.js";
export { DIRECTORY, buildDirectory, type DirectoryOverrides } from "./directory/index.js";
