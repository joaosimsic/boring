# AdMatch Screenshot Tool — Plan

## Goal

Given a list of **posts** (URL + date) and a list of **ads** (size + URL query params + exhibition period), take viewport screenshots of every valid (post, ad) pair. Each screenshot captures the post page with the ad-specific query params appended, showing the ad rendered in context.

## Config (`config.json`)

```json
{
  "posts": [
    { "url": "https://example.com/sports/article-1", "date": "2026-06-15" },
    { "url": "https://example.com/tech/review",      "date": "2026-06-20" }
  ],
  "ads": [
    {
      "id": "bmw-leaderboard",
      "label": "BMW Leaderboard",
      "width": 728,
      "height": 90,
      "queryParams": { "campaign": "bmw", "ad_type": "leaderboard" },
      "startDate": "2026-06-01",
      "endDate": "2026-06-30"
    }
  ],
  "outputDir": "./screenshots",
  "format": "png",
  "timeout": 30000,
  "pollTimeout": 15000,
  "viewport": { "width": 1920, "height": 1080 },
  "concurrency": 3,
  "sizeTolerance": 0
}
```

| Field | Description |
|---|---|
| `posts` | Array of `{ url, date }` |
| `ads` | Array of `{ id, label, width, height, queryParams, startDate, endDate }` |
| `format` | Screenshot format: `png` or `jpeg` |
| `timeout` | Max ms per page load |
| `pollTimeout` | Max ms to wait for GPT `slotRenderEnded` event matching the target size |
| `concurrency` | Number of capture jobs running in parallel |
| `sizeTolerance` | Px tolerance for ad element size matching (default 0, overridable via `AD_SIZE_TOLERANCE` env var) |

## Matching Logic

For each post, find all ads where `ad.startDate ≤ post.date ≤ ad.endDate`. Each match becomes a `CaptureJob`.

```
post (article-1, 2026-06-15)
  → matches bmw-leaderboard (2026-06-01–2026-06-30)
  → jobs: [{ url: ".../article-1?campaign=bmw&ad_type=leaderboard", post, ad }]
```

## Output Structure

```
screenshots/
  example.com/
    sports/
      article-1/
        bmw-leaderboard/
          2026-07-07/
            143022.png
```

Path template: `{outputDir}/{host}/{path-segments}/{ad-id}/{capture-date}/{capture-time}.{format}`

Also writes a `summary.json` at root listing all capture jobs and their outcomes.

## Architecture

```
index.ts           Entry: parse --config, --dry-run, orchestrate
types.ts           Interfaces: Post, Ad, Config, CaptureJob, CaptureResult
config.ts          Load & validate config.json (default: ./config.json)
matcher.ts         Cross-reference posts × ads by date → CaptureJob[]
browser.ts         Playwright pool: launch N concurrent contexts
inject.ts          Script injected via addInitScript: hooks GPT `slotRenderEnded` event
screenshotter.ts   Per job: build URL, navigate, waitForFunction on event, screenshot, save
```

## Per-Job Flow

1. Build URL: `post.url + "?" + ad.queryParams`
2. Acquire browser context from pool
3. Inject the GPT event listener via `page.addInitScript()` (runs before any page JS)
4. Navigate, wait for `networkidle`
5. Scroll to bottom (trigger lazy-loaded slots)
6. Wait for GPT `slotRenderEnded` event matching `width×height` (using `page.waitForFunction`, up to `pollTimeout` ms)
7. Log: event received ✓ / timeout ⚠
8. Capture viewport screenshot
9. Build output path, create dirs, save
10. Release context back to pool

## Edge Cases

| Scenario | Behavior |
|---|---|
| No matching ad for post | Skipped with warning |
| Ad event timeout | Screenshot saved, `missing` logged in `summary.json` |
| Page load error | Retry once, then skip & log |
| GPT not present on page | Falls back: screenshot taken, logged as `no-gpt` |
| `AD_SIZE_TOLERANCE` env | Override `sizeTolerance` at runtime |

## CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--config` | `./config.json` | Path to config file |
| `--dry-run` | false | Print matched jobs + output paths, do not capture |
| `--output` | from config | Override output directory |

## Implementation Order

1. **Scaffold** — `types.ts`, `config.ts`, `matcher.ts`
2. **Browser** — `browser.ts` (launch, pool, close)
3. **Inject** — `inject.ts` (GPT event listener script)
4. **Core** — `screenshotter.ts` (navigate, waitForFunction, capture)
5. **Pipeline** — `index.ts` (main loop, dry-run, concurrency)
6. **Summary** — `summary.json` output
7. **README** — usage, config reference, examples

## Stack

- **Runtime**: Bun
- **Browser**: Playwright (chromium)
- **Config**: JSON (built-in Bun support)
