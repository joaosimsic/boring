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

### Example Config

```json
{
  "postSource": {
    "type": "wordpress",
    "apiUrl": "https://thmais.com.br/wp-json/wp/v2",
    "category": "campinas",
    "dateRange": { "start": "2026-07-01", "end": "2026-07-30" }
  },
  "ads": [
    {
      "id": "unifunec",
      "label": "unifunec",
      "viewport": { "width": 1920, "height": 1080 },
      "width": 300,
      "height": 250,
      "queryParams": {
        "google_preview": "nwJKqAv49u4Ywe_N0wYwwYuD2waIAYCAgJD5uIOGMA",
        "iu": "19028704",
        "gdfp_req": "1",
        "lineItemId": "7355256627",
        "creativeId": "138565256007"
      },
      "startDate": "2026-07-01",
      "endDate": "2026-07-30"
    }
  ],
  "outputDir": "./screenshots",
  "format": "jpeg",
  "jpegQuality": 80,
  "timeout": 30000,
  "pollTimeout": 5000,
  "scrollTimeout": 20000,
  "viewport": { "width": 1920, "height": 1080 },
  "concurrency": 3,
  "sizeTolerance": 0,
  "compression": 9,
  "headless": true
}
```

## Config Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `postSource` | `{ type, apiUrl, category, dateRange }` | — | Post source configuration (see below) |
| `ads` | `Ad[]` | — | Ad configurations (see below) |
| `outputDir` | string | `./screenshots` | Screenshot output directory |
| `format` | `png` \| `jpeg` | `png` | Screenshot image format |
| `jpegQuality` | number (0–100) | `80` | JPEG quality when `format` is `jpeg` |
| `timeout` | number | `30000` | Max ms per page load |
| `pollTimeout` | number | `15000` | Max ms to wait for GPT `slotRenderEnded` event |
| `scrollTimeout` | number | `20000` | Max ms spent auto-scrolling to trigger lazy-loaded content |
| `viewport` | `{ width, height }` | `{ 1920, 1080 }` | Default viewport dimensions |
| `concurrency` | number | `3` | Number of parallel capture jobs |
| `sizeTolerance` | number | `0` | Px tolerance for ad size matching |
| `compression` | number (0–9) | `5` | PNG compression level (0 disables re-compression) |
| `headless` | boolean | `true` | Run browser in headless mode |

`sizeTolerance` can be overridden at runtime via `AD_SIZE_TOLERANCE` env var.

### postSource Fields

Posts are fetched from a WordPress site via the REST API (`/wp-json/wp/v2`). One post per day is used (the newest post published that day).

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"wordpress"` | Yes | Source type |
| `apiUrl` | string | Yes | WordPress REST API base URL (e.g. `https://thmais.com.br/wp-json/wp/v2`) |
| `category` | string \| string[] | Yes | Category slug(s) to filter posts by |
| `dateRange` | `{ start, end }` | Yes | Fetch only posts published between `start` and `end` (YYYY-MM-DD) |
| `perPage` | number | No | Posts per API page (default `100`) |

### Per-ad Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Ad identifier; used as directory and zip filename |
| `label` | string | Yes | Human-readable label for console output |
| `viewport` | `{ width, height }` | No | Per-ad viewport override (falls back to global) |
| `width` | number | Yes | Expected ad width in pixels |
| `height` | number | Yes | Expected ad height in pixels |
| `queryParams` | `Record<string, string>` | Yes | Query params appended to post URL |
| `preview` | `{ lineItemId, creativeId }` | No | Ad Manager IDs; enables automatic preview-token generation |
| `startDate` | string (YYYY-MM-DD) | Yes | First date this ad is valid |
| `endDate` | string (YYYY-MM-DD) | Yes | Last date this ad is valid |

### Ad Manager Preview Tokens

`google_preview` tokens expire, so pasting one into `queryParams` goes stale. When an ad
declares a `preview` block and credentials are available, the tool calls the Ad Manager API
(`LineItemCreativeAssociationService.getPreviewUrl`) once per ad per post to generate a fresh
preview URL, and uses that instead of `queryParams`.

Before capturing, a preflight reads the line item/creative association and aborts the run if the
creative has a size override (on-site preview does not support those) or if no association exists
between the line item and creative.

Every screenshot is verified against the creative that actually served. A mismatch is reported
(warn, screenshot kept) via `creativeMatched` and `servedCreatives` in `summary.json`.

#### Credentials

Set in `.env` (gitignored):

| Variable | Description |
|---|---|
| `DFP_NETWORK_CODE` | Ad Manager network code (required) — the number in `admanager.google.com/<code>#...`; verify with `listNetworks()` |
| `DFP_SERVICE_ACCOUNT_JSON` | Path to a service account JSON key |
| `DFP_CLIENT_ID` / `DFP_CLIENT_SECRET` / `DFP_REFRESH_TOKEN` | Alternative to the service account key |
| `DFP_IMPERSONATE_EMAIL` | Optional domain-wide delegation subject |
| `DFP_APPLICATION_NAME` | SOAP `applicationName` (default `boring`) |
| `DFP_API_VERSION` | Ad Manager API version (default `v202602`) |

#### Network code vs publisher ID

These are different numbers and are easy to confuse. On this network the network code is
`19028704`, and Ad Manager's own preview URLs carry it as `iu=19028704`. The publisher property
code (`ca-pub-…`) is a different, much longer value. The network code goes in `DFP_NETWORK_CODE`.

To confirm the code your credential can actually reach, `listNetworks()` in `dfp.ts` calls
`NetworkService.getAllNetworks` and prints every network the service account can access.

The OAuth client must be whitelisted under **Admin → API access** in the network. With no
credentials the tool falls back to static `queryParams` and warns.

#### How the creative is located and verified

Preview renders report a **null `creativeId`** in `slotRenderEnded`, so matching on creative ID
alone never works. Instead the tool:

1. polls until a filled slot exists whose **ad unit path** contains `dfp.adUnitPrefix` **and**
   whose size matches the ad;
2. locates the ad iframe by exact size (within 4px) preferring our network's ad units;
3. screenshots that iframe and compares it against the creative's own image asset from the Ad
   Manager API (`primaryImageAsset.assetUrl`) at a tolerance of 18;
4. crops the output to the ad slot **when `cropToAd` is true**; when false the screenshot is the
   full page, and the ad element is used only for verification.

A slot can still be filled by a different advertiser's ad — that is caught by the pixel
comparison and reported as `creativeMatched: false` with the measured difference.

| Field | Type | Required | Description |
|---|---|---|---|
| `cropToAd` | boolean | No | Crop the screenshot to the ad iframe (default `true`). Set `false` for full-page screenshots |
| `dfp.networkCode` | string | No | Network code, for reference in preflight |
| `dfp.adUnitPrefix` | string | No | Ad unit path prefix identifying our network's slots |
| `dfp.maxWaitMs` | number | No | How long to poll for the ad (default `45000`) |
| `dfp.minInkStdDev` | number | No | Minimum pixel deviation to treat a frame as non-blank (default `8`) |

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
| Wrong creative served | Screenshot saved, `creativeMatched: false` plus `servedCreatives` in summary |
| Browser crashes mid-run | Job fails, retried once, then recorded as `success: false` |
| Preflight finds size override or missing association | Run aborts before any capture |
| Preview generation fails for a job | That job falls back to `queryParams`, error logged |
| Page load error | Error logged in summary |
| GPT not present on page | Falls back: screenshot taken, `gptPresent: false` in summary |
| `AD_SIZE_TOLERANCE` env | Overrides `sizeTolerance` at runtime |
