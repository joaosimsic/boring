import type { Post, Ad, CaptureJob } from "./types";

export type PreviewUrlMap = Map<string, string>;

export function previewKey(adId: string, postUrl: string): string {
  return `${adId}|${postUrl}`;
}

function spliceParams(postUrl: string, params: URLSearchParams): string {
  const separator = postUrl.includes("?") ? "&" : "?";
  return `${postUrl}${separator}${params.toString()}`;
}

function jobUrl(post: Post, ad: Ad, previewUrls?: PreviewUrlMap): string {
  const generated = previewUrls?.get(previewKey(ad.id, post.url));
  if (generated) return generated;
  return spliceParams(post.url, new URLSearchParams(ad.queryParams));
}

export function matchAds(
  posts: Post[],
  ads: Ad[],
  combineMatchingAds = true,
  previewUrls?: PreviewUrlMap,
): CaptureJob[] {
  const jobs: CaptureJob[] = [];

  for (const post of posts) {
    const matched = ads.filter((ad) => post.date >= ad.startDate && post.date <= ad.endDate);

    if (matched.length === 0) {
      console.warn(`[warn] No matching ads for post: ${post.url} (${post.date})`);
      continue;
    }

    if (combineMatchingAds && matched.length > 1) {
      const combined = new URLSearchParams();
      const perCreativeKeys = new Set(["google_preview", "lineItemId", "creativeId"]);
      for (const ad of matched) {
        for (const [k, v] of Object.entries(ad.queryParams)) {
          if (perCreativeKeys.has(k)) {
            combined.append(k, v);
          } else {
            const existing = combined.getAll(k);
            if (existing.includes(v)) continue;
            combined.append(k, v);
          }
        }
      }
      const url = spliceParams(post.url, combined);
      jobs.push({ url, post, ad: matched[0]!, ads: matched });
    } else {
      for (const ad of matched) {
        jobs.push({ url: jobUrl(post, ad, previewUrls), post, ad, ads: [ad] });
      }
    }
  }

  return jobs;
}
