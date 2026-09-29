/**
 * S3: demand-side gateway (bundled resale) — runs locally only. Never deployed, never
 * listed on the Bazaar (per ops/BRIEF.md task scope). Bundles three permissively-licensed
 * free public data sources (see ./sources/index.ts for the ToS check on each) behind a
 * single set of x402-metered HTTP endpoints, using the official @x402/express middleware
 * for payment collection.
 *
 * payTo address: read from EVM_PAYTO_ADDRESS. If unset, the server starts in TEST MODE
 * using a well-known Ethereum burn address as a clearly-labeled placeholder — it will
 * still issue correct 402 challenges and (if a real facilitator settles a real payment
 * against it) funds would be unspendable, so nothing of value can accidentally move.
 *
 * Network: eip155:84532 (Base Sepolia testnet) by default — no mainnet funds are at risk
 * even outside test mode, unless FACILITATOR_NETWORK is explicitly overridden.
 *
 * Run: npm run gateway   (defaults to TEST MODE, http://localhost:4021)
 */
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { fetchEarthquakes, fetchWeatherPoint, fetchWorldBankIndicator } from "./sources/index.js";

const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;
const PORT = Number(process.env.PORT ?? 4021);
const NETWORK = (process.env.FACILITATOR_NETWORK ?? "eip155:84532") as `${string}:${string}`; // Base Sepolia testnet
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

const envPayTo = process.env.EVM_PAYTO_ADDRESS;
const testMode = !envPayTo;
const payTo = (envPayTo ?? BURN_ADDRESS) as `0x${string}`;

if (testMode) {
  console.warn("=".repeat(72));
  console.warn("TEST MODE: EVM_PAYTO_ADDRESS is not set.");
  console.warn(`Using placeholder payTo = ${BURN_ADDRESS} (a known unspendable burn address).`);
  console.warn("402 challenges will be issued correctly, but do not attempt a real payment");
  console.warn("against this address. Set EVM_PAYTO_ADDRESS to your own wallet to go live.");
  console.warn("=".repeat(72));
} else {
  console.log(`payTo = ${payTo} (from EVM_PAYTO_ADDRESS)`);
}
console.log(`network = ${NETWORK}, facilitator = ${FACILITATOR_URL}`);

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());

const app = express();

/**
 * Route price list. All prices are illustrative (this is a local demo, never deployed).
 * Each route bundles a bazaar-discoverable extension block so the metadata needed for a
 * future Bazaar listing already exists (see gateway/bazaar_listing_metadata.json), even
 * though we do not actually list it per BRIEF scope ("デプロイと掲載はしない").
 */
const routes = {
  "GET /v1/earthquakes/:feed": {
    accepts: [{ scheme: "exact" as const, price: "$0.002", network: NETWORK, payTo }],
    description: "USGS earthquake feed passthrough (public domain, US govt data). :feed is one of significant_week, significant_day, 4.5_week, 2.5_week, all_day, all_hour.",
    mimeType: "application/geo+json",
    extensions: {
      ...declareDiscoveryExtension({
        pathParamsSchema: {
          properties: { feed: { type: "string", description: "USGS feed name, e.g. significant_week" } },
          required: ["feed"],
        },
        output: { example: { type: "FeatureCollection", features: [] } },
      }),
    },
  },
  "GET /v1/weather/:lat/:lon": {
    accepts: [{ scheme: "exact" as const, price: "$0.003", network: NETWORK, payTo }],
    description: "NOAA/NWS forecast passthrough for a lat/lon point (public domain, US govt data). US locations only.",
    mimeType: "application/geo+json",
    extensions: {
      ...declareDiscoveryExtension({
        pathParamsSchema: {
          properties: {
            lat: { type: "string", description: "Latitude, e.g. 38.8894" },
            lon: { type: "string", description: "Longitude, e.g. -77.0352" },
          },
          required: ["lat", "lon"],
        },
        output: { example: { properties: { periods: [] } } },
      }),
    },
  },
  "GET /v1/worldbank/:country/:indicator": {
    accepts: [{ scheme: "exact" as const, price: "$0.002", network: NETWORK, payTo }],
    description: "World Bank open data indicator passthrough (CC BY 4.0, attribution: World Bank). e.g. country=JP, indicator=NY.GDP.MKTP.CD",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        pathParamsSchema: {
          properties: {
            country: { type: "string", description: "ISO country code, e.g. JP" },
            indicator: { type: "string", description: "World Bank indicator code, e.g. NY.GDP.MKTP.CD" },
          },
          required: ["country", "indicator"],
        },
        output: { example: { meta: { source: "World Bank" }, data: [] } },
      }),
    },
  },
};

app.use(paymentMiddleware(routes as any, server));

app.get("/v1/earthquakes/:feed", async (req, res) => {
  const result = await fetchEarthquakes(req.params.feed);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ meta: { source: "USGS", license: "US Public Domain", fetchedAt: new Date().toISOString() }, data: result.data });
});

app.get("/v1/weather/:lat/:lon", async (req, res) => {
  const result = await fetchWeatherPoint(req.params.lat, req.params.lon);
  if (!result.ok) return res.status(result.status >= 400 && result.status < 500 ? result.status : 502).json({ error: result.error });
  res.json({ meta: { source: "NOAA/NWS", license: "US Public Domain", fetchedAt: new Date().toISOString() }, data: result.data });
});

app.get("/v1/worldbank/:country/:indicator", async (req, res) => {
  const result = await fetchWorldBankIndicator(req.params.country, req.params.indicator);
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ meta: { source: "World Bank", license: "CC BY 4.0", attribution: "World Bank Open Data", fetchedAt: new Date().toISOString() }, data: result.data });
});

app.get("/healthz", (_req, res) => res.json({ ok: true, testMode, network: NETWORK }));

app.listen(PORT, () => {
  console.log(`x402 bundled-data gateway listening on http://localhost:${PORT}`);
  console.log(`try:  curl -i http://localhost:${PORT}/v1/earthquakes/significant_week   (expect HTTP 402)`);
});
