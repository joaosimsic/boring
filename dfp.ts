const API_HOST = "https://ads.google.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/dfp",
  "https://www.googleapis.com/auth/admanager",
];

export interface DfpSettings {
  networkCode: string;
  applicationName: string;
  apiVersion: string;
}

export interface AssociationInfo {
  found: boolean;
  status?: string;
  size?: string;
  creativeId?: string;
  creativeName?: string;
  creativeStatus?: string;
  overrideSize?: boolean;
  lineItemId?: string;
  lineItemName?: string;
  lineItemStatus?: string;
  targetedSizes?: string[];
}

export interface NativeStylePreview {
  nativeStyleId: string;
  url: string;
}

export class DfpError extends Error {
  constructor(message: string, readonly reason?: string) {
    super(message);
    this.name = "DfpError";
  }
}

interface XmlNode {
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXml(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function parseXml(source: string): XmlNode {
  const clean = source
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, body: string) => escapeText(body));

  const root: XmlNode = { local: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tagRe = /<\s*(\/)?\s*([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?\s*>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(clean)) !== null) {
    const [full, closing, name, attrRaw, selfClose] = match as unknown as [
      string,
      string | undefined,
      string,
      string,
      string | undefined,
    ];
    const node = stack[stack.length - 1]!;
    const chunk = clean.slice(cursor, match.index);
    if (chunk.trim()) node.text += decodeEntities(chunk);
    cursor = tagRe.lastIndex;

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const attrs: Record<string, string> = {};
    const attrRe = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(attrRaw)) !== null) {
      attrs[attr[1]!] = decodeEntities(attr[2] ?? attr[3] ?? "");
    }

    const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
    const child: XmlNode = { local, attrs, children: [], text: "" };
    node.children.push(child);
    if (!selfClose) stack.push(child);
  }

  return root;
}

function findAll(node: XmlNode, local: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of node.children) {
    if (child.local === local) out.push(child);
    out.push(...findAll(child, local));
  }
  return out;
}

function first(node: XmlNode, local: string): XmlNode | undefined {
  return findAll(node, local)[0];
}

function textOf(node: XmlNode | undefined, local: string): string | undefined {
  if (!node) return undefined;
  const found = first(node, local);
  return found ? found.text.trim() : undefined;
}

function sizeOf(node: XmlNode | undefined): string | undefined {
  const width = textOf(node, "width");
  const height = textOf(node, "height");
  if (width === undefined || height === undefined) return undefined;
  return `${width}x${height}`;
}

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

let cachedToken: { value: string; expiresAt: number } | null = null;
let preferredScopeIndex = 0;

export function resetTokenCache(): void {
  cachedToken = null;
  preferredScopeIndex = 0;
}

export function dfpSettings(): DfpSettings {
  const networkCode = Bun.env.DFP_NETWORK_CODE;
  if (!networkCode) {
    throw new DfpError("DFP_NETWORK_CODE is not set; cannot generate preview URLs");
  }
  return {
    networkCode,
    applicationName: Bun.env.DFP_APPLICATION_NAME ?? "boring",
    apiVersion: Bun.env.DFP_API_VERSION ?? "v202602",
  };
}

export function dfpConfigured(): boolean {
  if (!Bun.env.DFP_NETWORK_CODE) return false;
  return Boolean(
    Bun.env.DFP_SERVICE_ACCOUNT_JSON ||
      (Bun.env.DFP_CLIENT_ID && Bun.env.DFP_CLIENT_SECRET && Bun.env.DFP_REFRESH_TOKEN),
  );
}

