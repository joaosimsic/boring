import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { discoverAds, formatSkipped } from "./discover";
import { resetTokenCache } from "./dfp";
import type { Config } from "./types";

const ORIGINAL_FETCH = globalThis.fetch;

function soapResponse(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

interface Stub {
  lineItems: string;
  associations: Record<string, string>;
  creatives: string;
}

/**
 * Routes SOAP calls by service name so discovery can be exercised end to end
 * through the real request-building and XML-parsing code.
 */
function stubSoap(stub: Stub): void {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }));
    }
    if (url.includes("LineItemCreativeAssociationService")) {
      const match = String(init?.body ?? "").match(/WHERE lineItemId = (\d+)/);
      const rows = match ? (stub.associations[match[1]!] ?? "") : "";
      return new Response(
        soapResponse(
          `<getLineItemCreativeAssociationsByStatementResponse><rval>` +
            `<totalResultSetSize>0</totalResultSetSize><startIndex>0</startIndex>` +
            `${rows}</rval></getLineItemCreativeAssociationsByStatementResponse>`,
        ),
      );
    }
    if (url.includes("CreativeService")) {
      return new Response(
        soapResponse(
          `<getCreativesByStatementResponse><rval>` +
            `<totalResultSetSize>0</totalResultSetSize><startIndex>0</startIndex>` +
            `${stub.creatives}</rval></getCreativesByStatementResponse>`,
        ),
      );
    }
    return new Response(
      soapResponse(
        `<getLineItemsByStatementResponse><rval>` +
          `<totalResultSetSize>${(stub.lineItems.match(/<results>/g) ?? []).length}` +
          `</totalResultSetSize><startIndex>0</startIndex>` +
          `${stub.lineItems}</rval></getLineItemsByStatementResponse>`,
      ),
    );
  }) as typeof fetch;
}

function lineItem(opts: {
  id: string;
  name?: string;
  status?: string;
  archived?: boolean;
  start: string;
  end: string;
}): string {
  return (
    `<results><orderId>4166121306</orderId><id>${opts.id}</id>` +
    `<name>${opts.name ?? `LI ${opts.id}`}</name>` +
    `<status>${opts.status ?? "DELIVERING"}</status>` +
    `<isArchived>${String(opts.archived ?? false)}</isArchived>` +
    `<startDateTime><date><year>${opts.start.slice(0, 4)}</year>` +
    `<month>${opts.start.slice(5, 7)}</month><day>${opts.start.slice(8, 10)}</day>` +
    `</date></startDateTime>` +
    `<endDateTime><date><year>${opts.end.slice(0, 4)}</year>` +
    `<month>${opts.end.slice(5, 7)}</month><day>${opts.end.slice(8, 10)}</day>` +
    `</date></endDateTime></results>`
  );
}

function association(creativeId: string, status = "ACTIVE"): string {
  return (
    `<results><lineItemId>LI</lineItemId>` +
    `<creativeId>${creativeId}</creativeId><status>${status}</status></results>`
  );
}

function creative(opts: {
  id: string;
  name?: string;
  width?: number;
  height?: number;
  overrideSize?: boolean;
  asset?: boolean;
}): string {
  const size =
    opts.width && opts.height
      ? `<size><width>${opts.width}</width><height>${opts.height}</height></size>`
      : "";
  const asset = opts.asset
    ? `<primaryImageAsset><assetUrl>https://img/${opts.id}.png</assetUrl></primaryImageAsset>`
    : "";
  return (
    `<results><id>${opts.id}</id><name>${opts.name ?? `C ${opts.id}`}</name>${size}` +
    `<overrideSize>${String(opts.overrideSize ?? false)}</overrideSize>${asset}</results>`
  );
}

const ENV_KEYS = ["DFP_NETWORK_CODE", "DFP_API_VERSION", "DFP_CLIENT_ID", "DFP_CLIENT_SECRET", "DFP_REFRESH_TOKEN"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = Bun.env[key];
    delete Bun.env[key];
  }
  Bun.env.DFP_NETWORK_CODE = "19028704";
  Bun.env.DFP_CLIENT_ID = "cid";
  Bun.env.DFP_CLIENT_SECRET = "secret";
  Bun.env.DFP_REFRESH_TOKEN = "refresh";
  resetTokenCache();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete Bun.env[key];
    else Bun.env[key] = saved[key]!;
  }
  resetTokenCache();
});

function makeConfig(): Config {
  return {
    postSource: {
      type: "wordpress",
      apiUrl: "https://example.com/wp-json/wp/v2",
      category: "news",
      dateRange: { start: "2026-08-15", end: "2026-08-31" },
    },
    orderId: "4166121306",
    outputDir: "./screenshots",
    format: "jpeg",
    timeout: 30000,
    pollTimeout: 15000,
    scrollTimeout: 20000,
    viewport: { width: 1920, height: 1080 },
    concurrency: 2,
    sizeTolerance: 0,
    compression: 9,
    jpegQuality: 80,
    headless: true,
    dfp: {
      networkCode: "19028704",
      adUnitPrefix: "19028704/ThMais",
      maxWaitMs: 45000,
      minInkStdDev: 8,
    },
  };
}

