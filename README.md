# AdMatch Screenshot Tool

Point it at an Ad Manager **order** and it discovers the line items and creatives itself,
then captures a full-page screenshot of every valid (post, creative) pair. Each job navigates
to the post URL with ad-specific query params, waits for the GPT `slotRenderEnded` event, and
captures a full-page screenshot.

You no longer hand-write an `ads` array. The tool reads the hierarchy from the Ad Manager API:

```
orderId → line items → creative associations → creatives (size, image asset)
```

## Usage

```sh
bun index.ts [options]
```

### CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--config` | `./config.json` | Path to config file |
| `--dry-run` | false | Print discovered creatives, matched jobs and output paths; capture nothing |
| `--output` | from config | Override output directory |
| `--max-creatives` | `0` (no cap) | Stop after this many creatives — a guard against large orders |

### Example

```sh
bun index.ts
bun index.ts --config ./my-config.json
bun index.ts --dry-run
bun index.ts --output ./my-screenshots
bun index.ts --max-creatives 4
```

### Example Config

```json
{
  "orderId": "4166121306",
  "postSource": {
    "type": "wordpress",
    "apiUrl": "https://thmais.com.br/wp-json/wp/v2",
    "category": "campinas",
    "dateRange": { "start": "2026-07-01", "end": "2026-07-30" }
  },
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

## Why an order and not a campaign

GAM campaigns are not reachable from the API version this tool uses. On `v202602`
(the default, override with `DFP_API_VERSION`):

- there is no `CampaignService`
- `LineItem` has no `campaignId` field, and filtering `WHERE campaignId = …` faults with `UNEXECUTABLE`

The reachable hierarchy is **Advertiser → Order → LineItem → Creative**, so `orderId` is the
top-level identifier you can hand over. In most setups an order maps closely enough to a
campaign that this is the same workflow.

## What discovery does

For each line item in the order, the tool keeps those that are not archived, whose status is
`DELIVERING`, `PAUSED` or `COMPLETED`, and whose flight overlaps `postSource.dateRange`.
`COMPLETED` line items are deliberately included: on-site preview still serves them, so
excluding them would stop capturing creatives a hand-written list would have covered.

Each surviving creative becomes one capture job, sized from `Creative.size` and dated from the
line item's flight **intersected** with `postSource.dateRange`. The line item name becomes the
output folder, so `screenshots/<line-item-name>/` replaces a hand-typed campaign label.

Anything dropped is reported before capture rather than silently:

| Skipped | Why |
|---|---|
| Archived line item | `isArchived` |
| `DRAFT` / `ARCHIVED` line item | status not deliverable |
| Line item outside the date range | flight does not overlap `postSource.dateRange` |
| Creative with a size override | on-site preview cannot pin it |
| Creative with no pixel size | non-image / programmatic creative |
| Creative that no longer exists | association points at an invisible creative |

Run with `--dry-run` first on a large order: one order can hold many line items × many
creatives, and every creative is captured once per post per day.

`summary.json` records `orderId` and the full `skipped` list alongside the capture results.

## Config Reference

| Field | Type | Default | Description |
|---|---|---|---|
| `orderId` | string (numeric) | — | **Required.** Ad Manager order whose line items should be captured |
| `postSource` | `{ type, apiUrl, category, dateRange }` | — | Post source configuration (see below) |
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
| `combineMatchingAds` | boolean | `true` | Merge creatives sharing a date range into one page load |

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

### Ad Manager Preview Tokens

`google_preview` tokens expire, so a pasted token goes stale. For every discovered creative the
tool calls the Ad Manager API (`LineItemCreativeAssociationService.getPreviewUrl`) once per
creative per post to generate a fresh preview URL, and uses that instead of `queryParams`.

Before capturing, a preflight reads the line item/creative association and checks the creative's
size and targeting. A creative with a size override cannot be pinned by on-site preview, so it is
skipped; **the run is not aborted** — remaining creatives still capture. A run only stops early if
*every* discovered creative fails preflight.

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

The OAuth client must be whitelisted under **Admin → API access** in the network. Credentials are
required: discovery reads the order from the API, so without them the tool cannot build a job
list and exits with a message.

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
  <line-item-name>/
    <width>x<height>-<creative-id>-<dd>-<mm>-<yyyy>.<format>
  summary.json
  <line-item-name>.zip
```

Path template: `{outputDir}/{line-item-name}/{width}x{height}-{creative-id}-{dd}-{mm}-{yyyy}.{format}`

The folder and `.zip` are named after the **line item**, so two line items in the same order do
not collide. A `summary.json` is written at the output root listing the `orderId`, every skipped
creative with its reason, and all capture jobs with their outcomes.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Order has no capturable creative | Exits before capture with the skip reasons |
| No creative matches a post's date | Post skipped with warning |
| Line item flight misses the date range | Line item filtered out before any API call per creative |
| Creative has a size override | Skipped during discovery, reason in `summary.json` |
| Creative no longer exists | Skipped during discovery, reason in `summary.json` |
| Preflight finds a blocking problem | That creative skipped; the rest still capture |
| Statement returns fewer rows than advertised | Warning printed; `truncated` reflects it |
| `--max-creatives` reached | Remaining creatives skipped, reason in `summary.json` |
| Ad event timeout | Screenshot saved, `eventReceived: false` logged in summary |
| Wrong creative served | Screenshot saved, `creativeMatched: false` plus `servedCreatives` in summary |
| Browser crashes mid-run | Job fails, retried once, then recorded as `success: false` |
| Preview generation fails for a job | That job falls back to `queryParams`, error logged |
| Page load error | Error logged in summary |
| GPT not present on page | Falls back: screenshot taken, `gptPresent: false` in summary |
| `AD_SIZE_TOLERANCE` env | Overrides `sizeTolerance` at runtime |

## Known API constraints

Two limits of the Ad Manager SOAP API shape this tool, and are worth knowing before changing it:

- **No campaign lookup.** `CampaignService` does not exist on `v202602` and `LineItem` carries no
  `campaignId`, so `orderId` is the shallowest identifier available.
- **No statement paging.** `paging` is rejected inside `FilterStatement` by the live endpoint, so
  statements run unpaginated. A very large order could return fewer line items than it reports;
  discovery compares the two and warns via `truncated` rather than silently capturing a subset.
