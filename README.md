# AdMatch Screenshot Tool

Capture full-page screenshots of every valid (post, ad) pair. Each job navigates to the post URL with ad-specific query params, waits for the GPT `slotRenderEnded` event, and captures a full-page screenshot.

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
| `ads` | `Ad[]` | — | Ad configurations (see below) |
| `outputDir` | string | `./screenshots` | Screenshot output directory |
| `format` | `png` \| `jpeg` | `png` | Screenshot image format |
| `timeout` | number | `30000` | Max ms per page load |
| `pollTimeout` | number | `15000` | Max ms to wait for GPT `slotRenderEnded` event |
| `viewport` | `{ width, height }` | `{ 1920, 1080 }` | Default viewport dimensions |
| `concurrency` | number | `3` | Number of parallel capture jobs |
| `sizeTolerance` | number | `0` | Px tolerance for ad size matching |
| `compression` | number (0–9) | `5` | PNG compression level (0 disables re-compression) |
| `headless` | boolean | `true` | Run browser in headless mode |

`sizeTolerance` can be overridden at runtime via `AD_SIZE_TOLERANCE` env var.

### Per-ad Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Ad identifier; used as directory and zip filename |
| `label` | string | Yes | Human-readable label for console output |
| `viewport` | `{ width, height }` | No | Per-ad viewport override (falls back to global) |
| `width` | number | Yes | Expected ad width in pixels |
| `height` | number | Yes | Expected ad height in pixels |
| `queryParams` | `Record<string, string>` | Yes | Query params appended to post URL |
| `startDate` | string (YYYY-MM-DD) | Yes | First date this ad is valid |
| `endDate` | string (YYYY-MM-DD) | Yes | Last date this ad is valid |

## Output Structure

```
screenshots/
  <ad-id>/
    <dd>-<mm>-<yyyy>.<format>
  summary.json
  <ad-id>.zip
```

Path template: `{outputDir}/{ad-id}/{dd}-{mm}-{yyyy}.{format}`

A `summary.json` is written at the output root listing all capture jobs and their outcomes. A `.zip` archive is also created per ad ID.

## Edge Cases

| Scenario | Behavior |
|---|---|
| No matching ad for post | Skipped with warning |
| Ad event timeout | Screenshot saved, `eventReceived: false` logged in summary |
| Page load error | Error logged in summary |
| GPT not present on page | Falls back: screenshot taken, `gptPresent: false` in summary |
| `AD_SIZE_TOLERANCE` env | Overrides `sizeTolerance` at runtime |
