export interface Post {
  url: string;
  date: string;
}

export interface Ad {
  id: string;
  label: string;
  width: number;
  height: number;
  queryParams: Record<string, string>;
  startDate: string;
  endDate: string;
}

export interface Config {
  posts: Post[];
  ads: Ad[];
  outputDir: string;
  format: "png" | "jpeg";
  timeout: number;
  pollTimeout: number;
  viewport: { width: number; height: number };
  concurrency: number;
  sizeTolerance: number;
}

export interface CaptureJob {
  url: string;
  post: Post;
  ad: Ad;
}

export interface CaptureResult {
  job: CaptureJob;
  success: boolean;
  error?: string;
  screenshotPath?: string;
  eventReceived: boolean;
  gptPresent: boolean;
  timestamp: string;
}
