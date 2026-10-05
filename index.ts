#!/usr/bin/env bun

import { loadConfig } from "./config";
import { fetchPostsFromWordPress } from "./wordpress";
import { matchAds } from "./matcher";
import { buildOutputPath, processJobs } from "./screenshotter";
import { closeBrowser } from "./browser";
import { dfpConfigured } from "./dfp";
import { resolvePreviewUrls, runPreflight } from "./preview";
import { discoverAds, formatSkipped } from "./discover";

const args = Bun.argv.slice(2);
let configPath = "./config.json";
let dryRun = false;
let outputDir: string | null = null;
let maxCreatives = 0;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--config" && i + 1 < args.length) {
    configPath = args[++i]!;
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "--output" && i + 1 < args.length) {
    outputDir = args[++i]!;
  } else if (arg === "--max-creatives" && i + 1 < args.length) {
    maxCreatives = Number.parseInt(args[++i]!, 10) || 0;
  }
}

async function main() {
  const config = await loadConfig(configPath);

  if (outputDir) {
    config.outputDir = outputDir;
  }

  if (!dfpConfigured()) {
    console.error(
      "Ad Manager credentials are not configured, so line items cannot be discovered.\n" +
        "Set DFP_NETWORK_CODE plus either DFP_SERVICE_ACCOUNT_JSON or " +
        "DFP_CLIENT_ID/DFP_CLIENT_SECRET/DFP_REFRESH_TOKEN.",
    );
    process.exit(1);
  }

  console.log(`Discovering creatives in order ${config.orderId}...`);
  const discovery = await discoverAds(config.orderId, config, { maxCreatives });
  console.log(
    `Found ${discovery.ads.length} creative(s) across ${discovery.lineItemsSeen} line item(s).`,
  );
  for (const ad of discovery.ads) {
    console.log(
      `  ${ad.campaign ?? "?"} · ${ad.width}x${ad.height} · ${ad.id} ` +
        `(${ad.preview?.lineItemId}) ${ad.startDate} → ${ad.endDate}`,
    );
  }
  if (discovery.truncated) {
    console.warn(
      "[warn] The Ad Manager statement returned fewer line items than it reported; " +
        "some line items in this order were not examined.",
    );
  }
  if (discovery.skipped.length > 0) {
    console.log(`\nSkipped ${discovery.skipped.length}:`);
    for (const line of formatSkipped(discovery.skipped)) {
      console.log(`  · ${line}`);
    }
  }

  if (discovery.ads.length === 0) {
    console.error("\nNo capturable creatives were discovered. Nothing to do.");
    process.exit(1);
  }

  console.log(`\nFetching posts from ${config.postSource.apiUrl}...`);
  const posts = await fetchPostsFromWordPress(config.postSource);
  console.log(`Got ${posts.length} post(s) (one per day):`);
  for (const post of posts) {
    console.log(`  ${post.date} ${post.url}`);
  }
  console.log("");

  const reports = await runPreflight(discovery.ads);
  const failing = reports.filter((r) => !r.ok);
  if (failing.length > 0) {
    console.warn(
      `\n⚠ Preflight found blocking problems for ${failing.length} creative(s); ` +
        "they will be skipped and the rest still captured.",
    );
    const capturable = new Set(
      reports.filter((r) => r.ok).map((r) => r.adId),
    );
    discovery.ads = discovery.ads.filter((ad) => capturable.has(ad.id));
    if (discovery.ads.length === 0) {
      console.error("Every discovered creative failed preflight. Nothing to capture.");
      process.exit(1);
    }
  }

  const previewUrls = await resolvePreviewUrls(posts, discovery.ads, config.concurrency);
  const jobs = matchAds(posts, discovery.ads, config.combineMatchingAds ?? true, previewUrls);

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
    orderId: config.orderId,
    total: results.length,
    skipped: discovery.skipped,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    creativeMatched: results.filter((r) => r.creativeMatched).length,
    creativeMismatched: results.filter((r) => r.success && !r.creativeMatched).length,
    results: results.map((r) => ({
      url: r.job.url,
      post: r.job.post.url,
      ad: r.job.ads.map((a) => a.id).join("+"),
      ads: r.job.ads.map((a) => a.id),
      success: r.success,
      eventReceived: r.eventReceived,
      gptPresent: r.gptPresent,
      creativeMatched: r.creativeMatched,
      creativeMatchedBy: r.creativeMatchedBy,
      capturedSize: r.capturedSize,
      servedCreatives: r.servedCreatives,
      screenshotPath: r.screenshotPath,
      error: r.error,
      timestamp: r.timestamp,
    })),
  };

  const mismatched = results.filter((r) => r.success && !r.creativeMatched);
  if (mismatched.length > 0) {
    console.warn(
      `\n⚠ ${mismatched.length}/${results.length} screenshot(s) were saved but did NOT show the ` +
        `requested creative. See servedCreatives in summary.json.`,
    );
  }

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
