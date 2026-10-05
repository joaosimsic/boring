import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  DfpError,
  describeAssociation,
  dfpConfigured,
  extractPreviewParams,
  getPreviewUrl,
  listNetworks,
  resetTokenCache,
} from "./dfp";
import { matchAds, previewKey } from "./matcher";
import { selectFrame, inkStdDev, imagesMatch } from "./screenshotter";
import sharp from "sharp";
import type { Ad, Post } from "./types";

const ORIGINAL_FETCH = globalThis.fetch;

function soapResponse(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

function soapFault(reason: string): string {
  return soapResponse(
    `<SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode>` +
      `<faultstring>ApiException</faultstring><detail><ApiException><ApiError>` +
      `<reason>${reason}</reason><errorString>details for ${reason}</errorString>` +
      `</ApiError></ApiException></detail></SOAP-ENV:Fault>`,
  );
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    return handler(url, init);
  }) as typeof fetch;
}

const ENV_KEYS = [
  "DFP_NETWORK_CODE",
  "DFP_APPLICATION_NAME",
  "DFP_API_VERSION",
  "DFP_SERVICE_ACCOUNT_JSON",
  "DFP_CLIENT_ID",
  "DFP_CLIENT_SECRET",
  "DFP_REFRESH_TOKEN",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = Bun.env[key];
    delete Bun.env[key];
  }
  Bun.env.DFP_NETWORK_CODE = "7542";
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

