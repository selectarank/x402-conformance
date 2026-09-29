# x402-conformance

A small TypeScript checker for x402 HTTP endpoints and MCP servers, plus a reference "bundled open-data" x402 gateway.

Site: https://selectarank.vercel.app (ecosystem data: https://selectarank-data.vercel.app)

## Checker (`src/`)

Checks an endpoint's `402 Payment Required` response against the x402 spec (v1 JSON-body transport and v2 `PAYMENT-REQUIRED` header transport): status code, `accepts[]` entries (scheme, network, amount, asset, payTo, resource, maxTimeoutSeconds), plus optional description / mimeType / outputSchema for a stricter grade. The MCP check does `initialize` + `tools/list`.

It only sends unauthenticated GETs / read-only JSON-RPC. It never pays, never calls `tools/call`, and never touches a facilitator's `/verify` or `/settle`.

```
npm install
npx tsx src/cli.ts check <url>
npx tsx src/cli.ts check-mcp <url>
npx tsx src/cli.ts sweep --http 40 --mcp 10   # samples the public Bazaar discovery API
```

Measured on 2026-09-29: 35 of 40 sampled Bazaar HTTP endpoints passed the basic check (12.5% non-compliant); 0 of 40 passed the strict check (description/mimeType/outputSchema); MCP initialize/tools/list 10/10 OK. Caveats: the sample is small and not random; a GET returning 405 may be a POST-only endpoint rather than a real defect. No per-endpoint results are published here.

## Gateway (`gateway/`)

An Express server using the official `@x402/express` middleware that bundles three free data sources behind pay-per-call routes: USGS earthquakes (public domain), NOAA/NWS weather (public domain) and World Bank indicators (CC BY 4.0; attribution required).

```
npm run gateway                          # TEST MODE: burn payTo address, Base Sepolia
EVM_PAYTO_ADDRESS=0x... npm run gateway  # your own wallet
curl -i localhost:4021/v1/earthquakes/significant_week   # expect HTTP 402
```

## Status / limitations

- Early (v0.1). Type-checks with `tsc`; the gateway was verified to return HTTP 402 challenges locally. No automated test suite.
- The gateway is a demo: prices are illustrative, defaults to the Base Sepolia testnet, and it is not deployed or listed on the Bazaar. `gateway/bazaar_listing_metadata.json` is unsubmitted draft metadata.
- Not an official x402 or Coinbase project.

License: MIT.
