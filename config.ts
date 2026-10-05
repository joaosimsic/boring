import type { Config } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function loadConfig(path: string = "./config.json"): Promise<Config> {
  const file = Bun.file(path);
  const raw = await file.json() as Record<string, unknown>;

  if (typeof raw.orderId !== "string" || !/^\d+$/.test(raw.orderId)) {
    throw new Error(
      "orderId must be a numeric string (the Ad Manager order whose line items should be captured)",
    );
  }
  if (!raw.postSource || typeof raw.postSource !== "object") {
    throw new Error("postSource must be an object");
  }

  const postSource = raw.postSource as Record<string, unknown>;
  if (postSource.type !== "wordpress") throw new Error("postSource.type must be 'wordpress'");
  if (!postSource.apiUrl || typeof postSource.apiUrl !== "string") {
    throw new Error("postSource.apiUrl must be a string");
  }
  if (!postSource.category || typeof postSource.category !== "string" && !Array.isArray(postSource.category)) {
    throw new Error("postSource.category must be a string or array of strings");
  }

  const dateRange = postSource.dateRange as Record<string, unknown> | undefined;
  if (!dateRange || typeof dateRange !== "object") {
    throw new Error("postSource.dateRange must be an object");
  }
  for (const key of ["start", "end"]) {
    const value = dateRange[key];
    if (typeof value !== "string" || !DATE_RE.test(value)) {
      throw new Error(`postSource.dateRange.${key} must be a valid date (YYYY-MM-DD)`);
    }
  }

  const config: Config = {
    postSource: postSource as unknown as Config["postSource"],
    orderId: raw.orderId,
    outputDir: (raw.outputDir as string | undefined) ?? "./screenshots",
    format: (raw.format as Config["format"] | undefined) ?? "png",
    timeout: (raw.timeout as number | undefined) ?? 30000,
    pollTimeout: (raw.pollTimeout as number | undefined) ?? 15000,
    scrollTimeout: (raw.scrollTimeout as number | undefined) ?? 20000,
    viewport: (raw.viewport as Config["viewport"] | undefined) ?? { width: 1920, height: 1080 },
    concurrency: (raw.concurrency as number | undefined) ?? 3,
    sizeTolerance: (raw.sizeTolerance as number | undefined) ?? 0,
    compression: (raw.compression as number | undefined) ?? 5,
    jpegQuality: (raw.jpegQuality as number | undefined) ?? 80,
    headless: (raw.headless as boolean | undefined) ?? true,
    combineMatchingAds: (raw.combineMatchingAds as boolean | undefined) ?? true,
    dfp: raw.dfp as Config["dfp"],
    cropToAd: (raw.cropToAd as boolean | undefined) ?? true,
  };

  if (config.dfp) {
    const { adUnitPrefix, maxWaitMs, minInkStdDev } = config.dfp;
    if (adUnitPrefix !== undefined && typeof adUnitPrefix !== "string") {
      throw new Error("dfp.adUnitPrefix must be a string");
    }
    if (maxWaitMs !== undefined && (typeof maxWaitMs !== "number" || maxWaitMs <= 0)) {
      throw new Error("dfp.maxWaitMs must be a positive number");
    }
    if (minInkStdDev !== undefined && (typeof minInkStdDev !== "number" || minInkStdDev < 0)) {
      throw new Error("dfp.minInkStdDev must be a non-negative number");
    }
  }

  if (config.format !== "png" && config.format !== "jpeg") {
    throw new Error("format must be 'png' or 'jpeg'");
  }

  const envTolerance = Bun.env.AD_SIZE_TOLERANCE;
  if (envTolerance) {
    config.sizeTolerance = parseInt(envTolerance, 10);
  }

  return config;
}