function tokenThenSoap(soapBody: string) {
  const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  mockFetch((url, init) => {
    const body = String(init?.body ?? "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url, body, headers });
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(soapBody, { status: 200 });
  });
  return requests;
}

describe("getPreviewUrl", () => {
  test("returns the rval URL and sends a correct SOAP envelope", async () => {
    const requests = tokenThenSoap(
      soapResponse(
        `<getPreviewUrlResponse xmlns="https://www.google.com/apis/ads/publisher/v202602">` +
          `<rval>https://example.com/a?google_preview=TOKEN1&amp;creativeId=1</rval>` +
          `</getPreviewUrlResponse>`,
      ),
    );

    const url = await getPreviewUrl("7402987372", "138572612467", "https://example.com/a");

    expect(url).toBe("https://example.com/a?google_preview=TOKEN1&creativeId=1");

    const soap = requests.find((r) => r.url.includes("ads.google.com"))!;
    expect(soap.headers.Authorization).toBe("Bearer tok-123");
    expect(soap.headers["Content-Type"]).toContain("text/xml");
    expect(soap.body).toContain("<ns1:networkCode>7542</ns1:networkCode>");
    expect(soap.body).toContain("<ns1:applicationName>boring</ns1:applicationName>");
    expect(soap.body).toContain("<lineItemId>7402987372</lineItemId>");
    expect(soap.body).toContain("<creativeId>138572612467</creativeId>");
    expect(soap.body).toContain("<siteUrl>https://example.com/a</siteUrl>");
  });

  test("honours DFP_API_VERSION in both namespace and endpoint", async () => {
    Bun.env.DFP_API_VERSION = "v202508";
    const requests = tokenThenSoap(
      soapResponse(
        `<getPreviewUrlResponse><rval>https://example.com/a?google_preview=T</rval></getPreviewUrlResponse>`,
      ),
    );

    await getPreviewUrl("1", "2", "https://example.com/a");

    const soap = requests.find((r) => r.url.includes("ads.google.com"))!;
    expect(soap.url).toContain("/v202508/LineItemCreativeAssociationService");
    expect(soap.body).toContain("ads/publisher/v202508");
    expect(soap.body).not.toContain("v202602");
  });

  test("surfaces the API error reason from a SOAP fault", async () => {
    tokenThenSoap(soapFault("CANNOT_GENERATE_PREVIEW_URL"));

    const promise = getPreviewUrl("1", "2", "https://example.com/a");
    await expect(promise).rejects.toThrow(/CANNOT_GENERATE_PREVIEW_URL/);

    try {
      await getPreviewUrl("1", "2", "https://example.com/a");
    } catch (err) {
      expect(err).toBeInstanceOf(DfpError);
      expect((err as DfpError).reason).toBe("CANNOT_GENERATE_PREVIEW_URL");
    }
  });

  test("escapes XML metacharacters in the site URL", async () => {
    const requests = tokenThenSoap(
      soapResponse(
        `<getPreviewUrlResponse><rval>https://example.com/a?x=1&amp;y=2</rval></getPreviewUrlResponse>`,
      ),
    );

    const url = await getPreviewUrl("1", "2", "https://example.com/a?x=1&y=2");

    expect(url).toBe("https://example.com/a?x=1&y=2");
    const soap = requests.find((r) => r.url.includes("ads.google.com"))!;
    expect(soap.body).toContain("x=1&amp;y=2");
    expect(soap.body).not.toMatch(/<siteUrl>[^<]*&(?!amp;)/);
  });

  test("throws when the response carries no rval", async () => {
    tokenThenSoap(soapResponse(`<getPreviewUrlResponse></getPreviewUrlResponse>`));
    await expect(getPreviewUrl("1", "2", "https://example.com/a")).rejects.toThrow(/no URL/);
  });

  test("fails fast when DFP_NETWORK_CODE is missing", async () => {
    delete Bun.env.DFP_NETWORK_CODE;
    await expect(getPreviewUrl("1", "2", "https://example.com/a")).rejects.toThrow(
      /DFP_NETWORK_CODE/,
    );
  });

  test("reports missing credentials clearly", async () => {
    delete Bun.env.DFP_CLIENT_ID;
    delete Bun.env.DFP_CLIENT_SECRET;
    delete Bun.env.DFP_REFRESH_TOKEN;
    await expect(getPreviewUrl("1", "2", "https://example.com/a")).rejects.toThrow(
      /No Ad Manager credentials/,
    );
  });

  test("reuses the cached access token across calls", async () => {
    const requests = tokenThenSoap(
      soapResponse(
        `<getPreviewUrlResponse><rval>https://example.com/a?google_preview=T</rval></getPreviewUrlResponse>`,
      ),
    );

    await getPreviewUrl("1", "2", "https://example.com/a");
    await getPreviewUrl("1", "2", "https://example.com/a");

    expect(requests.filter((r) => r.url.includes("oauth2"))).toHaveLength(1);
    expect(requests.filter((r) => r.url.includes("ads.google.com"))).toHaveLength(2);
  });
});

describe("describeAssociation", () => {
  test("parses association, creative and line item fields", async () => {
    tokenThenSoap(
      soapResponse(
        `<getLineItemCreativeAssociationsByStatementResponse>` +
          `<rval><LineItemCreativeAssociationPage><totalResultSetSize>1</totalResultSetSize>` +
          `<results><LineItemCreativeAssociation>` +
          `<id>9001</id><lineItemId>7402987372</lineItemId><creativeId>138572612467</creativeId>` +
          `<status>ACCEPTED</status>` +
          `<size><width>300</width><height>250</height></size>` +
          `<creative><id>138572612467</id><name>Marca A</name><status>APPROVED</status>` +
          `<overrideSize>false</overrideSize>` +
          `<targeting><sizes><size>300x250</size><size>970x250</size></sizes></targeting>` +
          `</creative>` +
          `<lineItem><id>7402987372</id><name>Vila Criativa</name><status>DELIVERING</status></lineItem>` +
          `</LineItemCreativeAssociation></results></LineItemCreativeAssociationPage></rval>` +
          `</getLineItemCreativeAssociationsByStatementResponse>`,
      ),
    );

    const info = await describeAssociation("7402987372", "138572612467");

    expect(info.found).toBe(true);
    expect(info.status).toBe("ACCEPTED");
    expect(info.size).toBe("300x250");
    expect(info.creativeName).toBe("Marca A");
    expect(info.creativeStatus).toBe("APPROVED");
    expect(info.overrideSize).toBe(false);
    expect(info.lineItemName).toBe("Vila Criativa");
    expect(info.lineItemStatus).toBe("DELIVERING");
    expect(info.targetedSizes).toEqual(["300x250", "970x250"]);
  });

  test("detects a size override", async () => {
    tokenThenSoap(
      soapResponse(
        `<getLineItemCreativeAssociationsByStatementResponse><rval><LineItemCreativeAssociationPage>` +
          `<results><LineItemCreativeAssociation><status>ACCEPTED</status>` +
          `<creative><overrideSize>true</overrideSize></creative>` +
          `</LineItemCreativeAssociation></results></LineItemCreativeAssociationPage></rval>` +
          `</getLineItemCreativeAssociationsByStatementResponse>`,
      ),
    );

    const info = await describeAssociation("1", "2");
    expect(info.found).toBe(true);
    expect(info.overrideSize).toBe(true);
  });

  test("returns found=false when there is no association", async () => {
    tokenThenSoap(
      soapResponse(
        `<getLineItemCreativeAssociationsByStatementResponse><rval>` +
          `<LineItemCreativeAssociationPage><totalResultSetSize>0</totalResultSetSize>` +
          `<results></results></LineItemCreativeAssociationPage></rval>` +
          `</getLineItemCreativeAssociationsByStatementResponse>`,
      ),
    );

    expect((await describeAssociation("1", "2")).found).toBe(false);
  });
});

describe("extractPreviewParams", () => {
  test("flattens the returned preview URL into query params", () => {
    expect(
      extractPreviewParams(
        "https://thmais.com.br/a?google_preview=ABC&iu=19028704&gdfp_req=1" +
          "&lineItemId=7402987372&creativeId=138572612467",
      ),
    ).toEqual({
      google_preview: "ABC",
      iu: "19028704",
      gdfp_req: "1",
      lineItemId: "7402987372",
      creativeId: "138572612467",
    });
  });
});

describe("dfpConfigured", () => {
  test("is false without a network code", () => {
    delete Bun.env.DFP_NETWORK_CODE;
    expect(dfpConfigured()).toBe(false);
  });

  test("is false with a network code but no credentials", () => {
    delete Bun.env.DFP_CLIENT_ID;
    delete Bun.env.DFP_CLIENT_SECRET;
    delete Bun.env.DFP_REFRESH_TOKEN;
    expect(dfpConfigured()).toBe(false);
  });

  test("is true with network code and refresh-token credentials", () => {
    expect(dfpConfigured()).toBe(true);
  });

  test("is true with network code and a service account key path", () => {
    delete Bun.env.DFP_CLIENT_ID;
    delete Bun.env.DFP_CLIENT_SECRET;
    delete Bun.env.DFP_REFRESH_TOKEN;
    Bun.env.DFP_SERVICE_ACCOUNT_JSON = "/tmp/key.json";
    expect(dfpConfigured()).toBe(true);
  });
});

describe("matcher preview precedence", () => {
  const posts: Post[] = [{ url: "https://example.com/a", date: "2026-06-15" }];

  const ad: Ad = {
    id: "138572612467",
    label: "138572612467",
    viewport: { width: 1920, height: 1080 },
    width: 300,
    height: 250,
    queryParams: { iu: "19028704", creativeId: "138572612467" },
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    preview: { lineItemId: "7402987372", creativeId: "138572612467" },
  };

  test("uses the generated preview URL when one exists", () => {
    const generated = "https://example.com/a?google_preview=FRESH&creativeId=138572612467";
    const map = new Map([[previewKey(ad.id, posts[0]!.url), generated]]);

    const jobs = matchAds(posts, [ad], false, map);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.url).toBe(generated);
  });

  test("falls back to queryParams when the map has no entry", () => {
    const jobs = matchAds(posts, [ad], false, new Map());
    expect(jobs[0]!.url).toBe("https://example.com/a?iu=19028704&creativeId=138572612467");
  });

  test("falls back to queryParams when no map is supplied at all", () => {
    const jobs = matchAds(posts, [ad], false);
    expect(jobs[0]!.url).toBe("https://example.com/a?iu=19028704&creativeId=138572612467");
  });

  test("does not use a preview URL generated for a different post", () => {
    const map = new Map([[previewKey(ad.id, "https://example.com/other"), "https://example.com/other?google_preview=X"]]);
    const jobs = matchAds(posts, [ad], false, map);
    expect(jobs[0]!.url).not.toContain("google_preview");
  });
});

