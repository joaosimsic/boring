# AdMatch Screenshot Tool

Capture viewport screenshots of every valid (post, ad) pair. Each screenshot captures the post page with ad-specific query params appended, showing the ad rendered in context.

## Usage

```sh
bun index.ts [options]
```

### CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--config` | `./config.json` | Path to config file |
| `--dry-run` | false | Print matched jobs + output paths, do not capture |
| `--output` | from config | Override output directory |

### Example

```sh
bun index.ts
bun index.ts --config ./my-config.json
bun index.ts --dry-run
bun index.ts --output ./my-screenshots
```

## Config Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `posts` | `{ url, date }[]` | — | Post URLs and their publication dates |
| `ads` | `{ id, label, width, height, queryParams, startDate, endDate }[]` | — | Ad configurations |
| `outputDir` | string | `./screenshots` | Screenshot output directory |
| `format` | `png` | `jpeg` | `png` | Screenshot format |
| `timeout` | number | `30000` | Max ms per page load |
| `pollTimeout` | number | `15000` | Max ms to wait for GPT `slotRenderEnded` event |
| `viewport` | `{ width, height }` | `{ 1920, 1080 }` | Viewport dimensions |
| `concurrency` | number | `3` | Number of parallel capture jobs |
| `sizeTolerance` | number | `0` | Px tolerance for ad size matching |

`sizeTolerance` can be overridden at runtime via `AD_SIZE_TOLERANCE` env var.

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

A `summary.json` is written at the output root listing all capture jobs and their outcomes.

## Edge Cases

| Scenario | Behavior |
|---|---|
| No matching ad for post | Skipped with warning |
| Ad event timeout | Screenshot saved, `eventReceived: false` logged in summary |
| Page load error | Error logged in summary |
| GPT not present on page | Falls back: screenshot taken, `gptPresent: false` in summary |
| `AD_SIZE_TOLERANCE` env | Overrides `sizeTolerance` at runtime |
