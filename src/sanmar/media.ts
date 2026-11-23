/**
 * SanMar's Product Info pictures as the shared `Media`. Product Info is
 * SanMar's own service: its images are per color and name their view (flat or
 * on a model, front, back, side). A picture of a color is of every size of it.
 */
import type { Media } from "../promostandards/types.js";
import { imageMedia, MEDIA_CLASS, type MediaFilter, type SupplierImage } from "../suppliers/media.js";
import type { SanmarColor, SanmarProduct } from "./index.js";

const C = MEDIA_CLASS;

/** Each Product Info image field and its class types, in the order they're listed. */
const VIEWS: readonly [(c: SanmarColor) => string | undefined, readonly { id: string; name: string }[]][] = [
  [(c) => c.images.product, [C.primary]],
  [(c) => c.images.frontFlat, [C.front, C.flat]],
  [(c) => c.images.backFlat, [C.rear, C.flat]],
  [(c) => c.images.frontModel, [C.front, C.model]],
  [(c) => c.images.backModel, [C.rear, C.model]],
  [(c) => c.images.sideModel, [C.side, C.model]],
  [(c) => c.images.threeQuarterModel, [C.threeQuarter, C.model]],
  // colorSquareImage is the color's own swatch; colorSwatchImage shows every color of the style.
  [(c) => c.squareUrl, [C.swatch]],
  [(c) => c.swatchUrl, [C.colorsAvailable]],
];

/** A part's id at SanMar (PromoStandards' `partId`): the size's unique key, else inventory key and size index. */
const partIdOf = (s: SanmarColor["sizes"][number]) => s.uniqueKey ?? (s.inventoryKey && s.sizeIndex ? `${s.inventoryKey}${s.sizeIndex}` : undefined);

/** A style's pictures from Product Info. Part ids are SanMar's unique keys, as on stock, orders and invoices. */
export function sanmarMedia(product: SanmarProduct, filter: MediaFilter = {}): Media {
  const images: SupplierImage[] = [];
  const allPartIds: string[] = [];
  for (const color of product.colors) {
    const partIds = color.sizes.map(partIdOf).filter((p): p is string => !!p);
    allPartIds.push(...partIds);
    for (const [url, classTypes] of VIEWS) {
      const u = url(color);
      if (u) images.push({ url: u, color: color.name, partIds, classTypes });
    }
  }
  return imageMedia(product.style, images, filter, allPartIds);
}
