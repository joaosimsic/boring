import type { Post, Ad, CaptureJob } from "./types";

export function matchAds(
  posts: Post[],
  ads: Ad[],
  combineMatchingAds = true,
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
      const separator = post.url.includes("?") ? "&" : "?";
      const url = `${post.url}${separator}${combined.toString()}`;
      jobs.push({ url, post, ad: matched[0]!, ads: matched });
    } else {
      for (const ad of matched) {
        const params = new URLSearchParams(ad.queryParams).toString();
        const separator = post.url.includes("?") ? "&" : "?";
        const url = `${post.url}${separator}${params}`;
        jobs.push({ url, post, ad, ads: [ad] });
      }
    }
  }

  return jobs;
}
