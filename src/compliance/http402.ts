/**
 * Validates a live x402 HTTP endpoint's 402 response against the spec.
 *
 * Checklist (per ops/BRIEF.md / task instructions): accepts array, scheme, network,
 * maxAmountRequired, payTo, asset, resource, description, mimeType, outputSchema.
 * These are the v1 field names (specs/x402-specification-v1.md section 5.1.2). We accept
 * the v2 equivalents too (amount instead of maxAmountRequired, top-level ResourceInfo
 * instead of per-item resource/description/mimeType) since the live spec (v2, dated
 * 2025-12-09) renamed them, and real facilitators emit a hybrid of both.
 *
 * IMPORTANT: this only ever issues a plain, unauthenticated GET. It never attaches an
 * X-PAYMENT header and never calls a facilitator's /verify or /settle. No payment is ever
 * made or attempted, per ops/BRIEF.md's "外向きの操作は一切しない" / "支払いをしない" rule.
 */

import type { PaymentRequiredBodyLoose, PaymentRequirementsLoose } from "../types.js";

export type FieldStatus = "present" | "missing" | "wrong_type";

export interface AcceptItemCheck {
  index: number;
  scheme: FieldStatus;
  network: FieldStatus;
  amount: FieldStatus; // maxAmountRequired (v1) or amount (v2)
  amountFieldUsed: "maxAmountRequired" | "amount" | "both" | "none";
  asset: FieldStatus;
  payTo: FieldStatus; // payTo (v1/v2) or recipient (CDP alias)
  payToFieldUsed: "payTo" | "recipient" | "both" | "none";
  resourceUrl: FieldStatus; // per-item resource (v1) or inherited from top-level (v2)
  description: FieldStatus;
  mimeType: FieldStatus;
  outputSchema: FieldStatus; // optional; "missing" is not a hard failure
  maxTimeoutSeconds: FieldStatus;
  coreOk: boolean; // scheme+network+amount+asset+payTo+resourceUrl+maxTimeoutSeconds all present
}

export interface HttpComplianceResult {
  url: string;
  timestamp: string;
  ok: boolean; // could we even reach the server / parse a response
  networkError?: string;
  httpStatus?: number;
  contentType?: string | null;
  isStatus402: boolean;
  bodyParsedAsJson: boolean;
  rawBodySnippet?: string;
  /**
   * Where the PaymentRequired payload was actually found. Per specs/transports-v1/http.md
   * the challenge is the JSON response BODY; per specs/transports-v2/http.md (the current
   * spec, 2025-12-9) it instead lives in a base64-encoded `PAYMENT-REQUIRED` response
   * header, and "response bodies are a server implementation concern" (often `{}`). Both
   * are treated as spec-compliant transports; we just record which one we saw.
   */
  transportStyle: "body" | "header" | "both" | "neither";
  paymentRequiredHeaderPresent: boolean;
  paymentRequiredHeaderDecodeError?: string;
  x402Version: FieldStatus;
  x402VersionValue?: number;
  errorField: FieldStatus; // "error" string (required in v1, optional in v2)
  acceptsArray: FieldStatus; // present and non-empty array
  acceptsCount: number;
  topLevelResourceInfo: "present" | "absent"; // v2-style top-level `resource` object
  acceptItems: AcceptItemCheck[];
  /** Core-required-fields compliant across the whole accepts array (spec-lenient: v1 OR v2 field names). */
  compliant: boolean;
  /** Compliant against every optional field too (description, mimeType, outputSchema all present). */
  strictlyCompliant: boolean;
  notes: string[];
}

function statusOf(value: unknown, expect: "string" | "number" | "object" | "array"): FieldStatus {
  if (value === undefined || value === null) return "missing";
  switch (expect) {
    case "string":
      return typeof value === "string" && value.length > 0 ? "present" : "wrong_type";
    case "number":
      return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
        ? "present"
        : "wrong_type";
    case "object":
      return typeof value === "object" ? "present" : "wrong_type";
    case "array":
      return Array.isArray(value) ? "present" : "wrong_type";
  }
}

