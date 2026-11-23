/**
 * Media as one shared answer for suppliers whose own API gives pictures, not
 * PromoStandards Media Content: the same `Media` shape, class types named as
 * PromoStandards names them where they match, and the same filters.
 */
import type { Media, MediaItem, MediaType } from "../promostandards/types.js";

/** What a caller can narrow media to: one media type (Image by default), one part, one class type (id or name). */
export interface MediaFilter {
  mediaType?: MediaType;
  partId?: string;
  classType?: string;
}

/**
 * Class types. The first four are PromoStandards' own ids and names (as
 * SanMar's Media Content answer uses them). PromoStandards has no class for
 * the rest, so they carry OpenPromo's word as both id and name.
 */
export const MEDIA_CLASS = {
  swatch: { id: "1004", name: "Swatch" },
  primary: { id: "1006", name: "Primary" },
  front: { id: "1007", name: "Front" },
  rear: { id: "1008", name: "Rear" },
  side: { id: "side", name: "Side" },
  threeQuarter: { id: "threeQuarter", name: "Three Quarter" },
  model: { id: "model", name: "Model" },
  flat: { id: "flat", name: "Flat" },
  colorsAvailable: { id: "colorsAvailable", name: "Colors Available" },
} as const satisfies Record<string, { id: string; name: string }>;

type ClassType = { id: string; name: string };

/** One picture as a supplier's own API gives it: the parts (and color) it is of, none for the whole product. */
export interface SupplierImage {
  url: string;
  color?: string;
  partIds: readonly string[];
  classTypes: readonly ClassType[];
}

/** Does this item have the class type, by id or by name (any case)? */
export const hasClassType = (item: Pick<MediaItem, "classTypes">, classType: string) => {
  const want = classType.trim().toLowerCase();
  return item.classTypes.some((c) => c.id.toLowerCase() === want || c.name.toLowerCase() === want);
};

/**
 * Pictures as `Media`. The same URL given for several parts is one item: its
 * color when they share one, its `partId` only when it is of exactly one part.
 * `partId` keeps that part's pictures and the whole product's; a part the
 * product doesn't have keeps nothing. Only images: any other media type is empty.
 */
export function imageMedia(productId: string, images: readonly SupplierImage[], filter: MediaFilter = {}, allPartIds: readonly string[] = []): Media {
  if (filter.mediaType && filter.mediaType !== "Image") return { productId, items: [] };
  const byUrl = new Map<string, { colors: Set<string>; parts: Set<string>; productLevel: boolean; classTypes: ClassType[] }>();
  for (const img of images) {
    if (!img.url) continue;
    let entry = byUrl.get(img.url);
    if (!entry) byUrl.set(img.url, (entry = { colors: new Set(), parts: new Set(), productLevel: false, classTypes: [] }));
    if (img.color) entry.colors.add(img.color);
    if (!img.partIds.length) entry.productLevel = true;
    for (const p of img.partIds) entry.parts.add(p);
    for (const c of img.classTypes) if (!entry.classTypes.some((have) => have.id === c.id)) entry.classTypes.push({ id: c.id, name: c.name });
  }
  const want = filter.partId?.trim().toLowerCase();
  if (want && !allPartIds.some((p) => p.toLowerCase() === want)) return { productId, items: [] };
  const items: MediaItem[] = [];
  for (const [url, e] of byUrl) {
    const parts = e.productLevel ? [] : [...e.parts];
    if (want && parts.length && !parts.some((p) => p.toLowerCase() === want)) continue;
    const item: MediaItem = {
      url,
      mediaType: "Image",
      ...(parts.length === 1 ? { partId: parts[0] } : {}),
      ...(e.colors.size === 1 ? { color: [...e.colors][0] } : {}),
      classTypes: e.classTypes,
    };
    if (filter.classType && !hasClassType(item, filter.classType)) continue;
    items.push(item);
  }
  return { productId, items };
}
