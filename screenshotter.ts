import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  Config,
  CaptureJob,
  CaptureResult,
  ServedCreative,
  Ad,
} from "./types";
import { GPT_INJECT_SCRIPT } from "./inject";
import { getBrowser } from "./browser";
import sharp from "sharp";
import type { Page } from "playwright";

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

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
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

export interface AdFrame {
  id: string;
  width: number;
  height: number;
  ours: boolean;
}

export function selectFrame(
  frames: Array<AdFrame & { drift: number }>,
  prefix?: string,
): AdFrame | null {
  if (frames.length === 0) return null;
  const best = frames.sort(
    (a, b) => Number(b.ours) - Number(a.ours) || a.drift - b.drift,
  )[0]!;
  return { id: best.id, width: best.width, height: best.height, ours: best.ours };
}

export async function findAdFrame(
  page: Page,
  width: number,
  height: number,
  prefix?: string,
): Promise<AdFrame | null> {
  const frames = await page.evaluate(
    (opts: { w: number; h: number; prefix?: string }) => {
      const all = Array.from(
        document.querySelectorAll<HTMLIFrameElement>("iframe[id^='google_ads_iframe']"),
      );
      return all
        .map((f) => {
          const r = f.getBoundingClientRect();
          return {
            id: f.id,
            width: Math.round(r.width),
            height: Math.round(r.height),
            ours: opts.prefix ? f.id.includes(opts.prefix) : false,
          };
        })
        .filter((f) => f.width > 0 && f.height > 0)
        .map((f) => ({
          ...f,
          drift: Math.abs(f.width - opts.w) + Math.abs(f.height - opts.h),
        }))
        .filter((f) => f.drift <= 4);
    },
    { w: width, h: height, prefix },
  );

  return selectFrame(frames, prefix);
}

export async function inkStdDev(buffer: Buffer): Promise<number> {
  const { data } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]!;
  const mean = sum / data.length;
  let variance = 0;
  for (let i = 0; i < data.length; i++) variance += (data[i]! - mean) ** 2;
  return Math.sqrt(variance / data.length);
}

async function readEvents(page: Page): Promise<ServedCreative[]> {
  return page.evaluate(() => {
    const raw = ((window as any).__gptEvents ?? []) as any[];
    return raw.map((ev) => ({
      slot: ev.slot ?? "unknown",
      adUnitPath: ev.adUnitPath ? String(ev.adUnitPath) : undefined,
      size: ev.size ? String(ev.size) : undefined,
      creativeId: ev.creativeId == null ? undefined : String(ev.creativeId),
      lineItemId: ev.lineItemId == null ? undefined : String(ev.lineItemId),
      empty: Boolean(ev.isEmpty),
    }));
  });
}

async function autoScroll(page: Page, budgetMs: number): Promise<void> {
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
    }, Date.now() + budgetMs),
    budgetMs + 10000,
    "auto-scroll",
  );
}

