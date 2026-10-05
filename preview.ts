import type { Ad, Post } from "./types";
import type { PreviewUrlMap } from "./matcher";
import { previewKey } from "./matcher";
import {
  describeAssociation,
  dfpConfigured,
  getCreative,
  getLineItem,
  getPreviewUrl,
} from "./dfp";
import type { AssociationInfo } from "./dfp";

export interface PreflightReport {
  adId: string;
  ok: boolean;
  problems: string[];
  warnings: string[];
  info: string[];
}

function compareToFlight(
  report: PreflightReport,
  startDate: string | undefined,
  endDate: string | undefined,
  ad: Ad,
): void {
  if (!startDate || !endDate) return;
  report.info.push(`line item flight ${startDate} → ${endDate}`);
  if (startDate > ad.startDate) {
    report.warnings.push(
      `line item starts ${startDate}, but this config captures from ${ad.startDate}; ` +
        `those earlier posts fall outside the flight and cannot show this creative`,
    );
  }
  if (endDate < ad.endDate) {
    report.warnings.push(
      `line item ends ${endDate}, but this config captures to ${ad.endDate}; ` +
        `those later posts fall outside the flight`,
    );
  }
}

export async function preflightAd(ad: Ad): Promise<PreflightReport> {
  const report: PreflightReport = { adId: ad.id, ok: true, problems: [], warnings: [], info: [] };
  if (!ad.preview) return report;

  const { lineItemId, creativeId } = ad.preview;

  const association = await describeAssociation(lineItemId, creativeId).catch(
    (err: unknown): AssociationInfo | Error =>
      err instanceof Error ? err : new Error(String(err)),
  );
  if (association instanceof Error) {
    report.ok = false;
    report.problems.push(
      `could not read the association: ${association.message}. ` +
        `Check the service account has access to this network.`,
    );
    return report;
  }

  if (!association.found) {
    report.ok = false;
    report.problems.push(
      `no association between line item ${lineItemId} and creative ${creativeId}, ` +
        `so no preview can be generated`,
    );
  } else {
    report.info.push(`association ${association.status ?? "unknown"}`);
  }

  const [creative, lineItem] = await Promise.all([
    getCreative(creativeId).catch(() => null),
    getLineItem(lineItemId).catch(() => null),
  ]);

  if (creative) {
    const size = creative.width && creative.height ? `${creative.width}x${creative.height}` : "unknown";
    report.info.push(`creative "${creative.name ?? "?"}" ${size}`);
    if (creative.assetUrl) {
      ad.referenceAssetUrl = creative.assetUrl;
      report.info.push("using the creative asset as a pixel reference for verification");
    } else {
      report.warnings.push(
        "creative has no image asset to compare against; verification falls back to the " +
          "ad unit and size only, so a different ad in the same slot could pass",
      );
    }
    if (creative.overrideSize) {
      report.ok = false;
      report.problems.push(
        "creative has a size override; Ad Manager on-site preview does not support size " +
          "overrides, so the preview will not pin this creative",
      );
    }
    if (creative.width && creative.height && `${creative.width}x${creative.height}` !== `${ad.width}x${ad.height}`) {
      report.warnings.push(
        `creative is ${creative.width}x${creative.height} but the config declares ` +
          `${ad.width}x${ad.height}; filenames and any size-based matching will disagree`,
      );
    }
  } else {
    report.warnings.push("could not read the creative record");
  }

  if (lineItem) {
    report.info.push(`line item "${lineItem.name ?? "?"}" status ${lineItem.status ?? "unknown"}`);
    if (lineItem.sizes.length > 0) {
      report.info.push(`line item targets sizes ${lineItem.sizes.join(", ")}`);
      const expected = `${ad.width}x${ad.height}`;
      if (!lineItem.sizes.includes(expected)) {
        report.warnings.push(
          `line item does not target ${expected}; on-site preview needs a matching size ` +
            `request on the page or it silently falls back to normal rotation`,
        );
      }
    }
    if (lineItem.placementIds.length > 0) {
      report.info.push(`line item restricted to placement ids ${lineItem.placementIds.join(", ")}`);
    }
    if (lineItem.customCriteria.length > 0) {
      report.info.push(
        `line item has custom targeting: ${lineItem.customCriteria
          .map((c) => `key ${c.keyId} ${c.operator} [${c.valueIds.join(", ")}]`)
          .join("; ")}`,
      );
    }
    compareToFlight(report, lineItem.startDate, lineItem.endDate, ad);
    if (lineItem.status === "COMPLETED" || lineItem.status === "ARCHIVED") {
      report.info.push(
        `line item is ${lineItem.status}. On-site preview still works for ended line items, ` +
          `but the line item delivers no live traffic, so only previews will show it.`,
      );
    }
  } else {
    report.warnings.push("could not read the line item record");
  }

  if (report.problems.length > 0) report.ok = false;
  return report;
}

export async function runPreflight(ads: Ad[]): Promise<PreflightReport[]> {
  const reports: PreflightReport[] = [];
  for (const ad of ads) {
    if (!ad.preview) continue;
    const report = await preflightAd(ad);
    console.log(
      `\nPreflight ${ad.label} (${ad.width}x${ad.height}, creative ${ad.preview.creativeId}):`,
    );
    for (const line of report.info) console.log(`  · ${line}`);
    for (const warning of report.warnings) console.warn(`  ⚠ ${warning}`);
    for (const problem of report.problems) console.error(`  ✗ ${problem}`);
    if (report.ok && report.warnings.length === 0) console.log("  ✓ ok");
    else if (report.ok) console.log("  ✓ no blocking problems (see warnings above)");
    reports.push(report);
  }
  return reports;
}

export async function resolvePreviewUrls(
  posts: Post[],
  ads: Ad[],
  concurrency = 3,
): Promise<PreviewUrlMap> {
  const map: PreviewUrlMap = new Map();
  const targets: Array<{ ad: Ad; post: Post }> = [];

  for (const ad of ads) {
    if (!ad.preview) continue;
    for (const post of posts) {
      if (post.date < ad.startDate || post.date > ad.endDate) continue;
      targets.push({ ad, post });
    }
  }

  if (targets.length === 0) return map;
  if (!dfpConfigured()) {
    console.log("\nNo Ad Manager credentials configured; using static queryParams instead.");
    return map;
  }

  console.log(`\nGenerating ${targets.length} Ad Manager preview URL(s)...`);
  let index = 0;
  let done = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (index < targets.length) {
      const target = targets[index++]!;
      const { ad, post } = target;
      try {
        const url = await getPreviewUrl(ad.preview!.lineItemId, ad.preview!.creativeId, post.url);
        map.set(previewKey(ad.id, post.url), url);
      } catch (err) {
        failed++;
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `  ✗ preview failed for ${ad.label} on ${post.date}: ${reason}\n` +
            `    falling back to static queryParams for this job`,
        );
      }
      done++;
      if (done % 10 === 0 || done === targets.length) {
        console.log(`  ${done}/${targets.length}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()),
  );

  console.log(
    `Generated ${map.size}/${targets.length} preview URL(s)${failed ? `, ${failed} failed` : ""}`,
  );
  return map;
}
