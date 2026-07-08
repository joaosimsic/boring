import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;

export async function getBrowser(headless: boolean = true): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
