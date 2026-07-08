import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, CaptureJob, CaptureResult } from "./types";
import { GPT_INJECT_SCRIPT } from "./inject";
import { getBrowser } from "./browser";
import sharp from "sharp";

export function buildOutputPath(job: CaptureJob, config: Config): string {
  const [yyyy, mm, dd] = job.post.date.split("-");
  return `${config.outputDir}/${job.ad.id}/${dd}-${mm}-${yyyy}.${config.format}`;
}

export async function captureJob(job: CaptureJob, config: Config): Promise<CaptureResult> {
  const timestamp = new Date().toISOString();
  const browser = await getBrowser(config.headless);
  const context = await browser.newContext({
    viewport: job.ad.viewport,
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
    await page.waitForLoadState("load", { timeout: config.timeout }).catch(() => {});

    // incremental auto-scroll to trigger all lazy-loaded content
    console.log(`  → auto-scrolling page`);
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let maxScroll = document.body.scrollHeight;
        const step = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          const cur = window.scrollY + window.innerHeight;
          const sh = document.body.scrollHeight;
          if (cur >= maxScroll && sh <= maxScroll + 50) {
            clearInterval(timer);
            resolve();
          }
          if (sh > maxScroll) maxScroll = sh;
        }, 200);
      });
    });
    await page.waitForTimeout(500);

    // scroll back to top for full-page screenshot
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    console.log(`  → waiting ${config.pollTimeout}ms for GPT event (${job.ad.width}x${job.ad.height})`);

    await page.waitForTimeout(config.pollTimeout);

    try {
      eventReceived = await page.evaluate(
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
      );
    } catch {}

    if (eventReceived) {
      console.log(`  ✓ GPT event received`);
    } else {
      try {
        gptPresent = await page.evaluate(
          () =>
            typeof (window as any).googletag !== "undefined" &&
            (window as any).googletag !== null,
        );
      } catch {}
      console.log(`  ⚠ GPT event timeout (gptPresent: ${gptPresent})`);
    }

    if (eventReceived) {
      console.log(`  → waiting for ad creative to render`);
      await page.waitForTimeout(1000);
    }

    console.log(`  → taking screenshot`);
    const format = config.format === "jpeg" ? "jpeg" : "png";
    let screenshotBuffer = await page.screenshot({ fullPage: true, type: format });

    if (config.compression > 0) {
      screenshotBuffer = await sharp(screenshotBuffer)
        .png({ compressionLevel: Math.min(config.compression, 9) })
        .toBuffer();
    }

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
