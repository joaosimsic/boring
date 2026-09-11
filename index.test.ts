import { test, expect, describe } from "bun:test";
import { matchAds } from "./matcher";
import { buildOutputPath, withTimeout } from "./screenshotter";
import type { Post, Ad, Config, CaptureJob } from "./types";

const posts: Post[] = [
  { url: "https://example.com/sports/article-1", date: "2026-06-15" },
  { url: "https://example.com/tech/review", date: "2026-06-20" },
];

const ads: Ad[] = [
  {
    id: "bmw-leaderboard",
    label: "BMW Leaderboard",
    viewport: { width: 1920, height: 1080 },
    width: 728,
    height: 90,
    queryParams: { campaign: "bmw", ad_type: "leaderboard" },
    startDate: "2026-06-01",
    endDate: "2026-06-30",
  },
  {
    id: "audi-sidebar",
    label: "Audi Sidebar",
    viewport: { width: 1920, height: 1080 },
    width: 300,
    height: 250,
    queryParams: { campaign: "audi" },
    startDate: "2026-07-01",
    endDate: "2026-07-31",
  },
];

const config: Config = {
  postSource: {
    type: "wordpress",
    apiUrl: "https://example.com/wp-json/wp/v2",
    category: "news",
    dateRange: { start: "2026-06-01", end: "2026-07-31" },
  },
  ads,
  outputDir: "./screenshots",
  format: "png",
  timeout: 30000,
  pollTimeout: 15000,
  scrollTimeout: 20000,
  viewport: { width: 1920, height: 1080 },
  concurrency: 3,
  sizeTolerance: 0,
  compression: 5,
  jpegQuality: 80,
  headless: true,
};

describe("matchAds", () => {
  test("matches ads within date range", () => {
    const jobs = matchAds(posts, ads);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.ad.id).toBe("bmw-leaderboard");
    expect(jobs[1]!.ad.id).toBe("bmw-leaderboard");
  });

  test("appends query params to URL", () => {
    const jobs = matchAds(posts, ads);
    expect(jobs[0]!.url).toBe(
      "https://example.com/sports/article-1?campaign=bmw&ad_type=leaderboard",
    );
  });

  test("skips posts with no matching ads", () => {
    const outOfRangePost: Post[] = [
      { url: "https://example.com/old", date: "2025-01-01" },
    ];
    const jobs = matchAds(outOfRangePost, ads);
    expect(jobs).toHaveLength(0);
  });

  test("combines overlapping ads into single job with merged params", () => {
    const overlappingAds: Ad[] = [
      {
        id: "ad1",
        label: "Ad 1",
        viewport: { width: 1920, height: 1080 },
        width: 300,
        height: 250,
        queryParams: { google_preview: "aaa", creativeId: "111" },
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
      {
        id: "ad2",
        label: "Ad 2",
        viewport: { width: 1920, height: 1080 },
        width: 300,
        height: 250,
        queryParams: { google_preview: "bbb", creativeId: "222" },
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    ];
    const singlePost: Post[] = [{ url: "https://example.com/article", date: "2026-06-15" }];
    const jobs = matchAds(singlePost, overlappingAds, true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.ads).toHaveLength(2);
    expect(jobs[0]!.ads.map((a) => a.id)).toEqual(["ad1", "ad2"]);
    expect(jobs[0]!.url).toContain("creativeId=111");
    expect(jobs[0]!.url).toContain("creativeId=222");
    expect(jobs[0]!.url).toContain("google_preview=aaa");
    expect(jobs[0]!.url).toContain("google_preview=bbb");
  });

  test("creates separate jobs when combine disabled", () => {
    const overlappingAds: Ad[] = [
      {
        id: "ad1",
        label: "Ad 1",
        viewport: { width: 1920, height: 1080 },
        width: 300,
        height: 250,
        queryParams: { creativeId: "111" },
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
      {
        id: "ad2",
        label: "Ad 2",
        viewport: { width: 1920, height: 1080 },
        width: 300,
        height: 250,
        queryParams: { creativeId: "222" },
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    ];
    const singlePost: Post[] = [{ url: "https://example.com/article", date: "2026-06-15" }];
    const jobs = matchAds(singlePost, overlappingAds, false);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.ads).toHaveLength(1);
    expect(jobs[1]!.ads).toHaveLength(1);
  });
});

describe("buildOutputPath", () => {
  test("builds correct path from job and config", () => {
    const job: CaptureJob = {
      url: "https://example.com/sports/article-1?campaign=bmw&ad_type=leaderboard",
      post: posts[0]!,
      ad: ads[0]!,
      ads: [ads[0]!],
    };
    const result = buildOutputPath(job, config);
    expect(result).toBe(
      "./screenshots/bmw-leaderboard/15-06-2026.png",
    );
  });

  test("handles root path URLs", () => {
    const job: CaptureJob = {
      url: "https://example.com/?foo=bar",
      post: { url: "https://example.com/", date: "2026-06-15" },
      ad: ads[0]!,
      ads: [ads[0]!],
    };
    const result = buildOutputPath(job, config);
    expect(result).toBe(
      "./screenshots/bmw-leaderboard/15-06-2026.png",
    );
  });

  test("builds combined path for multiple ads", () => {
    const job: CaptureJob = {
      url: "https://example.com/sports/article-1?campaign=bmw&campaign=audi",
      post: posts[0]!,
      ad: ads[0]!,
      ads: [ads[0]!, ads[1]!],
    };
    const result = buildOutputPath(job, config);
    expect(result).toBe(
      "./screenshots/bmw-leaderboard+audi-sidebar/15-06-2026.png",
    );
  });
});

describe("withTimeout", () => {
  test("resolves when the promise settles first", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  test("rejects when the timeout fires first", async () => {
    const pending = new Promise<never>(() => {});
    const result = withTimeout(pending, 50, "test");
    expect(result).rejects.toThrow("test timed out after 50ms");
  });
});
