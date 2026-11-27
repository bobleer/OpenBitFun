import type { MarketCategory, MarketListing, MarketOrigin, MarketSort } from "./miniAppMarketStore";
import { localizedSpace, type SpaceMeta } from "./spacesStore";

export interface InstalledSpaceRow {
  app: SpaceMeta;
  listing?: MarketListing;
  updateAvailable: boolean;
}

export function installedSpaceRows(
  apps: readonly SpaceMeta[],
  origins: Readonly<Record<string, MarketOrigin & { appId: string }>>,
  listings: ReadonlyMap<string, MarketListing>,
  filter: { keyword: string; category: MarketCategory; sort: MarketSort },
): InstalledSpaceRow[] {
  const byApp = new Map(Object.values(origins).map(origin => [origin.appId, origin]));
  const rows: InstalledSpaceRow[] = [];
  for (const app of apps) {
    const origin = byApp.get(app.id);
    const listing = origin ? listings.get(origin.listingId) : undefined;
    if (filter.category !== "all" && (listing?.category ?? app.category).toLowerCase() !== filter.category) continue;
    if (filter.keyword) {
      const copy = localizedSpace(app);
      const searchable = [copy.name, copy.description, ...copy.tags, app.name, app.description, ...app.tags];
      if (listing) {
        const marketCopy = localizedSpace(listing);
        searchable.push(marketCopy.name, marketCopy.description, ...marketCopy.tags,
          listing.name, listing.description, ...listing.tags);
      }
      if (!searchable.some(value => value.toLowerCase().includes(filter.keyword))) continue;
    }
    rows.push({ app, listing, updateAvailable: Boolean(origin && listing && listing.latestRelease > origin.releaseNumber) });
  }
  return rows.sort((a, b) => compareInstalledSpaces(a, b, filter.sort));
}

function compareInstalledSpaces(left: InstalledSpaceRow, right: InstalledSpaceRow, sort: MarketSort): number {
  const a = left.listing;
  const b = right.listing;
  if (sort !== "newest") {
    if (Boolean(a) !== Boolean(b)) return a ? -1 : 1;
    if (a && b) {
      const metric = sort === "downloads" ? b.downloadCount - a.downloadCount
        : b.ratingAverage - a.ratingAverage || b.ratingCount - a.ratingCount;
      if (metric) return metric;
    }
  }
  const date = (item: InstalledSpaceRow) => {
    const published = item.listing?.publishedAt;
    return published ? (published < 100_000_000_000 ? published * 1000 : published) : item.app.createdAt;
  };
  return date(right) - date(left) || Number(right.updateAvailable) - Number(left.updateAvailable);
}