function checkAcceptItem(
  item: PaymentRequirementsLoose,
  index: number,
  topLevelResource: { url?: unknown; description?: unknown; mimeType?: unknown } | undefined,
): AcceptItemCheck {
  const scheme = statusOf(item.scheme, "string");
  const network = statusOf(item.network, "string");

  const hasMax = statusOf(item.maxAmountRequired, "number") === "present";
  const hasAmount = statusOf(item.amount, "number") === "present";
  const amount: FieldStatus = hasMax || hasAmount ? "present" : "missing";
  const amountFieldUsed: AcceptItemCheck["amountFieldUsed"] =
    hasMax && hasAmount ? "both" : hasMax ? "maxAmountRequired" : hasAmount ? "amount" : "none";

  const asset = statusOf(item.asset, "string");

  const hasPayTo = statusOf(item.payTo, "string") === "present";
  const hasRecipient = statusOf(item.recipient, "string") === "present";
  const payTo: FieldStatus = hasPayTo || hasRecipient ? "present" : "missing";
  const payToFieldUsed: AcceptItemCheck["payToFieldUsed"] =
    hasPayTo && hasRecipient ? "both" : hasPayTo ? "payTo" : hasRecipient ? "recipient" : "none";

  // resource URL: v1 puts it per-item as a string; v2 moves it to the top-level ResourceInfo.url
  const perItemResource = statusOf(item.resource, "string");
  const topLevelUrl = topLevelResource ? statusOf(topLevelResource.url, "string") : "missing";
  const resourceUrl: FieldStatus = perItemResource === "present" || topLevelUrl === "present" ? "present" : "missing";

  const perItemDescription = statusOf(item.description, "string");
  const topLevelDescription = topLevelResource ? statusOf(topLevelResource.description, "string") : "missing";
  const description: FieldStatus =
    perItemDescription === "present" || topLevelDescription === "present" ? "present" : "missing";

  const perItemMime = statusOf(item.mimeType, "string");
  const topLevelMime = topLevelResource ? statusOf(topLevelResource.mimeType, "string") : "missing";
  const mimeType: FieldStatus = perItemMime === "present" || topLevelMime === "present" ? "present" : "missing";

  const outputSchema: FieldStatus =
    item.outputSchema !== undefined && item.outputSchema !== null ? "present" : "missing";

  const maxTimeoutSeconds = statusOf(item.maxTimeoutSeconds, "number");

  const coreOk =
    scheme === "present" &&
    network === "present" &&
    amount === "present" &&
    asset === "present" &&
    payTo === "present" &&
    resourceUrl === "present" &&
    maxTimeoutSeconds === "present";

  return {
    index,
    scheme,
    network,
    amount,
    amountFieldUsed,
    asset,
    payTo,
    payToFieldUsed,
    resourceUrl,
    description,
    mimeType,
    outputSchema,
    maxTimeoutSeconds,
    coreOk,
  };
}

const FETCH_TIMEOUT_MS = 10_000;