async function serviceAccountAssertion(
  keyPath: string,
  scope: string,
  impersonatedEmail?: string,
): Promise<string> {
  const key = (await Bun.file(keyPath).json()) as {
    client_email: string;
    private_key: string;
  };
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key) as unknown as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims: Record<string, unknown> = {
    iss: key.client_email,
    scope,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  if (impersonatedEmail) claims.sub = impersonatedEmail;
  const payload = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

async function requestToken(body: URLSearchParams): Promise<{
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new DfpError(
      `Ad Manager OAuth failed (${response.status}): ${
        payload.error_description ?? payload.error ?? "unknown error"
      }`,
    );
  }
  return payload;
}

async function serviceAccountToken(keyPath: string): Promise<string> {
  const ordered = [preferredScopeIndex, ...SCOPES.map((_, i) => i)].filter(
    (value, index, all) => all.indexOf(value) === index,
  );
  let lastError: unknown;
  for (const index of ordered) {
    try {
      const payload = await requestToken(
        new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: await serviceAccountAssertion(
            keyPath,
            SCOPES[index]!,
            Bun.env.DFP_IMPERSONATE_EMAIL,
          ),
        }),
      );
      preferredScopeIndex = index;
      cachedToken = {
        value: payload.access_token!,
        expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
      };
      return cachedToken.value;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new DfpError(String(lastError));
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const keyPath = Bun.env.DFP_SERVICE_ACCOUNT_JSON;
  if (keyPath) return serviceAccountToken(keyPath);

  const clientId = Bun.env.DFP_CLIENT_ID;
  const clientSecret = Bun.env.DFP_CLIENT_SECRET;
  const refreshToken = Bun.env.DFP_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new DfpError(
      "No Ad Manager credentials found. Set DFP_SERVICE_ACCOUNT_JSON, or " +
        "DFP_CLIENT_ID + DFP_CLIENT_SECRET + DFP_REFRESH_TOKEN.",
    );
  }

  const payload = await requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  );
  cachedToken = {
    value: payload.access_token!,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function soapCall(
  service: string,
  action: string,
  inner: string,
  settings: DfpSettings = dfpSettings(),
): Promise<XmlNode> {
  const namespace = `https://www.google.com/apis/ads/publisher/${settings.apiVersion}`;
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<SOAP-ENV:Header>` +
    `<ns1:RequestHeader xmlns:ns1="${namespace}">` +
    `<ns1:networkCode>${escapeXml(settings.networkCode)}</ns1:networkCode>` +
    `<ns1:applicationName>${escapeXml(settings.applicationName)}</ns1:applicationName>` +
    `</ns1:RequestHeader>` +
    `</SOAP-ENV:Header>` +
    `<SOAP-ENV:Body>${inner.replaceAll("{ns}", namespace)}</SOAP-ENV:Body>` +
    `</SOAP-ENV:Envelope>`;

  const token = await getAccessToken();
  const response = await fetch(
    `${API_HOST}/apis/ads/publisher/${settings.apiVersion}/${service}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=UTF-8",
        SOAPAction: "",
        Authorization: `Bearer ${token}`,
      },
      body: envelope,
    },
  );

  const xml = await response.text();
  const root = parseXml(xml);

  if (first(root, "Fault")) {
    const reason = textOf(root, "reason");
    const detail = textOf(root, "errorString") ?? textOf(root, "faultstring");
    throw new DfpError(
      `${action} failed${reason ? `: ${reason}` : ""}${detail ? ` (${detail})` : ""}`,
      reason,
    );
  }
  if (!response.ok) {
    throw new DfpError(`${action} failed with HTTP ${response.status}: ${xml.slice(0, 400)}`);
  }
  return root;
}

function requireRval(root: XmlNode, action: string): string {
  const rval = first(root, "rval");
  if (!rval || !rval.text.trim()) {
    throw new DfpError(`${action} returned no URL`);
  }
  return rval.text.trim();
}

