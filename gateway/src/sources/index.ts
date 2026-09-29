/**
 * Upstream free/public data sources bundled by this gateway.
 *
 * Selection rule (per ops/BRIEF.md S3): only sources whose terms explicitly allow
 * commercial reuse/redistribution/resale. ToS was checked by GET-fetching the official
 * policy page for each source on 2026-09-29 (see notes below and ops/S2S3/STATUS.md).
 * None of these three require an account or API key, so the gateway runs with zero
 * external setup.
 *
 *  1. USGS Earthquake GeoJSON feeds (earthquake.usgs.gov)
 *     License: U.S. Public Domain. "USGS-authored or produced data and information are
 *     considered to be in the U.S. Public Domain." No restriction on commercial resale.
 *     Source: https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits
 *
 *  2. NOAA National Weather Service API (api.weather.gov)
 *     License: U.S. Public Domain. "The information on National Weather Service (NWS) Web
 *     pages are in the public domain ... and may be used without charge for any lawful
 *     purpose", conditioned on (a) not claiming ownership/copyright, (b) not implying
 *     NOAA/NWS endorsement, (c) not misrepresenting modified content as official. No
 *     prohibition on commercial resale/redistribution.
 *     Source: https://www.weather.gov/disclaimer
 *     Technical requirement (not a ToS restriction): api.weather.gov asks clients to send
 *     an identifying User-Agent header, which this gateway does.
 *
 *  3. World Bank Open Data API (api.worldbank.org)
 *     License: CC BY 4.0 (default license for World Bank open data). "Allows users to
 *     copy, modify and distribute data in any format for any purpose, including
 *     commercial use", conditioned on giving attribution and flagging changes. This
 *     gateway republishes the data verbatim (no changes) and attributes "World Bank" in
 *     every response's `meta.source`/`meta.license` fields.
 *     Source: https://datacatalog.worldbank.org/public-licenses
 *
 * Excluded candidates and why (recorded per BRIEF's "規約を確認して記録する"):
 *  - CoinGecko free API: ToS restricts redistribution/resale on the free tier -> excluded.
 *  - OpenStreetMap/Nominatim: ODbL share-alike + a strict "no heavy scripted use" usage
 *    policy that is a poor fit for an always-on paid resale gateway -> excluded for now.
 *  - Japan e-Stat (政府統計の総合窓口): 政府標準利用規約2.0 permits commercial reuse but
 *    requires an `appId` (free registration) -> good v2 candidate, not included in this
 *    zero-setup local demo to keep `npm run gateway` runnable with no signup.
 */

const NWS_USER_AGENT = "x402-fact-letter-gateway (contact: sandbox test build, no production traffic)";

export interface SourceResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

async function safeFetchJson(url: string, headers: Record<string, string> = {}): Promise<SourceResult> {
  try {
    const res = await fetch(url, { headers });
    const status = res.status;
    if (!res.ok) {
      return { ok: false, status, error: `upstream returned HTTP ${status}` };
    }
    const data = await res.json();
    return { ok: true, status, data };
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchEarthquakes(feed: string): Promise<SourceResult> {
  const allowed = new Set([
    "significant_week",
    "significant_day",
    "4.5_week",
    "2.5_week",
    "all_day",
    "all_hour",
  ]);
  const safeFeed = allowed.has(feed) ? feed : "significant_week";
  return safeFetchJson(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${safeFeed}.geojson`);
}

export async function fetchWeatherPoint(lat: string, lon: string): Promise<SourceResult> {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return { ok: false, status: 400, error: "lat/lon must be numbers" };
  }
  const points = await safeFetchJson(`https://api.weather.gov/points/${latNum},${lonNum}`, {
    "User-Agent": NWS_USER_AGENT,
    Accept: "application/geo+json",
  });
  if (!points.ok) return points;
  const forecastUrl = (points.data as any)?.properties?.forecast;
  if (!forecastUrl) return { ok: false, status: 502, error: "no forecast URL in NWS points response" };
  return safeFetchJson(forecastUrl, { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" });
}

export async function fetchWorldBankIndicator(country: string, indicator: string): Promise<SourceResult> {
  const safeCountry = encodeURIComponent(country);
  const safeIndicator = encodeURIComponent(indicator);
  return safeFetchJson(
    `https://api.worldbank.org/v2/country/${safeCountry}/indicator/${safeIndicator}?format=json&per_page=10`,
  );
}
