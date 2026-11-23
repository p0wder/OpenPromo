/**
 * Hand-kept fixes to the generated directory (data.ts). Each one says why,
 * so the next sync can tell whether it's still needed.
 */
import type { DirectoryOverrides } from "./index.js";

export const DIRECTORY_OVERRIDES: DirectoryOverrides = {
  patch: {},
  add: [],
  skip: {
    "s-and-s-activewear": "Served by the ssactivewear driver (S&S's REST API v2), which answers everything this listing does and places orders.",
  },
};
