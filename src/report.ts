import type { HttpComplianceResult } from "./compliance/http402.js";
import type { McpComplianceResult } from "./compliance/mcp.js";

export interface HttpSweepSummary {
  total: number;
  networkErrors: number;
  wrongStatus: number; // reached the server, but not HTTP 402
  status402ButInvalid: number; // got 402, but body/fields fail the core checklist
  compliant: number; // 402 + all core fields present (v1 or v2 field names)
  strictlyCompliant: number; // compliant + all optional fields (description/mimeType/outputSchema) present
  nonCompliantRate: number; // (total - compliant) / total
  fieldPresenceRate: Record<string, number>; // per-field presence rate among reached (402) endpoints
  statusCodeHistogram: Record<string, number>;
  transportStyleHistogram: Record<string, number>; // body (v1) / header (v2) / both / neither
}

export function summarizeHttp(results: HttpComplianceResult[]): HttpSweepSummary {
  const total = results.length;
  const networkErrors = results.filter((r) => !r.ok).length;
  const reached = results.filter((r) => r.ok);
  const wrongStatus = reached.filter((r) => !r.isStatus402).length;
  const got402 = reached.filter((r) => r.isStatus402);
  const status402ButInvalid = got402.filter((r) => !r.compliant).length;
  const compliant = results.filter((r) => r.compliant).length;
  const strictlyCompliant = results.filter((r) => r.strictlyCompliant).length;

  const statusCodeHistogram: Record<string, number> = {};
  for (const r of reached) {
    const key = r.ok ? String(r.httpStatus) : "network_error";
    statusCodeHistogram[key] = (statusCodeHistogram[key] ?? 0) + 1;
  }
  statusCodeHistogram["network_error"] = networkErrors;

  const fieldNames = [
    "scheme",
    "network",
    "amount",
    "asset",
    "payTo",
    "resourceUrl",
    "description",
    "mimeType",
    "outputSchema",
    "maxTimeoutSeconds",
  ] as const;
  const fieldPresenceRate: Record<string, number> = {};
  const allItems = got402.flatMap((r) => r.acceptItems);
  for (const f of fieldNames) {
    const present = allItems.filter((i) => (i as any)[f] === "present").length;
    fieldPresenceRate[f] = allItems.length > 0 ? present / allItems.length : 0;
  }

  const transportStyleHistogram: Record<string, number> = {};
  for (const r of got402) {
    transportStyleHistogram[r.transportStyle] = (transportStyleHistogram[r.transportStyle] ?? 0) + 1;
  }

  return {
    total,
    networkErrors,
    wrongStatus,
    status402ButInvalid,
    compliant,
    strictlyCompliant,
    nonCompliantRate: total > 0 ? (total - compliant) / total : 0,
    fieldPresenceRate,
    statusCodeHistogram,
    transportStyleHistogram,
  };
}

export interface McpSweepSummary {
  total: number;
  networkErrors: number;
  initializeCompliant: number;
  toolsListCompliant: number;
  fullyCompliant: number;
  nonCompliantRate: number;
}

export function summarizeMcp(results: McpComplianceResult[]): McpSweepSummary {
  const total = results.length;
  const networkErrors = results.filter((r) => !r.ok).length;
  const initializeCompliant = results.filter(
    (r) =>
      r.ok &&
      r.initialize.jsonRpcValid &&
      r.initialize.protocolVersion === "present" &&
      r.initialize.capabilities === "present" &&
      r.initialize.serverInfo === "present",
  ).length;
  const toolsListCompliant = results.filter((r) => r.ok && r.toolsList.attempted && r.toolsList.jsonRpcValid && r.toolsList.toolsArray === "present").length;
  const fullyCompliant = results.filter((r) => r.compliant).length;
  return {
    total,
    networkErrors,
    initializeCompliant,
    toolsListCompliant,
    fullyCompliant,
    nonCompliantRate: total > 0 ? (total - fullyCompliant) / total : 0,
  };
}

function describeHttpIssue(r: HttpComplianceResult): string {
  if (r.notes.length) return r.notes[0];
  if (r.compliant) return "";
  if (r.acceptsCount === 0) return "accepts配列が空（支払い方法が1件も提示されていない）";
  const badFields = new Set<string>();
  for (const item of r.acceptItems) {
    if (!item.coreOk) {
      for (const f of ["scheme", "network", "amount", "asset", "payTo", "resourceUrl", "maxTimeoutSeconds"] as const) {
        if ((item as any)[f] !== "present") badFields.add(f);
      }
    }
  }
  return badFields.size ? `accepts[]の必須フィールド欠落: ${[...badFields].join(", ")}` : "";
}

