import { test, expect, describe } from "bun:test";
import { matchAds } from "./matcher";
import { buildOutputPath } from "./screenshotter";
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
  posts,
  ads,
  outputDir: "./screenshots",
  format: "png",
  timeout: 30000,
  pollTimeout: 15000,
  viewport: { width: 1920, height: 1080 },
  concurrency: 3,
  sizeTolerance: 0,
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
});

describe("buildOutputPath", () => {
  test("builds correct path from job and config", () => {
    const job: CaptureJob = {
      url: "https://example.com/sports/article-1?campaign=bmw&ad_type=leaderboard",
      post: posts[0]!,
      ad: ads[0]!,
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
    };
    const result = buildOutputPath(job, config);
    expect(result).toBe(
      "./screenshots/bmw-leaderboard/15-06-2026.png",
    );
  });
});