describe("discoverAds", () => {
  test("builds one Ad per creative with size, flight and preview ids", async () => {
    stubSoap({
      lineItems: lineItem({ id: "7402987372", name: "Vila Criativa", start: "2026-08-17", end: "2026-08-31" }),
      associations: { "7402987372": association("138572612467") },
      creatives: creative({ id: "138572612467", width: 300, height: 250, asset: true }),
    });

    const result = await discoverAds("4166121306", makeConfig());

    expect(result.ads).toHaveLength(1);
    const ad = result.ads[0]!;
    expect(ad.id).toBe("138572612467");
    expect(ad.campaign).toBe("Vila Criativa");
    expect(ad.width).toBe(300);
    expect(ad.height).toBe(250);
    expect(ad.preview).toEqual({ lineItemId: "7402987372", creativeId: "138572612467" });
    expect(ad.queryParams.iu).toBe("19028704");
    expect(ad.queryParams.lineItemId).toBe("7402987372");
    expect(ad.referenceAssetUrl).toBe("https://img/138572612467.png");
    // flight intersected with the configured date range
    expect(ad.startDate).toBe("2026-08-17");
    expect(ad.endDate).toBe("2026-08-31");
    expect(result.skipped).toEqual([]);
  });

  test("keeps COMPLETED line items but drops DRAFT and ARCHIVED", async () => {
    stubSoap({
      lineItems:
        lineItem({ id: "1", name: "Completed", status: "COMPLETED", start: "2026-08-17", end: "2026-08-20" }) +
        lineItem({ id: "2", name: "Draft", status: "DRAFT", start: "2026-08-17", end: "2026-08-20" }) +
        lineItem({ id: "3", name: "Archived", status: "DELIVERING", archived: true, start: "2026-08-17", end: "2026-08-20" }),
      associations: {
        "1": association("c1"),
        "2": association("c2"),
        "3": association("c3"),
      },
      creatives:
        creative({ id: "c1", width: 300, height: 250 }) +
        creative({ id: "c2", width: 300, height: 250 }) +
        creative({ id: "c3", width: 300, height: 250 }),
    });

    const result = await discoverAds("4166121306", makeConfig());
    expect(result.ads.map((a) => a.id)).toEqual(["c1"]);
  });

  test("drops line items whose flight does not overlap the date range", async () => {
    stubSoap({
      lineItems:
        lineItem({ id: "1", name: "Before", start: "2026-06-01", end: "2026-06-30" }) +
        lineItem({ id: "2", name: "Overlaps", start: "2026-08-20", end: "2026-09-30" }),
      associations: { "1": association("c1"), "2": association("c2") },
      creatives: creative({ id: "c1", width: 300, height: 250 }) + creative({ id: "c2", width: 300, height: 250 }),
    });

    const result = await discoverAds("4166121306", makeConfig());
    expect(result.ads.map((a) => a.id)).toEqual(["c2"]);
    // flight is clamped to the configured range
    expect(result.ads[0]!.startDate).toBe("2026-08-20");
    expect(result.ads[0]!.endDate).toBe("2026-08-31");
  });

  test("skips size-overridden creatives with a reason", async () => {
    stubSoap({
      lineItems: lineItem({ id: "1", start: "2026-08-17", end: "2026-08-20" }),
      associations: { "1": association("c1") },
      creatives: creative({ id: "c1", width: 300, height: 250, overrideSize: true }),
    });

    const result = await discoverAds("4166121306", makeConfig());
    expect(result.ads).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain("size override");
  });

  test("skips creatives with no pixel size", async () => {
    stubSoap({
      lineItems: lineItem({ id: "1", start: "2026-08-17", end: "2026-08-20" }),
      associations: { "1": association("c1") },
      creatives: creative({ id: "c1" }),
    });

    const result = await discoverAds("4166121306", makeConfig());
    expect(result.ads).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain("no pixel size");
  });

  test("skips creatives that the API no longer returns", async () => {
    stubSoap({
      lineItems: lineItem({ id: "1", start: "2026-08-17", end: "2026-08-20" }),
      associations: { "1": association("gone") },
      creatives: "",
    });

    const result = await discoverAds("4166121306", makeConfig());
    expect(result.ads).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain("no longer exists");
  });

  test("captures non-ACTIVE associations rather than dropping them", async () => {
    stubSoap({
      lineItems: lineItem({ id: "1", start: "2026-08-17", end: "2026-08-20" }),
      associations: { "1": association("c1", "PAUSED") },
      creatives: creative({ id: "c1", width: 300, height: 250 }),
    });

    const result = await discoverAds("4166121306", makeConfig());
    expect(result.ads.map((a) => a.id)).toEqual(["c1"]);
    expect(result.skipped).toEqual([]);
  });

  test("honours maxCreatives and records that it capped", async () => {
    stubSoap({
      lineItems: lineItem({ id: "1", start: "2026-08-17", end: "2026-08-20" }),
      associations: { "1": association("c1") + association("c2") + association("c3") },
      creatives:
        creative({ id: "c1", width: 300, height: 250 }) +
        creative({ id: "c2", width: 970, height: 250 }) +
        creative({ id: "c3", width: 728, height: 90 }),
    });

    const result = await discoverAds("4166121306", makeConfig(), { maxCreatives: 2 });
    expect(result.ads).toHaveLength(2);
    expect(result.skipped.some((s) => s.reason.includes("max-creatives"))).toBe(true);
  });

  test("propagates a SOAP fault from the order query", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }));
      }
      return new Response(
        soapResponse(
          `<SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>ApiException` +
            `</faultstring><detail><ApiException><ApiError><reason>UNEXECUTABLE</reason>` +
            `<errorString>bad</errorString></ApiError></ApiException></detail></SOAP-ENV:Fault>`,
        ),
      );
    }) as typeof fetch;

    expect(discoverAds("4166121306", makeConfig())).rejects.toThrow("UNEXECUTABLE");
  });
});

describe("formatSkipped", () => {
  test("labels skips with line item and creative when known", () => {
    expect(
      formatSkipped([
        { lineItemId: "1", lineItemName: "Vila", creativeId: "c9", reason: "size override" },
      ]),
    ).toEqual(["Vila / c9: size override"]);
  });

  test("falls back to the bare reason", () => {
    expect(formatSkipped([{ reason: "capped" }])).toEqual(["capped"]);
  });
});