export function renderMarkdownReport(opts: {
  fetchedAt: string;
  httpResults: HttpComplianceResult[];
  httpSummary: HttpSweepSummary;
  mcpResults: McpComplianceResult[];
  mcpSummary: McpSweepSummary;
}): string {
  const { fetchedAt, httpResults, httpSummary, mcpResults, mcpSummary } = opts;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  const lines: string[] = [];
  lines.push(`# x402 / MCP 公開エンドポイント 準拠チェック実測レポート`);
  lines.push("");
  lines.push(`- 実行日時: ${fetchedAt}`);
  lines.push(`- 対象の取得元: x402 Bazaar discovery API (Coinbase CDP facilitator, PayAI facilitator)`);
  lines.push(`- 検査方法: 各エンドポイントへ無認証の GET のみ送信。X-PAYMENT ヘッダは付けず、facilitator の /verify・/settle も一切呼んでいない（支払いなし）`);
  lines.push("");
  lines.push(`## HTTP x402 402応答チェック（n=${httpSummary.total}）`);
  lines.push("");
  lines.push(`| 指標 | 件数 | 割合 |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| 到達不能（ネットワークエラー・タイムアウト） | ${httpSummary.networkErrors} | ${pct(httpSummary.networkErrors / httpSummary.total)} |`);
  lines.push(`| 到達したが HTTP 402 以外を返した | ${httpSummary.wrongStatus} | ${pct(httpSummary.wrongStatus / httpSummary.total)} |`);
  lines.push(`| HTTP 402 だが必須フィールド欠落 | ${httpSummary.status402ButInvalid} | ${pct(httpSummary.status402ButInvalid / httpSummary.total)} |`);
  lines.push(`| **準拠**（402 + accepts配列の各項目が scheme/network/amount(maxAmountRequired)/asset/payTo/resource/maxTimeoutSeconds を充足） | ${httpSummary.compliant} | ${pct(httpSummary.compliant / httpSummary.total)} |`);
  lines.push(`| 厳格準拠（準拠 + description/mimeType/outputSchema も全充足） | ${httpSummary.strictlyCompliant} | ${pct(httpSummary.strictlyCompliant / httpSummary.total)} |`);
  lines.push("");
  lines.push(`**不合格率（非準拠率） = ${pct(httpSummary.nonCompliantRate)}**（n=${httpSummary.total}、準拠=${httpSummary.compliant}件）`);
  lines.push("");
  lines.push(`### HTTPステータスコード分布`);
  lines.push("");
  lines.push("| ステータス | 件数 |");
  lines.push("|---|---:|");
  for (const [k, v] of Object.entries(httpSummary.statusCodeHistogram).sort((a, b) => b[1] - a[1])) {
    if (v > 0) lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push(`### 402応答の伝送方式（v1: JSONボディ本体 / v2: PAYMENT-REQUIREDヘッダのbase64）`);
  lines.push("");
  lines.push("| 方式 | 件数 |");
  lines.push("|---|---:|");
  for (const [k, v] of Object.entries(httpSummary.transportStyleHistogram).sort((a, b) => b[1] - a[1])) {
    const label = k === "body" ? "body（v1方式）" : k === "header" ? "header（v2方式）" : k === "both" ? "両方" : "どちらにも有効なaccepts無し";
    lines.push(`| ${label} | ${v} |`);
  }
  lines.push("");
  lines.push(`### フィールド別 出現率（HTTP 402 を返した項目の accepts[] 内、v1/v2どちらの綴りでも可としてカウント）`);
  lines.push("");
  lines.push("| フィールド | 出現率 |");
  lines.push("|---|---:|");
  for (const [k, v] of Object.entries(httpSummary.fieldPresenceRate)) {
    lines.push(`| ${k} | ${pct(v)} |`);
  }
  lines.push("");
  lines.push(`### 個別エンドポイントの内訳`);
  lines.push("");
  lines.push("| URL | 到達 | HTTPステータス | 準拠 | 主な問題点 |");
  lines.push("|---|---|---:|---|---|");
  for (const r of httpResults) {
    const reach = r.ok ? "OK" : "NG";
    const status = r.ok ? String(r.httpStatus) : "-";
    const compliant = r.compliant ? "○" : "×";
    const issue = r.ok ? describeHttpIssue(r) : r.networkError ?? "";
    const shortUrl = r.url.length > 70 ? r.url.slice(0, 67) + "..." : r.url;
    lines.push(`| ${shortUrl} | ${reach} | ${status} | ${compliant} | ${issue.replace(/\|/g, "/")} |`);
  }
  lines.push("");

  lines.push(`## MCP initialize / tools/list チェック（n=${mcpSummary.total}）`);
  lines.push("");
  lines.push(`| 指標 | 件数 | 割合 |`);
  lines.push(`|---|---:|---:|`);
  lines.push(`| 到達不能 | ${mcpSummary.networkErrors} | ${mcpSummary.total > 0 ? pct(mcpSummary.networkErrors / mcpSummary.total) : "-"} |`);
  lines.push(`| initialize が仕様どおり通った | ${mcpSummary.initializeCompliant} | ${mcpSummary.total > 0 ? pct(mcpSummary.initializeCompliant / mcpSummary.total) : "-"} |`);
  lines.push(`| tools/list が仕様どおり通った | ${mcpSummary.toolsListCompliant} | ${mcpSummary.total > 0 ? pct(mcpSummary.toolsListCompliant / mcpSummary.total) : "-"} |`);
  lines.push(`| **両方準拠** | ${mcpSummary.fullyCompliant} | ${mcpSummary.total > 0 ? pct(mcpSummary.fullyCompliant / mcpSummary.total) : "-"} |`);
  lines.push("");
  lines.push(`**MCP 不合格率 = ${mcpSummary.total > 0 ? pct(mcpSummary.nonCompliantRate) : "n/a (サンプル0件)"}**`);
  lines.push("");
  lines.push("| URL | 到達 | initialize | tools/list | 主な問題点 |");
  lines.push("|---|---|---|---|---|");
  for (const r of mcpResults) {
    const reach = r.ok ? "OK" : "NG";
    const initOk =
      r.ok && r.initialize.jsonRpcValid && r.initialize.protocolVersion === "present" && r.initialize.capabilities === "present" && r.initialize.serverInfo === "present"
        ? "○"
        : "×";
    const toolsOk = r.ok && r.toolsList.attempted && r.toolsList.jsonRpcValid && r.toolsList.toolsArray === "present" ? "○" : r.toolsList.attempted ? "×" : "-";
    const issue = r.ok ? (r.notes.length ? r.notes[0] : "") : r.networkError ?? "";
    const shortUrl = r.url.length > 60 ? r.url.slice(0, 57) + "..." : r.url;
    lines.push(`| ${shortUrl} | ${reach} | ${initOk} | ${toolsOk} | ${issue.replace(/\|/g, "/")} |`);
  }
  lines.push("");
  lines.push(`## 検査方法についての注記`);
  lines.push("");
  lines.push(
    "- 「不合格」には2つの異なる原因が混在する: (a) 402ボディの必須フィールド欠落（純粋な仕様非準拠）と、(b) 無認証GETがそもそも402以外（400/404等）を返すケース（クエリパラメータ必須のエンドポイントに素のGETを送った結果である可能性があり、必ずしも仕様違反とは限らない）。個別内訳表の「主な問題点」列でどちらかを区別できる。",
  );
  lines.push(
    "- x402 の現行スペック（v2、2025-12-9改定）は `amount`/CAIP-2ネットワーク/トップレベル ResourceInfo を採用しているが、実際にBazaarへ掲載されている大半のエンドポイントは `maxAmountRequired` 等の旧v1綴りも同時に返しており（フィールド別出現率を参照）、事実上v1とv2のハイブリッドで運用されている。本チェッカーはどちらの綴りでも「準拠」として扱う（スペック上どちらも正当なため）。",
  );
  lines.push(
    "- **v1とv2で402応答の伝送場所そのものが違う**: specs/transports-v1/http.mdは PaymentRequired を JSONボディ本体で返す方式、specs/transports-v2/http.md（現行）は `PAYMENT-REQUIRED` ヘッダにbase64で載せる方式（ボディは実装依存、多くは `{}`）と規定している。本チェッカーはボディとヘッダの両方を確認し、どちらか一方にでも正当な accepts[] があれば準拠として扱う（上表「402応答の伝送方式」参照）。この区別を入れる前の初期実装では、v2ヘッダ方式のみを使うエンドポイント（body側が空の `{}` を返す）を誤って「accepts配列が空」と非準拠判定してしまっていた——本レポートの数値は修正後のもの。",
  );
  lines.push("- 実際の支払い（X-PAYMENTヘッダの送信、facilitatorへのverify/settle呼び出し）は一切行っていない。");
  return lines.join("\n");
}