describe("listNetworks", () => {
  test("parses the flattened rval-per-network shape used by the live API", async () => {
    tokenThenSoap(
      soapResponse(
        `<getAllNetworksResponse xmlns="https://www.google.com/apis/ads/publisher/v202602">` +
          `<rval><id>239544</id><displayName>Nova Brasil FM</displayName>` +
          `<networkCode>19028704</networkCode>` +
          `<propertyCode>ca-pub-0178889146017611</propertyCode>` +
          `<effectiveRootAdUnitId>18028824</effectiveRootAdUnitId>` +
          `<isTest>false</isTest></rval>` +
          `</getAllNetworksResponse>`,
      ),
    );

    const networks = await listNetworks({
      networkCode: "",
      applicationName: "boring",
      apiVersion: "v202602",
    });

    expect(networks).toHaveLength(1);
    expect(networks[0]!.networkCode).toBe("19028704");
    expect(networks[0]!.displayName).toBe("Nova Brasil FM");
    expect(networks[0]!.effectiveRootAdUnit).toBe("18028824");
    expect(networks[0]!.testNetwork).toBe(false);
  });

  test("parses multiple networks as repeated rval blocks", async () => {
    tokenThenSoap(
      soapResponse(
        `<getAllNetworksResponse>` +
          `<rval><networkCode>111</networkCode><isTest>true</isTest></rval>` +
          `<rval><networkCode>222</networkCode><isTest>false</isTest></rval>` +
          `</getAllNetworksResponse>`,
      ),
    );

    const networks = await listNetworks({
      networkCode: "",
      applicationName: "boring",
      apiVersion: "v202602",
    });

    expect(networks.map((n) => n.networkCode)).toEqual(["111", "222"]);
  });
});

