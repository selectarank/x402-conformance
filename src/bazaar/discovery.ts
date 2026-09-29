/**
 * Fetches real, currently-listed endpoints from the x402 Bazaar discovery API so the
 * compliance checker can be run against endpoints that actually exist in the wild, per
 * ops/BRIEF.md ("x402 Bazaar の discovery API から実在のエンドポイントを50件ほど取り、実際に検査する").
 *
 * Two facilitators are known (per docs/extensions/bazaar.mdx in the cloned x402 repo) to
 * expose GET /discovery/resources publicly:
 *   - Coinbase CDP:  https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
 *   - PayAI:         https://facilitator.payai.network/discovery/resources
 *
 * Both were reachable with a plain GET on 2026-09-29 (see out/bazaar_raw_sample.json for a
 * saved snapshot). This module only ever performs GETs against public discovery endpoints,
 * per the BRIEF's "読むだけの取得（GET、公開ページ・公開API）は可" rule.
 */

import type { DiscoveredResource, DiscoveryListResponse } from "../types.js";

export const FACILITATORS = {
  cdp: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
  payai: "https://facilitator.payai.network/discovery/resources",
} as const;

async function fetchPage(baseUrl: string, params: Record<string, string | number>): Promise<DiscoveryListResponse> {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`discovery fetch failed: ${url.toString()} -> HTTP ${res.status}`);
  }
  return (await res.json()) as DiscoveryListResponse;
}

export interface FetchSampleOptions {
  httpCount: number;
  mcpCount: number;
}

export interface BazaarSample {
  fetchedAt: string;
  sources: string[];
  httpResources: DiscoveredResource[];
  mcpResources: DiscoveredResource[];
  totalsReported: Record<string, number>;
}

function dedupeByResource(items: DiscoveredResource[]): DiscoveredResource[] {
  const seen = new Set<string>();
  const out: DiscoveredResource[] = [];
  for (const item of items) {
    const key = item.resource;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function fetchBazaarSample(opts: FetchSampleOptions): Promise<BazaarSample> {
  const totalsReported: Record<string, number> = {};
  const httpItems: DiscoveredResource[] = [];
  const mcpItems: DiscoveredResource[] = [];

  for (const [name, base] of Object.entries(FACILITATORS)) {
    try {
      const httpPage = await fetchPage(base, { type: "http", limit: 100, offset: 0 });
      totalsReported[`${name}_http_total`] = httpPage.pagination?.total ?? httpPage.items.length;
      for (const it of httpPage.items) httpItems.push({ ...it, _facilitator: name });
    } catch (err) {
      totalsReported[`${name}_http_error`] = 1;
      console.error(`[bazaar] ${name} http discovery failed:`, (err as Error).message);
    }

    try {
      const mcpPage = await fetchPage(base, { type: "mcp", limit: 100, offset: 0 });
      totalsReported[`${name}_mcp_total`] = mcpPage.pagination?.total ?? mcpPage.items.length;
      for (const it of mcpPage.items) mcpItems.push({ ...it, _facilitator: name });
    } catch (err) {
      totalsReported[`${name}_mcp_error`] = 1;
      console.error(`[bazaar] ${name} mcp discovery failed:`, (err as Error).message);
    }
  }

  const dedupedHttp = dedupeByResource(httpItems);
  const dedupedMcp = dedupeByResource(
    mcpItems.map((it) => ({ ...it, resource: it.resource.split("#")[0] })), // MCP tools share one server URL; strip #toolName
  );

  return {
    fetchedAt: new Date().toISOString(),
    sources: Object.values(FACILITATORS),
    httpResources: dedupedHttp.slice(0, opts.httpCount),
    mcpResources: dedupedMcp.slice(0, opts.mcpCount),
    totalsReported,
  };
}
