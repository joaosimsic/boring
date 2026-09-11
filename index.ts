#!/usr/bin/env bun

import { loadConfig } from "./config";
import { fetchPostsFromWordPress } from "./wordpress";
import { matchAds } from "./matcher";
import { buildOutputPath, processJobs } from "./screenshotter";
import { closeBrowser } from "./browser";

const args = Bun.argv.slice(2);
let configPath = "./config.json";
let dryRun = false;
let outputDir: string | null = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--config" && i + 1 < args.length) {
    configPath = args[++i]!;
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--output" && i + 1 < args.length) {
    outputDir = args[++i]!;
  }
}

async function main() {
  const config = await loadConfig(configPath);

  if (outputDir) {
    config.outputDir = outputDir;
  }

  console.log(`Fetching posts from ${config.postSource.apiUrl}...`);
  const posts = await fetchPostsFromWordPress(config.postSource);
  console.log(`Got ${posts.length} post(s) (one per day):`);
  for (const post of posts) {
    console.log(`  ${post.date} ${post.url}`);
  }
  console.log("");

  const jobs = matchAds(posts, config.ads, config.combineMatchingAds ?? true);

  if (jobs.length === 0) {
    console.log("No matching jobs to process.");
    return;
  }

  console.log(`Found ${jobs.length} capture job(s):\n`);

  for (const job of jobs) {
    const outputPath = buildOutputPath(job, config);
    const label = job.ads.map((a) => a.label).join("+");
    console.log(`  ${label} → ${job.url}`);
    console.log(`    output: ${outputPath}`);
  }

  if (dryRun) {
    console.log("\nDry-run complete. No screenshots taken.");
    return;
  }

  console.log("\nStarting capture...");
  const results = await processJobs(jobs, config, config.concurrency);

  const summary = {
    timestamp: new Date().toISOString(),
    total: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results: results.map((r) => ({
      url: r.job.url,
      post: r.job.post.url,
      ad: r.job.ads.map((a) => a.id).join("+"),
      ads: r.job.ads.map((a) => a.id),
      success: r.success,
      eventReceived: r.eventReceived,
      gptPresent: r.gptPresent,
      screenshotPath: r.screenshotPath,
      error: r.error,
      timestamp: r.timestamp,
    })),
  };

  const summaryPath = `${config.outputDir}/summary.json`;
  await Bun.write(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nDone. Summary written to ${summaryPath}`);

  const hasCampaign = jobs.some((j) => j.ads.some((a) => a.campaign));
  if (hasCampaign) {
    const campaignSlugs = [
      ...new Set(
        jobs
          .map((j) => {
            const c = j.ad.campaign ?? j.ads.find((a) => a.campaign)?.campaign;
            return c
              ? c.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-_]/g, "")
              : null;
          })
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    for (const slug of campaignSlugs) {
      console.log(`  → zipping ${slug} → ${config.outputDir}/${slug}.zip`);
      await Bun.$`cd ${config.outputDir} && zip -r ${slug}.zip ${slug}`.quiet();
    }
  } else {
    const adIds = [...new Set(jobs.map((j) => j.ads.map((a) => a.id).join("+")))];
    for (const id of adIds) {
      console.log(`  → zipping ${id} → ${config.outputDir}/${id}.zip`);
      await Bun.$`cd ${config.outputDir} && zip -r ${id}.zip ${id}`.quiet();
    }
  }

  await closeBrowser();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
