import type { Ad, Config } from "./types";
import type { LineItemInfo, DfpSettings } from "./dfp";
import {
  getCreativeAssociationsByLineItem,
  getCreativesByIds,
  getLineItemsByOrderId,
} from "./dfp";

/**
 * Line item statuses worth capturing.
 *
 * DELIVERING/PAUSED are live. COMPLETED is kept because on-site preview still serves a
 * finished line item, and dropping it would silently stop capturing creatives that a
 * hand-written `ads` array would have listed. DRAFT and ARCHIVED are excluded.
 */
const CAPTURED_STATUSES = new Set(["DELIVERING", "PAUSED", "COMPLETED"]);

export interface SkippedCreative {
  lineItemId?: string;
  lineItemName?: string;
  creativeId?: string;
  reason: string;
}

export interface DiscoveryResult {
  ads: Ad[];
  skipped: SkippedCreative[];
  /** Line items the API matched but never returned, because `paging` is unusable. */
  truncated: boolean;
  lineItemsSeen: number;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function overlaps(lineItem: LineItemInfo, config: Config): boolean {
  const { start, end } = config.postSource.dateRange;
  const flightStart = lineItem.startDate ?? start;
  const flightEnd = lineItem.endDate ?? end;
  return flightStart <= end && flightEnd >= start;
}

export interface DiscoverOptions {
  /** Refuse to return more than this many ads; 0 means no cap. */
  maxCreatives?: number;
  settings?: DfpSettings;
}

export async function discoverAds(
  orderId: string,
  config: Config,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const ads: Ad[] = [];
  const skipped: SkippedCreative[] = [];
  const networkCode = config.dfp?.networkCode ?? "";

  const lineItems = await getLineItemsByOrderId(orderId, options.settings);
  const candidates = lineItems.rows.filter((lineItem) => {
    if (lineItem.isArchived) return false;
    if (lineItem.status && !CAPTURED_STATUSES.has(lineItem.status)) return false;
    return overlaps(lineItem, config);
  });

  // Collect creative ids across all surviving line items so creatives are fetched in
  // one batched statement rather than one call per line item.
  const wanted: Array<{ lineItem: LineItemInfo; creativeId: string }> = [];
  for (const lineItem of candidates) {
    const associations = await getCreativeAssociationsByLineItem(
      lineItem.id!,
      options.settings,
    );
    for (const association of associations.rows) {
      if (!association.creativeId) continue;
      // Any association the API returns is capturable: on-site preview is generated
      // from the association itself, so a non-ACTIVE status still renders. Filtering
      // here would silently drop creatives, and the pixel check catches a wrong one.
      wanted.push({ lineItem, creativeId: association.creativeId });
    }
  }

  const creatives = await getCreativesByIds(
    [...new Set(wanted.map((entry) => entry.creativeId))],
    options.settings,
  );

  const cap = options.maxCreatives ?? 0;
  let capped = false;

  for (const { lineItem, creativeId } of wanted) {
    const creative = creatives.get(creativeId);
    const base = { lineItemId: lineItem.id, lineItemName: lineItem.name, creativeId };

    if (!creative) {
      skipped.push({ ...base, reason: "creative no longer exists or is not visible" });
      continue;
    }
    if (creative.overrideSize) {
      skipped.push({
        ...base,
        reason: "creative has a size override; on-site preview cannot pin it",
      });
      continue;
    }
    if (!creative.width || !creative.height) {
      skipped.push({ ...base, reason: "creative has no pixel size (non-image creative)" });
      continue;
    }
    if (cap > 0 && ads.length >= cap) {
      capped = true;
      continue;
    }

    const { start, end } = config.postSource.dateRange;
    ads.push({
      id: creativeId,
      label: `${lineItem.name ?? lineItem.id} / ${creative.name ?? creativeId}`,
      campaign: lineItem.name,
      viewport: config.viewport,
      width: creative.width,
      height: creative.height,
      queryParams: {
        iu: networkCode,
        gdfp_req: "1",
        lineItemId: lineItem.id!,
        creativeId,
      },
      preview: { lineItemId: lineItem.id!, creativeId },
      referenceAssetUrl: creative.assetUrl,
      startDate: maxDate(lineItem.startDate ?? start, start),
      endDate: minDate(lineItem.endDate ?? end, end),
    });
  }

  if (capped) {
    skipped.push({
      reason: `reached the --max-creatives cap of ${cap}; some creatives were not expanded`,
    });
  }

  return { ads, skipped, truncated: lineItems.truncated, lineItemsSeen: lineItems.rows.length };
}

export function formatSkipped(skipped: SkippedCreative[]): string[] {
  return skipped.map((entry) => {
    const where = [entry.lineItemName ?? entry.lineItemId, entry.creativeId]
      .filter(Boolean)
      .join(" / ");
    return where ? `${where}: ${entry.reason}` : entry.reason;
  });
}