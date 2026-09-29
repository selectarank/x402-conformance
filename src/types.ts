/**
 * x402 protocol types, hand-derived from the spec in coinbase/x402 (cloned into
 * ops/S2S3/research/x402 for this task):
 *   - specs/x402-specification-v1.md  (widely deployed shape: maxAmountRequired, outputSchema, ...)
 *   - specs/x402-specification-v2.md  (current spec, 2025-12-09: CAIP-2 networks, "amount",
 *     top-level ResourceInfo object instead of per-item resource/description/mimeType)
 *   - specs/transports-v1/http.md and transports-v2/http.md (402 signaling over HTTP)
 *
 * In practice (see ops/S2S3/out/bazaar_raw_sample.json, pulled live from the Bazaar
 * discovery API on 2026-09-29) facilitators emit BOTH old and new field names on the same
 * object for backward compatibility (e.g. both "amount" and "maxAmountRequired", both
 * "asset" and "currency", both "payTo" and "recipient"). The checker below treats either
 * spelling as satisfying the corresponding requirement and records which one it saw.
 */

export type X402Version = 1 | 2 | number;

/** A single entry of the `accepts` array, tolerant of v1 and v2 field names at once. */
export interface PaymentRequirementsLoose {
  scheme?: unknown;
  network?: unknown;
  // v1
  maxAmountRequired?: unknown;
  resource?: unknown; // v1: string URL. v2: absent here (moved to top-level ResourceInfo).
  description?: unknown; // v1: required string
  mimeType?: unknown; // v1: optional string
  outputSchema?: unknown; // v1: optional object|null
  // v2
  amount?: unknown;
  currency?: unknown;
  // common
  asset?: unknown;
  payTo?: unknown;
  recipient?: unknown; // seen as a v2/CDP alias of payTo in the wild
  maxTimeoutSeconds?: unknown;
  extra?: unknown;
  [key: string]: unknown;
}

export interface ResourceInfoV2 {
  url?: unknown;
  description?: unknown;
  mimeType?: unknown;
}

/** The JSON body of a 402 response, tolerant of v1 and v2 shapes at once. */
export interface PaymentRequiredBodyLoose {
  x402Version?: unknown;
  error?: unknown;
  accepts?: unknown;
  resource?: unknown; // v2 top-level ResourceInfo object
  extensions?: unknown;
  [key: string]: unknown;
}

export interface DiscoveredResource {
  resource: string;
  type: "http" | "mcp" | string;
  x402Version: number;
  accepts: PaymentRequirementsLoose[];
  lastUpdated?: string | number;
  metadata?: Record<string, unknown>;
  description?: string;
  serviceName?: string;
  /** source facilitator this was pulled from, added by our fetcher (not part of x402 spec) */
  _facilitator?: string;
}

export interface DiscoveryListResponse {
  x402Version: number;
  items: DiscoveredResource[];
  pagination?: { limit: number; offset: number; total: number };
}
