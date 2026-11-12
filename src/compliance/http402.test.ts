// Regression tests for value-level and cross-transport checks in http402.ts. Each test
// builds a minimal 402 response and asserts the checker correctly flags the planted
// defect instead of reporting compliant: true. Run with: node --import tsx --test src/compliance/http402.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHttpEndpoint } from "./http402.js";

const GOOD_ACCEPT = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "999",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 300,
  resource: "http://localhost/api/data",
};

function fakeFetchReturning(status: number, body: unknown, headers: Record<string, string> = {}) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

test("a fully correct accept item is compliant", async () => {
  const fetchImpl = fakeFetchReturning(402, { x402Version: 1, error: "X402_PAYMENT_REQUIRED", accepts: [GOOD_ACCEPT] });
  const result = await checkHttpEndpoint("http://example.test/api/data", fetchImpl as unknown as typeof fetch);
  assert.equal(result.compliant, true);
});

test("a typo in scheme is no longer silently accepted", async () => {
  const accept = { ...GOOD_ACCEPT, scheme: "exac" };
  const fetchImpl = fakeFetchReturning(402, { x402Version: 1, error: "X402_PAYMENT_REQUIRED", accepts: [accept] });
  const result = await checkHttpEndpoint("http://example.test/api/data", fetchImpl as unknown as typeof fetch);
  assert.equal(result.compliant, false);
  assert.equal(result.acceptItems[0].scheme, "invalid_value");
});

test("a negative amount is no longer silently accepted", async () => {
  const accept = { ...GOOD_ACCEPT, maxAmountRequired: "-999" };
  const fetchImpl = fakeFetchReturning(402, { x402Version: 1, error: "X402_PAYMENT_REQUIRED", accepts: [accept] });
  const result = await checkHttpEndpoint("http://example.test/api/data", fetchImpl as unknown as typeof fetch);
  assert.equal(result.compliant, false);
  assert.equal(result.acceptItems[0].amount, "invalid_value");
});

test("network and asset swapped is no longer silently accepted", async () => {
  const accept = { ...GOOD_ACCEPT, network: GOOD_ACCEPT.asset, asset: GOOD_ACCEPT.network };
  const fetchImpl = fakeFetchReturning(402, { x402Version: 1, error: "X402_PAYMENT_REQUIRED", accepts: [accept] });
  const result = await checkHttpEndpoint("http://example.test/api/data", fetchImpl as unknown as typeof fetch);
  assert.equal(result.compliant, false);
  assert.equal(result.acceptItems[0].network, "invalid_value");
  assert.equal(result.acceptItems[0].asset, "invalid_value");
});

test("a numeric amount instead of the spec string type is no longer silently accepted", async () => {
  const accept = { ...GOOD_ACCEPT, maxAmountRequired: 999 };
  const fetchImpl = fakeFetchReturning(402, { x402Version: 1, error: "X402_PAYMENT_REQUIRED", accepts: [accept] });
  const result = await checkHttpEndpoint("http://example.test/api/data", fetchImpl as unknown as typeof fetch);
  assert.equal(result.compliant, false);
  assert.equal(result.acceptItems[0].amount, "invalid_value");
});

test("a body/header amount mismatch is now caught", async () => {
  const headerAccept = { ...GOOD_ACCEPT, maxAmountRequired: "500" };
  const headerPayload = Buffer.from(JSON.stringify({ accepts: [headerAccept] })).toString("base64");
  const fetchImpl = fakeFetchReturning(
    402,
    { x402Version: 1, error: "X402_PAYMENT_REQUIRED", accepts: [GOOD_ACCEPT] },
    { "payment-required": headerPayload },
  );
  const result = await checkHttpEndpoint("http://example.test/api/data", fetchImpl as unknown as typeof fetch);
  assert.equal(result.compliant, false);
  assert.equal(result.transportMismatch, true);
});

test("a body/header amount match is still compliant", async () => {
  const headerPayload = Buffer.from(JSON.stringify({ accepts: [GOOD_ACCEPT] })).toString("base64");
  const fetchImpl = fakeFetchReturning(
    402,
    { x402Version: 1, error: "X402_PAYMENT_REQUIRED", accepts: [GOOD_ACCEPT] },
    { "payment-required": headerPayload },
  );
  const result = await checkHttpEndpoint("http://example.test/api/data", fetchImpl as unknown as typeof fetch);
  assert.equal(result.compliant, true);
  assert.equal(result.transportMismatch, false);
});
