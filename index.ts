import { loadConfig } from "./config";
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

  const jobs = matchAds(config.posts, config.ads);

  if (jobs.length === 0) {
    console.log("No matching jobs to process.");
    return;
  }

  console.log(`Found ${jobs.length} capture job(s):\n`);

  for (const job of jobs) {
    const outputPath = buildOutputPath(job, config);
    console.log(`  ${job.ad.label} → ${job.url}`);
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
      ad: r.job.ad.id,
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

  await closeBrowser();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
