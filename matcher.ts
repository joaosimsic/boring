import type { Post, Ad, CaptureJob } from "./types";

export function matchAds(posts: Post[], ads: Ad[]): CaptureJob[] {
  const jobs: CaptureJob[] = [];

  for (const post of posts) {
    const matched = ads.filter((ad) => post.date >= ad.startDate && post.date <= ad.endDate);

    if (matched.length === 0) {
      console.warn(`[warn] No matching ads for post: ${post.url} (${post.date})`);
      continue;
    }

    for (const ad of matched) {
      const params = new URLSearchParams(ad.queryParams).toString();
      const separator = post.url.includes("?") ? "&" : "?";
      const url = `${post.url}${separator}${params}`;
      jobs.push({ url, post, ad });
    }
  }

  return jobs;
}