describe("describeAssociation response shapes", () => {
  test("handles the flattened shape with no LineItemCreativeAssociationPage wrapper", async () => {
    tokenThenSoap(
      soapResponse(
        `<getLineItemCreativeAssociationsByStatementResponse>` +
          `<rval><lineItemId>7402987372</lineItemId><creativeId>138572612467</creativeId>` +
          `<status>ACCEPTED</status><size><width>300</width><height>250</height></size>` +
          `<creative><name>Marca A</name><overrideSize>false</overrideSize></creative>` +
          `</rval></getLineItemCreativeAssociationsByStatementResponse>`,
      ),
    );

    const info = await describeAssociation("7402987372", "138572612467");
    expect(info.found).toBe(true);
    expect(info.status).toBe("ACCEPTED");
    expect(info.size).toBe("300x250");
    expect(info.creativeName).toBe("Marca A");
  });
});

describe("selectFrame", () => {
  const frame = (id: string, width: number, height: number, ours: boolean) => ({
    id,
    width,
    height,
    ours,
    drift: 0,
  });

  test("returns null when there are no candidates", () => {
    expect(selectFrame([], "19028704/ThMais")).toBeNull();
  });

  test("prefers our network's frame over another network's at the same size", () => {
    const picked = selectFrame(
      [
        frame("google_ads_iframe_/7542,19028704/parceiros/Thmais_1", 300, 250, false),
        frame("google_ads_iframe_19028704/ThMais_7", 300, 250, true),
      ],
      "19028704/ThMais",
    );
    expect(picked?.id).toBe("google_ads_iframe_19028704/ThMais_7");
  });

  test("a 970x250 frame is not a candidate for a 300x250 target", () => {
    const candidates = [frame("google_ads_iframe_19028704/ThMais_0", 970, 250, true)].map((f) => ({
      ...f,
      drift: Math.abs(f.width - 300) + Math.abs(f.height - 250),
    }));
    expect(candidates[0]!.drift).toBe(670);
    expect(candidates.filter((f) => f.drift <= 4)).toHaveLength(0);
  });

  test("tolerates a 1px rendering drift", () => {
    const picked = selectFrame([frame("x", 301, 249, true)], "x");
    expect(picked?.width).toBe(301);
  });
});

describe("inkStdDev", () => {
  test("a flat image has near-zero deviation", async () => {
    const flat = await sharp({
      create: { width: 40, height: 40, channels: 3, background: "#ffffff" },
    })
      .jpeg()
      .toBuffer();
    expect(await inkStdDev(flat)).toBeLessThan(3);
  });

  test("a detailed image has clearly higher deviation", async () => {
    const noisy = await sharp({
      create: { width: 60, height: 60, channels: 3, background: "#000000" },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="60" height="60"><rect width="30" height="60" fill="#fff"/></svg>`,
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg()
      .toBuffer();
    expect(await inkStdDev(noisy)).toBeGreaterThan(20);
  });
});

describe("imagesMatch", () => {
  const svg = (inner: string) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="250">${inner}</svg>`);

  test("identical artwork matches", async () => {
    const art = svg('<rect width="300" height="250" fill="#123456"/><circle cx="150" cy="125" r="80" fill="#fff"/>');
    const ref = await sharp(art).jpeg().toBuffer();
    const shot = await sharp(art).jpeg({ quality: 70 }).toBuffer();
    const result = await imagesMatch(shot, ref);
    expect(result.match).toBe(true);
    expect(result.difference).toBeLessThan(5);
  });

  test("different artwork does not match", async () => {
    const a = await sharp(svg('<rect width="300" height="250" fill="#ffffff"/>')).jpeg().toBuffer();
    const b = await sharp(svg('<rect width="300" height="250" fill="#101010"/>')).jpeg().toBuffer();
    const result = await imagesMatch(a, b);
    expect(result.match).toBe(false);
    expect(result.difference).toBeGreaterThan(18);
  });

  test("a photo and a mostly-flat panel are told apart", async () => {
    const photo = await sharp({
      create: { width: 300, height: 250, channels: 3, background: "#334455" },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="300" height="250"><rect width="60" height="250" fill="#eee"/><rect x="200" width="100" height="250" fill="#111"/></svg>`,
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg()
      .toBuffer();
    const panel = await sharp({
      create: { width: 300, height: 250, channels: 3, background: "#f5f5f0" },
    })
      .jpeg()
      .toBuffer();
    expect((await imagesMatch(photo, panel)).match).toBe(false);
  });
});
