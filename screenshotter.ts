import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, CaptureJob, CaptureResult } from "./types";
import { GPT_INJECT_SCRIPT } from "./inject";
import { getBrowser } from "./browser";
import sharp from "sharp";

export function buildOutputPath(job: CaptureJob, config: Config): string {
  const [yyyy, mm, dd] = job.post.date.split("-");
  const campaign = job.ad.campaign ?? job.ads.find((a) => a.campaign)?.campaign;
  if (campaign) {
    const slug = campaign
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-_]/g, "");
    if (job.ads.length === 1) {
      const ad = job.ad;
      return `${config.outputDir}/${slug}/${ad.width}x${ad.height}-${ad.id}-${dd}-${mm}-${yyyy}.${config.format}`;
    }
    const ids = job.ads.map((a) => a.id).join("+");
    const sizes = job.ads.map((a) => `${a.width}x${a.height}`).join("+");
    return `${config.outputDir}/${slug}/${sizes}-${ids}-${dd}-${mm}-${yyyy}.${config.format}`;
  }
  const ids = job.ads?.length ? job.ads.map((a) => a.id).join("+") : job.ad.id;
  return `${config.outputDir}/${ids}/${dd}-${mm}-${yyyy}.${config.format}`;
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function captureJob(job: CaptureJob, config: Config): Promise<CaptureResult> {
  const timestamp = new Date().toISOString();
  const browser = await getBrowser(config.headless);
  const viewport = job.ads?.[0]?.viewport ?? job.ad.viewport ?? config.viewport;
  const context = await browser.newContext({
    viewport,
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
    await withTimeout(
      page.evaluate(async (deadline: number) => {
        await new Promise<void>((resolve) => {
          let maxScroll = document.body.scrollHeight;
          const step = 400;
          const timer = setInterval(() => {
            window.scrollBy(0, step);
            const cur = window.scrollY + window.innerHeight;
            const sh = document.body.scrollHeight;
            if ((cur >= maxScroll && sh <= maxScroll + 50) || Date.now() >= deadline) {
              clearInterval(timer);
              resolve();
            } else if (sh > maxScroll) {
              maxScroll = sh;
            }
          }, 200);
        });
      }, Date.now() + config.scrollTimeout),
      config.timeout,
      "auto-scroll",
    );
    await page.waitForTimeout(500);

    // scroll back to top for full-page screenshot
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const adDesc = job.ads.map((a) => `${a.width}x${a.height} (${a.id})`).join(", ");
    console.log(`  → waiting ${config.pollTimeout}ms for GPT events [${adDesc}]`);

    await page.waitForTimeout(config.pollTimeout);

    try {
      const creativeIds = job.ads
        .map((a) => a.queryParams.creativeId)
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      eventReceived = await withTimeout(
        page.evaluate(
          (opts: { creativeIds: string[] }) => {
            const events = (window as any).__gptEvents ?? [];
            if (opts.creativeIds.length === 0) {
              return events.some((ev: any) => !ev.isEmpty);
            }
            return opts.creativeIds.every((id) =>
              events.some(
                (ev: any) => !ev.isEmpty && String(ev.creativeId) === id,
              ),
            );
          },
          { creativeIds },
        ),
        config.timeout,
        "gpt-event-check",
      );
    } catch {}

    if (eventReceived) {
      console.log(`  ✓ GPT event received`);
    } else {
      try {
        gptPresent = await withTimeout(
          page.evaluate(
            () =>
              typeof (window as any).googletag !== "undefined" &&
              (window as any).googletag !== null,
          ),
          config.timeout,
          "gpt-present-check",
        );
      } catch {}
      console.log(`  ⚠ GPT event timeout (gptPresent: ${gptPresent})`);
    }

    if (eventReceived) {
      console.log(`  → waiting for ad creative to render`);
      await page.waitForTimeout(1000);
    }

    console.log(`  → taking screenshot`);
    let screenshotBuffer: Buffer;

    if (config.format === "jpeg") {
      screenshotBuffer = await page.screenshot({
        fullPage: true,
        type: "jpeg",
        quality: config.jpegQuality,
        timeout: config.timeout,
      });
    } else {
      screenshotBuffer = await page.screenshot({
        fullPage: true,
        type: "png",
        timeout: config.timeout,
      });
      if (config.compression > 0) {
        screenshotBuffer = await sharp(screenshotBuffer)
          .png({ compressionLevel: Math.min(config.compression, 9) })
          .toBuffer();
      }
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
    await withTimeout(page.close(), 10000, "page.close").catch(() => {});
    await withTimeout(context.close(), 10000, "context.close").catch(() => {});
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
      const label = job.ads.map((a) => a.label).join("+");
      console.log(`  [${done}/${total}] ${status} ${event} ${label} → ${result.screenshotPath ?? "n/a"}`);
    }
  }

  const workerCount = Math.min(concurrency, queue.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  console.log(`\nResults: ${ok} succeeded, ${fail} failed out of ${total} jobs`);
  return results;
}

export { processJobs };