export async function getPreviewUrl(
  lineItemId: string,
  creativeId: string,
  siteUrl: string,
  settings?: DfpSettings,
): Promise<string> {
  const inner =
    `<getPreviewUrl xmlns="{ns}">` +
    `<lineItemId>${escapeXml(lineItemId)}</lineItemId>` +
    `<creativeId>${escapeXml(creativeId)}</creativeId>` +
    `<siteUrl>${escapeXml(siteUrl)}</siteUrl>` +
    `</getPreviewUrl>`;
  const root = await soapCall("LineItemCreativeAssociationService", "getPreviewUrl", inner, settings);
  return requireRval(root, "getPreviewUrl");
}

export async function getPreviewUrlsForNativeStyles(
  lineItemId: string,
  creativeId: string,
  siteUrl: string,
  settings?: DfpSettings,
): Promise<NativeStylePreview[]> {
  const inner =
    `<getPreviewUrlsForNativeStyles xmlns="{ns}">` +
    `<lineItemCreativeAssociation>` +
    `<lineItemId>${escapeXml(lineItemId)}</lineItemId>` +
    `<creativeId>${escapeXml(creativeId)}</creativeId>` +
    `</lineItemCreativeAssociation>` +
    `<siteUrl>${escapeXml(siteUrl)}</siteUrl>` +
    `</getPreviewUrlsForNativeStyles>`;
  const root = await soapCall(
    "LineItemCreativeAssociationService",
    "getPreviewUrlsForNativeStyles",
    inner,
    settings,
  );
  return findAll(root, "CreativeNativeStylePreview")
    .map((node) => ({
      nativeStyleId: textOf(node, "nativeStyleId") ?? "",
      url: textOf(node, "previewUrl") ?? "",
    }))
    .filter((entry) => entry.url.length > 0);
}

export interface NetworkSummary {
  id?: string;
  displayName?: string;
  networkCode?: string;
  effectiveRootAdUnit?: string;
  testNetwork?: boolean;
}

export async function listNetworks(settings?: DfpSettings): Promise<NetworkSummary[]> {
  const inner = `<getAllNetworks xmlns="{ns}"/>`;
  const version = settings?.apiVersion ?? "v202602";
  const root = await soapCall("NetworkService", "getAllNetworks", inner, {
    networkCode: "0",
    applicationName: settings?.applicationName ?? "boring",
    apiVersion: version,
  });
  return findAll(root, "rval").map((node) => ({
    id: textOf(node, "id"),
    displayName: textOf(node, "displayName"),
    networkCode: textOf(node, "networkCode"),
    effectiveRootAdUnit: textOf(node, "effectiveRootAdUnitId"),
    testNetwork: textOf(node, "isTest") === "true",
  }));
}

export interface CreativeInfo {
  id?: string;
  name?: string;
  width?: number;
  height?: number;
  overrideSize: boolean;
  advertiserId?: string;
  assetUrl?: string;
}

export interface LineItemInfo {
  id?: string;
  name?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  sizes: string[];
  placementIds: string[];
  adUnitIds: string[];
  customCriteria: Array<{ keyId: string; valueIds: string[]; operator: string }>;
}