export async function checkHttpEndpoint(url: string, fetchImpl: typeof fetch = fetch): Promise<HttpComplianceResult> {
  const timestamp = new Date().toISOString();
  const notes: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    // Plain unauthenticated GET. No X-PAYMENT header, no facilitator call, no money moves.
    res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      url,
      timestamp,
      ok: false,
      networkError: err instanceof Error ? err.message : String(err),
      isStatus402: false,
      bodyParsedAsJson: false,
      transportStyle: "neither",
      paymentRequiredHeaderPresent: false,
      x402Version: "missing",
      errorField: "missing",
      acceptsArray: "missing",
      acceptsCount: 0,
      topLevelResourceInfo: "absent",
      acceptItems: [],
      compliant: false,
      strictlyCompliant: false,
      notes: ["network_error"],
    };
  } finally {
    clearTimeout(timer);
  }

  const httpStatus = res.status;
  const contentType = res.headers.get("content-type");
  const isStatus402 = httpStatus === 402;
  if (!isStatus402) {
    notes.push(`expected HTTP 402, got ${httpStatus}`);
  }
  if (contentType && !contentType.includes("application/json")) {
    notes.push(`Content-Type is not application/json (got "${contentType}")`);
  }

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch (err) {
    notes.push("could not read response body");
  }

  let body: PaymentRequiredBodyLoose | undefined;
  let bodyParsedAsJson = false;
  try {
    body = JSON.parse(bodyText);
    bodyParsedAsJson = true;
  } catch {
    // Not necessarily a problem: per specs/transports-v2/http.md the body is an
    // implementation-defined concern and may not be the PaymentRequired payload at all.
  }

  // Per specs/transports-v2/http.md (the current spec, 2025-12-9): the PaymentRequired
  // payload is delivered as base64-encoded JSON in a `PAYMENT-REQUIRED` response header,
  // NOT in the body. specs/transports-v1/http.md instead puts it in the JSON body. Real
  // servers observed in the wild (ops/S2S3/out/bazaar_raw_sample.json) do either, so we
  // check both and accept whichever one actually carries a valid payload.
  const paymentRequiredHeaderRaw = res.headers.get("payment-required");
  let headerBody: PaymentRequiredBodyLoose | undefined;
  let paymentRequiredHeaderDecodeError: string | undefined;
  if (paymentRequiredHeaderRaw) {
    try {
      const decoded = Buffer.from(paymentRequiredHeaderRaw, "base64").toString("utf8");
      headerBody = JSON.parse(decoded);
    } catch (err) {
      paymentRequiredHeaderDecodeError = err instanceof Error ? err.message : String(err);
      notes.push(`PAYMENT-REQUIRED header present but failed to base64/JSON decode: ${paymentRequiredHeaderDecodeError}`);
    }
  }

  const bodyHasAccepts = bodyParsedAsJson && Array.isArray(body?.accepts) && body!.accepts!.length > 0;
  const headerHasAccepts = !!headerBody && Array.isArray(headerBody.accepts) && headerBody.accepts.length > 0;

  let transportStyle: HttpComplianceResult["transportStyle"];
  let effectiveBody: PaymentRequiredBodyLoose | undefined;
  if (bodyHasAccepts && headerHasAccepts) {
    transportStyle = "both";
    effectiveBody = body;
  } else if (headerHasAccepts) {
    transportStyle = "header";
    effectiveBody = headerBody;
  } else if (bodyHasAccepts) {
    transportStyle = "body";
    effectiveBody = body;
  } else {
    // Neither carries a usable accepts[]; prefer whichever at least parsed, for field-level diagnostics.
    transportStyle = "neither";
    effectiveBody = headerBody ?? body;
  }

  if (!effectiveBody) {
    return {
      url,
      timestamp,
      ok: true,
      httpStatus,
      contentType,
      isStatus402,
      bodyParsedAsJson,
      rawBodySnippet: bodyText.slice(0, 500),
      transportStyle,
      paymentRequiredHeaderPresent: !!paymentRequiredHeaderRaw,
      paymentRequiredHeaderDecodeError,
      x402Version: "missing",
      errorField: "missing",
      acceptsArray: "missing",
      acceptsCount: 0,
      topLevelResourceInfo: "absent",
      acceptItems: [],
      compliant: false,
      strictlyCompliant: false,
      notes: bodyParsedAsJson || paymentRequiredHeaderRaw ? notes : [...notes, "no PaymentRequired payload found in body or PAYMENT-REQUIRED header"],
    };
  }

  const x402VersionStatus = statusOf(effectiveBody.x402Version, "number");
  const x402VersionValue = typeof effectiveBody.x402Version === "number" ? effectiveBody.x402Version : undefined;
  const errorField = statusOf(effectiveBody.error, "string");
  const acceptsArrayStatus = statusOf(effectiveBody.accepts, "array");
  const acceptsArr: PaymentRequirementsLoose[] = Array.isArray(effectiveBody.accepts) ? effectiveBody.accepts : [];

  const topLevelResource =
    effectiveBody.resource && typeof effectiveBody.resource === "object" && !Array.isArray(effectiveBody.resource)
      ? (effectiveBody.resource as { url?: unknown; description?: unknown; mimeType?: unknown })
      : undefined;

  const acceptItems = acceptsArr.map((item, i) => checkAcceptItem(item ?? {}, i, topLevelResource));

  const acceptsNonEmpty = acceptsArrayStatus === "present" && acceptsArr.length > 0;
  if (acceptsArrayStatus === "present" && acceptsArr.length === 0) {
    notes.push("accepts array is present but empty (checked both body and PAYMENT-REQUIRED header)");
  }

  const coreCompliant =
    isStatus402 &&
    x402VersionStatus === "present" &&
    acceptsNonEmpty &&
    acceptItems.every((a) => a.coreOk);

  const strictlyCompliant =
    coreCompliant &&
    errorField === "present" &&
    acceptItems.every((a) => a.description === "present" && a.mimeType === "present" && a.outputSchema === "present");

  return {
    url,
    timestamp,
    ok: true,
    httpStatus,
    contentType,
    isStatus402,
    bodyParsedAsJson,
    transportStyle,
    paymentRequiredHeaderPresent: !!paymentRequiredHeaderRaw,
    paymentRequiredHeaderDecodeError,
    x402Version: x402VersionStatus,
    x402VersionValue,
    errorField,
    acceptsArray: acceptsArrayStatus,
    acceptsCount: acceptsArr.length,
    topLevelResourceInfo: topLevelResource ? "present" : "absent",
    acceptItems,
    compliant: coreCompliant,
    strictlyCompliant,
    notes,
  };
}
