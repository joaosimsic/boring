import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;

export async function getBrowser(headless: boolean = true): Promise<Browser> {
  if (browser && browser.isConnected()) {
    return browser;
  }
  browser = null;
  {
    // Clean Nix-injected env that breaks Playwright's bundled Chromium
    // (host libc vs Nix libc ABI mismatch - see GLIBC_ABI_GNU2_TLS error)
    const envBackup: Record<string, string | undefined> = {};
    for (const key of ["LD_LIBRARY_PATH", "NIX_LD", "NIX_LD_LIBRARY_PATH"]) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
    try {
      browser = await chromium.launch({
        headless,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });
    } finally {
      for (const [key, value] of Object.entries(envBackup)) {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
      }
    }
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
