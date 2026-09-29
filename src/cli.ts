#!/usr/bin/env tsx
/**
 * CLI for the x402 / MCP compliance checker (S2).
 *
 * Usage:
 *   tsx src/cli.ts check <url>            # check one HTTP x402 endpoint's 402 response
 *   tsx src/cli.ts check-mcp <url>        # check one MCP server's initialize + tools/list
 *   tsx src/cli.ts sweep [--http N] [--mcp N] [--out DIR]
 *       Pull real endpoints from the x402 Bazaar discovery API and check all of them.
 *       Writes out/bazaar_raw_sample.json, out/compliance_report.json, out/compliance_report.md.
 *
 * This tool only ever performs unauthenticated GETs (HTTP check) or initialize/tools/list
 * JSON-RPC calls (MCP check). It never sends a payment, never calls tools/call, and never
 * hits a facilitator's /verify or /settle endpoint.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { checkHttpEndpoint } from "./compliance/http402.js";
import { checkMcpEndpoint } from "./compliance/mcp.js";
import { fetchBazaarSample } from "./bazaar/discovery.js";
import { summarizeHttp, summarizeMcp, renderMarkdownReport } from "./report.js";

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

async function cmdCheck(url: string) {
  const result = await checkHttpEndpoint(url);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.compliant ? 0 : 1);
}

async function cmdCheckMcp(url: string) {
  const result = await checkMcpEndpoint(url);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.compliant ? 0 : 1);
}

async function cmdSweep(flags: Record<string, string>) {
  const httpCount = Number(flags.http ?? 40);
  const mcpCount = Number(flags.mcp ?? 10);
  const outDir = flags.out ?? path.join(process.cwd(), "out");
  const concurrency = Number(flags.concurrency ?? 8);

  await mkdir(outDir, { recursive: true });

  console.error(`[sweep] fetching ~${httpCount} http + ${mcpCount} mcp resources from x402 Bazaar discovery API...`);
  const sample = await fetchBazaarSample({ httpCount, mcpCount });
  await writeFile(path.join(outDir, "bazaar_raw_sample.json"), JSON.stringify(sample, null, 2));
  console.error(
    `[sweep] got ${sample.httpResources.length} http + ${sample.mcpResources.length} mcp unique resources. totals reported: ${JSON.stringify(sample.totalsReported)}`,
  );

  async function runPool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;
    async function next(): Promise<void> {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
      return next();
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
    return results;
  }

  console.error(`[sweep] checking ${sample.httpResources.length} HTTP endpoints (plain GET, no payment)...`);
  const httpResults = await runPool(sample.httpResources, (r) => checkHttpEndpoint(r.resource));

  console.error(`[sweep] checking ${sample.mcpResources.length} MCP endpoints (initialize + tools/list only)...`);
  const mcpResults = await runPool(sample.mcpResources, (r) => checkMcpEndpoint(r.resource));

  const httpSummary = summarizeHttp(httpResults);
  const mcpSummary = summarizeMcp(mcpResults);

  const reportJson = {
    fetchedAt: sample.fetchedAt,
    httpSummary,
    mcpSummary,
    httpResults,
    mcpResults,
  };
  await writeFile(path.join(outDir, "compliance_report.json"), JSON.stringify(reportJson, null, 2));

  const md = renderMarkdownReport({ fetchedAt: sample.fetchedAt, httpResults, httpSummary, mcpResults, mcpSummary });
  await writeFile(path.join(outDir, "compliance_report.md"), md);

  console.error(`[sweep] done. http non-compliant rate = ${(httpSummary.nonCompliantRate * 100).toFixed(1)}% (n=${httpSummary.total})`);
  console.error(`[sweep] mcp non-compliant rate = ${mcpSummary.total > 0 ? (mcpSummary.nonCompliantRate * 100).toFixed(1) + "%" : "n/a"} (n=${mcpSummary.total})`);
  console.error(`[sweep] wrote ${outDir}/compliance_report.md and compliance_report.json`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "check") {
    if (!rest[0]) throw new Error("usage: check <url>");
    await cmdCheck(rest[0]);
  } else if (cmd === "check-mcp") {
    if (!rest[0]) throw new Error("usage: check-mcp <url>");
    await cmdCheckMcp(rest[0]);
  } else if (cmd === "sweep") {
    await cmdSweep(parseFlags(rest));
  } else {
    console.error("usage: tsx src/cli.ts <check|check-mcp|sweep> ...");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