export async function captureJob(job: CaptureJob, config: Config): Promise<CaptureResult> {
  const timestamp = new Date().toISOString();
  const viewport = job.ads?.[0]?.viewport ?? job.ad.viewport ?? config.viewport;

  let eventReceived = false;
  let gptPresent = false;
  let success = true;
  let error: string | undefined;
  let screenshotPath: string | undefined;
  let servedCreatives: ServedCreative[] = [];
  let creativeMatched = false;
  let creativeMatchedBy: CaptureResult["creativeMatchedBy"] = "none";
  let capturedSize: string | undefined;
  let screenshotBuffer: Buffer | undefined;

  let context: Awaited<ReturnType<Awaited<ReturnType<typeof getBrowser>>["newContext"]>> | null =
    null;
  let page: Page | null = null;

  try {
    const browser = await getBrowser(config.headless);
    context = await browser.newContext({
      viewport,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
    page.setDefaultTimeout(config.timeout);
    await page.addInitScript(GPT_INJECT_SCRIPT);

    console.log(`  → navigating to ${job.post.url.split("/").pop()}`);
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: config.timeout });
    await page.waitForLoadState("load", { timeout: config.timeout }).catch(() => {});

    console.log(`  → auto-scrolling page`);
    await autoScroll(page, config.scrollTimeout);
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const requested = job.ads
      .map((a: Ad) => a.queryParams.creativeId)
      .filter((v): v is string => typeof v === "string" && v.length > 0);

    const width = job.ad.width;
    const height = job.ad.height;
    const prefix = config.dfp?.adUnitPrefix;
    const maxWait = config.dfp?.maxWaitMs ?? 45000;
    const minInk = config.dfp?.minInkStdDev ?? 8;
    const crop = config.cropToAd ?? true;
    const label = job.ads.map((a) => `${a.width}x${a.height} (${a.id})`).join(", ");

    console.log(
      `  → waiting up to ${maxWait}ms for a ${width}x${height} ad [${label}]` +
        `${prefix ? ` in ${prefix}` : ""}`,
    );

    const deadline = Date.now() + maxWait;
    let frame: AdFrame | null = null;
    let hasInk = false;
    let assetMatch = false;
    let bestDifference: number | null = null;

    const reference = job.ad.referenceAssetUrl
      ? await fetch(job.ad.referenceAssetUrl)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((b) => (b ? Buffer.from(b) : null))
          .catch(() => null)
      : null;

    while (true) {
      servedCreatives = await readEvents(page);
      const filled = servedCreatives.filter((ev) => !ev.empty);
      const wantedSize = `${width},${height}`;

      const byCreativeId =
        requested.length > 0 &&
        filled.some((ev) => {
          if (!requested.includes(ev.creativeId ?? "")) return false;
          return !ev.size || ev.size === wantedSize;
        });

      const previewSlot = prefix
        ? filled.find(
            (ev) =>
              (ev.adUnitPath ?? "").includes(prefix) && ev.size === wantedSize,
          )
        : undefined;

      frame = await findAdFrame(page, width, height, prefix);

      hasInk = false;
      assetMatch = false;
      if (frame) {
        const shot = await page
          .locator(`iframe[id="${frame.id}"]`)
          .screenshot({ timeout: 10000 })
          .catch(() => null);
        if (shot) {
          hasInk = (await inkStdDev(shot)) >= minInk;
          if (reference) {
            const cmp = await imagesMatch(shot, reference);
            assetMatch = cmp.match;
            bestDifference = cmp.difference;
          }
        }
      }

      if (byCreativeId || (previewSlot && hasInk && (reference ? assetMatch : true))) {
        eventReceived = true;
        creativeMatched = true;
        creativeMatchedBy = byCreativeId ? "creative-id" : "preview-slot";
        break;
      }
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(2000);
    }

    if (creativeMatched) {
      console.log(
        `  ✓ ad detected by ${creativeMatchedBy}` +
          (creativeMatchedBy === "preview-slot"
            ? ` (null creativeId${reference ? `, asset diff ${bestDifference?.toFixed(1)}` : ""})`
            : ""),
      );
    } else {
      if (reference && bestDifference !== null) {
        console.log(
          `  ⚠ closest frame differs from the creative asset by ${bestDifference.toFixed(1)} ` +
            `(tolerance 18) — this is a different ad`,
        );
      }
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
      const filled = servedCreatives.filter((ev) => !ev.empty);
      console.log(`  ⚠ requested creative not detected (gptPresent: ${gptPresent})`);
      if (filled.length > 0) {
        console.warn(`  ⚠ requested ${requested.join(", ") || "(none)"}, served instead:`);
        for (const ev of filled) {
          console.warn(
            `      ${ev.slot} adUnit=${ev.adUnitPath ?? "?"} size=${ev.size ?? "?"} ` +
              `creativeId=${ev.creativeId ?? "null"} lineItemId=${ev.lineItemId ?? "null"}`,
          );
        }
      } else {
        console.warn(`  ⚠ no non-empty ad slots rendered at all`);
      }
    }

    if (crop && frame) {
      const buf = await page
        .locator(`iframe[id="${frame.id}"]`)
        .screenshot({ timeout: config.timeout });
      screenshotBuffer = await encode(buf, config);
      capturedSize = `${frame.width}x${frame.height}`;
      console.log(`  → cropped to ad slot ${capturedSize}`);
    } else {
      if (crop && !frame) {
        console.log(`  → no ${width}x${height} ad frame found; capturing the full page`);
      }
      screenshotBuffer = await encode(
        await page.screenshot({
          fullPage: true,
          type: config.format === "jpeg" ? "jpeg" : "png",
          ...(config.format === "jpeg" ? { quality: config.jpegQuality } : {}),
          timeout: config.timeout,
        }),
        config,
      );
    }
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${error}`);
  } finally {
    if (page) await withTimeout(page.close(), 10000, "page.close").catch(() => {});
    if (context) await withTimeout(context.close(), 10000, "context.close").catch(() => {});
  }

  if (screenshotBuffer) {
    const outputPath = buildOutputPath(job, config);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await Bun.write(outputPath, screenshotBuffer);
    screenshotPath = outputPath;
    console.log(`  ✓ saved: ${outputPath}`);
  }

  return {
    job,
    success,
    error,
    screenshotPath,
    eventReceived,
    gptPresent,
    servedCreatives,
    creativeMatched,
    creativeMatchedBy,
    capturedSize,
    timestamp,
  };
}

async function encode(buffer: Buffer, config: Config): Promise<Buffer> {
  if (config.format === "jpeg") {
    return sharp(buffer).jpeg({ quality: config.jpegQuality }).toBuffer();
  }
  if (config.compression > 0) {
    return sharp(buffer)
      .png({ compressionLevel: Math.min(config.compression, 9) })
      .toBuffer();
  }
  return buffer;
}

export async function imagesMatch(
  candidate: Buffer,
  reference: Buffer,
  tolerance = 18,
): Promise<{ match: boolean; difference: number }> {
  const norm = async (buf: Buffer) =>
    sharp(buf)
      .resize(32, 32, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();

  const [a, b] = await Promise.all([norm(candidate), norm(reference)]);
  if (a.length !== b.length) return { match: false, difference: 255 };

  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
  const difference = total / a.length;
  return { match: difference <= tolerance, difference };
}

export function isTransient(error?: string): boolean {
  if (!error) return false;
  return /has been closed|Target closed|Protocol error|ECONNRESET|browser has disconnected/i.test(
    error,
  );
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
      let result = await captureJob(job, config);
      if (!result.success && isTransient(result.error)) {
        console.log(`  ↻ retrying after transient failure: ${result.error}`);
        result = await captureJob(job, config);
      }
      results.push(result);
      done++;
      if (result.success) ok++;
      else fail++;
      const status = result.success ? "OK" : "FAIL";
      const flag = result.creativeMatched ? "✓" : "⚠";
      const label = job.ads.map((a) => a.label).join("+");
      console.log(
        `  [${done}/${total}] ${status} ${flag} ${label} → ${result.screenshotPath ?? "n/a"}`,
      );
    }
  }

  const workerCount = Math.min(concurrency, queue.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  console.log(`\nResults: ${ok} succeeded, ${fail} failed out of ${total} jobs`);
  return results;
}

export { processJobs };