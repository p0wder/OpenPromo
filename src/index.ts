/**
 * OpenPromo: PromoStandards and SanMar web services as plain TypeScript, and
 * a REST server on top (`openpromo/server`). Every call takes the login it
 * should use; nothing here reads environment variables or keeps state.
 */
export * from "./errors.js";
export * from "./soap.js";
export * from "./promostandards/types.js";
export * from "./promostandards/client.js";
export * from "./sanmar/index.js";
