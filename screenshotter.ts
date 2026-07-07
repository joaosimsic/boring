import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, CaptureJob, CaptureResult } from "./types";
import { GPT_INJECT_SCRIPT } from "./inject";
import { getBrowser } from "./browser";

export function buildOutputPath(job: CaptureJob, config: Config): string {
  const [yyyy, mm, dd] = job.post.date.split("-");
  return `${config.outputDir}/${job.ad.id}/${dd}-${mm}-${yyyy}.${config.format}`;
}

export async function captureJob(job: CaptureJob, config: Config): Promise<CaptureResult> {
  const timestamp = new Date().toISOString();
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: config.viewport,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.timeout);

  let eventReceived = false;
  let gptPresent = false;
  let success = true;
  let error: string | undefined;
  let screenshotPath: string | undefined;

  try {
    await page.addInitScript(GPT_INJECT_SCRIPT);

    console.log(`  → navigating to ${job.post.url.split("/").pop()}`);
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: config.timeout });

    console.log(`  → waiting for GPT event (${job.ad.width}x${job.ad.height})`);
    try {
      await page.waitForFunction(
        (opts: { width: number; height: number; tolerance: number }) => {
          const events = (window as any).__gptEvents ?? [];
          return events.some(
            (ev: any) =>
              ev.size != null &&
              Math.abs(ev.size[0] - opts.width) <= opts.tolerance &&
              Math.abs(ev.size[1] - opts.height) <= opts.tolerance,
          );
        },
        { width: job.ad.width, height: job.ad.height, tolerance: config.sizeTolerance },
        { timeout: config.pollTimeout, polling: 200 },
      );
      eventReceived = true;
      console.log(`  ✓ GPT event received`);
    } catch {
      try {
        gptPresent = await page.evaluate(
          () =>
            typeof (window as any).googletag !== "undefined" &&
            (window as any).googletag !== null,
        );
      } catch {}
      console.log(`  ⚠ GPT event timeout (gptPresent: ${gptPresent})`);
    }

    console.log(`  → taking screenshot`);
    const format = config.format === "jpeg" ? "jpeg" : "png";
    const screenshotBuffer = await page.screenshot({ fullPage: true, type: format });

    const outputPath = buildOutputPath(job, config);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, screenshotBuffer);
    screenshotPath = outputPath;
    console.log(`  ✓ saved: ${outputPath}`);
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${error}`);
  } finally {
    await page.close();
    await context.close();
  }

  return { job, success, error, screenshotPath, eventReceived, gptPresent, timestamp };
}

async function processJobs(
  jobs: CaptureJob[],
  config: Config,
  concurrency: number,
): Promise<CaptureResult[]> {
  const results: CaptureResult[] = [];
  const queue = [...jobs];
  const total = queue.length;
  let done = 0;
  let ok = 0;
  let fail = 0;

  async function worker() {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      const result = await captureJob(job, config);
      results.push(result);
      done++;
      if (result.success) ok++;
      else fail++;
      const event = result.eventReceived ? "✓" : "⚠";
      const status = result.success ? "OK" : "FAIL";
      console.log(`  [${done}/${total}] ${status} ${event} ${job.ad.label} → ${result.screenshotPath ?? "n/a"}`);
    }
  }

  const workerCount = Math.min(concurrency, queue.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  console.log(`\nResults: ${ok} succeeded, ${fail} failed out of ${total} jobs`);
  return results;
}

export { processJobs };
