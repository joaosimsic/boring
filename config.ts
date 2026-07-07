import type { Config } from "./types";

export async function loadConfig(path: string = "./config.json"): Promise<Config> {
  const file = Bun.file(path);
  const raw = await file.json() as Record<string, unknown>;

  if (!raw.posts || !Array.isArray(raw.posts)) throw new Error("posts must be an array");
  if (!raw.ads || !Array.isArray(raw.ads)) throw new Error("ads must be an array");

  const config: Config = {
    posts: raw.posts as Config["posts"],
    ads: raw.ads as Config["ads"],
    outputDir: (raw.outputDir as string | undefined) ?? "./screenshots",
    format: (raw.format as Config["format"] | undefined) ?? "png",
    timeout: (raw.timeout as number | undefined) ?? 30000,
    pollTimeout: (raw.pollTimeout as number | undefined) ?? 15000,
    viewport: (raw.viewport as Config["viewport"] | undefined) ?? { width: 1920, height: 1080 },
    concurrency: (raw.concurrency as number | undefined) ?? 3,
    sizeTolerance: (raw.sizeTolerance as number | undefined) ?? 0,
  };

  if (config.format !== "png" && config.format !== "jpeg") {
    throw new Error("format must be 'png' or 'jpeg'");
  }

  const envTolerance = Bun.env.AD_SIZE_TOLERANCE;
  if (envTolerance) {
    config.sizeTolerance = parseInt(envTolerance, 10);
  }

  return config;
}
