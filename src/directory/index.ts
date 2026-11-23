/**
 * The PromoStandards suppliers OpenPromo knows out of the box: each one's
 * endpoints and versions, so `/v1/{id}/…` works with no config. Data, not
 * code: adding a supplier is adding an entry.
 *
 *  - `data.ts` is generated from PromoStandards' own endpoint directory by
 *    `pnpm directory:sync` (scripts/sync-directory.mjs). Don't edit it by hand.
 *  - `overrides.ts` is kept by hand: fixes to what the directory publishes
 *    (a wrong URL, a quirk), entries it lacks, and suppliers to leave out.
 *
 * A supplier with its own driver (SanMar, S&S Activewear) is never served
 * from here, even when PromoStandards lists it: its driver knows more.
 */
import type { PromoStandardsListing } from "../suppliers/promostandards.js";
import { DIRECTORY_DATA } from "./data.js";
import { DIRECTORY_OVERRIDES } from "./overrides.js";

export interface DirectoryOverrides {
  /** Merged over the generated entry with the same id (endpoints merge per service). */
  patch: Record<string, Partial<PromoStandardsListing>>;
  /** Entries the generated data lacks. */
  add: PromoStandardsListing[];
  /** Ids to leave out, with why. */
  skip: Record<string, string>;
}

/** The generated entries with the hand-kept overrides applied, sorted by id. */
export function buildDirectory(data: readonly PromoStandardsListing[], overrides: DirectoryOverrides): PromoStandardsListing[] {
  const byId = new Map<string, PromoStandardsListing>();
  for (const entry of [...data, ...overrides.add]) byId.set(entry.id, entry);
  for (const [id, patch] of Object.entries(overrides.patch)) {
    const base = byId.get(id);
    if (!base) continue;
    byId.set(id, { ...base, ...patch, endpoints: { ...base.endpoints, ...patch.endpoints } });
  }
  for (const id of Object.keys(overrides.skip)) byId.delete(id);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const DIRECTORY: readonly PromoStandardsListing[] = buildDirectory(DIRECTORY_DATA, DIRECTORY_OVERRIDES);
