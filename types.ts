export interface Post {
  url: string;
  date: string;
}

export interface AdPreview {
  lineItemId: string;
  creativeId: string;
}

export interface Ad {
  id: string;
  label: string;
  viewport: { width: number; height: number };
  width: number;
  height: number;
  queryParams: Record<string, string>;
  startDate: string;
  endDate: string;
  campaign?: string;
  preview?: AdPreview;
  referenceAssetUrl?: string;
}

export interface DateRange {
  start: string;
  end: string;
}

export interface PostSource {
  type: "wordpress";
  apiUrl: string;
  category: string | string[];
  dateRange: DateRange;
  perPage?: number;
}

export interface Config {
  postSource: PostSource;
  orderId: string;
  outputDir: string;
  format: "png" | "jpeg";
  timeout: number;
  pollTimeout: number;
  scrollTimeout: number;
  viewport: { width: number; height: number };
  concurrency: number;
  sizeTolerance: number;
  compression: number;
  jpegQuality: number;
  headless: boolean;
  combineMatchingAds?: boolean;
  dfp?: {
    networkCode: string;
    adUnitPrefix: string;
    maxWaitMs: number;
    minInkStdDev: number;
  };
  cropToAd?: boolean;
}

export interface CaptureJob {
  url: string;
  post: Post;
  ad: Ad;
  ads: Ad[];
}

export interface ServedCreative {
  slot: string;
  adUnitPath?: string;
  size?: string;
  creativeId?: string;
  lineItemId?: string;
  empty: boolean;
}

export interface CaptureResult {
  job: CaptureJob;
  success: boolean;
  error?: string;
  screenshotPath?: string;
  eventReceived: boolean;
  gptPresent: boolean;
  servedCreatives: ServedCreative[];
  creativeMatched: boolean;
  creativeMatchedBy: "creative-id" | "preview-slot" | "ink" | "none";
  capturedSize?: string;
  timestamp: string;
}