function isoDate(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const y = textOf(node, "year");
  const m = textOf(node, "month");
  const d = textOf(node, "day");
  if (!y || !m || !d) return undefined;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

export async function getCreative(
  creativeId: string,
  settings?: DfpSettings,
): Promise<CreativeInfo | null> {
  const inner =
    `<getCreativesByStatement xmlns="{ns}"><filterStatement>` +
    `<query>WHERE id = ${escapeXml(creativeId)}</query>` +
    `</filterStatement></getCreativesByStatement>`;
  const root = await soapCall("CreativeService", "getCreativesByStatement", inner, settings);
  const rval = first(root, "rval");
  if (!rval) return null;
  const size = first(rval, "size");
  const asset = first(rval, "primaryImageAsset");
  return {
    id: textOf(rval, "id"),
    name: textOf(rval, "name"),
    width: size ? Number(textOf(size, "width")) : undefined,
    height: size ? Number(textOf(size, "height")) : undefined,
    overrideSize: textOf(rval, "overrideSize") === "true",
    advertiserId: textOf(rval, "advertiserId"),
    assetUrl: asset ? textOf(asset, "assetUrl") : undefined,
  };
}

export async function getLineItem(
  lineItemId: string,
  settings?: DfpSettings,
): Promise<LineItemInfo | null> {
  const inner =
    `<getLineItemsByStatement xmlns="{ns}"><filterStatement>` +
    `<query>WHERE id = ${escapeXml(lineItemId)}</query>` +
    `</filterStatement></getLineItemsByStatement>`;
  const root = await soapCall("LineItemService", "getLineItemsByStatement", inner, settings);
  const rval = first(root, "rval");
  if (!rval) return null;

  const customTargeting = first(rval, "customTargeting");
  const customCriteria: LineItemInfo["customCriteria"] = [];
  for (const node of customTargeting ? findAll(customTargeting, "children") : []) {
    if (node.attrs["xsi:type"] !== "CustomCriteria") continue;
    const valueIds = findAll(node, "valueIds").map((v) => v.text.trim());
    customCriteria.push({
      keyId: textOf(node, "keyId") ?? "",
      valueIds,
      operator: textOf(node, "operator") ?? "",
    });
  }

  return {
    id: textOf(rval, "id"),
    name: textOf(rval, "name"),
    status: textOf(rval, "status"),
    startDate: isoDate(first(rval, "startDateTime")),
    endDate: isoDate(first(rval, "endDateTime")),
    sizes: findAll(rval, "creativePlaceholders")
      .map((node) => sizeOf(node))
      .filter((v): v is string => Boolean(v)),
    placementIds: findAll(rval, "targetedPlacementIds").map((n) => n.text.trim()),
    adUnitIds: findAll(rval, "adUnitId").map((n) => n.text.trim()),
    customCriteria,
  };
}

export async function describeAssociation(
  lineItemId: string,
  creativeId: string,
  settings?: DfpSettings,
): Promise<AssociationInfo> {
  const inner =
    `<getLineItemCreativeAssociationsByStatement ` +
    `xmlns="{ns}">` +
    `<filterStatement><query>WHERE lineItemId = ${escapeXml(lineItemId)} AND ` +
    `creativeId = ${escapeXml(creativeId)}</query></filterStatement>` +
    `</getLineItemCreativeAssociationsByStatement>`;
  const root = await soapCall(
    "LineItemCreativeAssociationService",
    "getLineItemCreativeAssociationsByStatement",
    inner,
    settings,
  );

  const page = first(root, "LineItemCreativeAssociationPage");
  const nested = page ? first(page, "LineItemCreativeAssociation") : undefined;
  const flat = first(root, "LineItemCreativeAssociation");
  const rval = first(root, "rval");
  const loose = rval && textOf(rval, "lineItemId") ? rval : undefined;
  const result = nested ?? flat ?? loose;
  if (!result) return { found: false };

  const creative = first(result, "creative");
  const lineItem = first(result, "lineItem");
  const targeting = creative ? first(creative, "targeting") : undefined;

  return {
    found: true,
    status: textOf(result, "status"),
    size: sizeOf(result),
    creativeId: textOf(result, "creativeId"),
    creativeName: textOf(creative, "name"),
    creativeStatus: textOf(creative, "status"),
    overrideSize: textOf(creative, "overrideSize") === "true",
    lineItemId: textOf(result, "lineItemId"),
    lineItemName: textOf(lineItem, "name"),
    lineItemStatus: textOf(lineItem, "status"),
    targetedSizes: targeting
      ? findAll(targeting, "size")
          .map((node) => node.text.trim())
          .filter((value) => value.length > 0)
      : undefined,
  };
}

export function extractPreviewParams(previewUrl: string): Record<string, string> {
  const parsed = new URL(previewUrl);
  const params: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) params[key] = value;
  return params;
}
