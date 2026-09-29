/**
 * Validates a public MCP server's Streamable HTTP transport against the MCP spec
 * (https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle and
 * .../basic/transports), independent of x402. Checks that `initialize` and `tools/list`
 * behave per spec:
 *
 *  - initialize: client sends protocolVersion/capabilities/clientInfo; server MUST reply
 *    with its own protocolVersion/capabilities/serverInfo. Transport MAY hand back an
 *    Mcp-Session-Id header, which must then be echoed on subsequent requests.
 *  - tools/list: MUST return { tools: [...] }, each tool having a `name` (string) and an
 *    `inputSchema` (object); `description` is optional but expected in practice.
 *
 * This never calls `tools/call`, so no paid tool is ever invoked and no payment is made.
 */

export type FieldStatus = "present" | "missing" | "wrong_type";

export interface McpToolCheck {
  name: FieldStatus;
  description: FieldStatus;
  inputSchema: FieldStatus;
}

export interface McpComplianceResult {
  url: string;
  timestamp: string;
  ok: boolean;
  networkError?: string;
  initialize: {
    httpStatus?: number;
    contentType?: string | null;
    transportKind?: "json" | "sse" | "unknown";
    jsonRpcValid: boolean;
    protocolVersion: FieldStatus;
    capabilities: FieldStatus;
    serverInfo: FieldStatus;
    sessionId?: string;
    rawError?: string;
  };
  toolsList: {
    attempted: boolean;
    httpStatus?: number;
    jsonRpcValid: boolean;
    toolsArray: FieldStatus;
    toolsCount: number;
    tools: McpToolCheck[];
    rawError?: string;
  };
  compliant: boolean;
  notes: string[];
}

const FETCH_TIMEOUT_MS = 10_000;
const PROTOCOL_VERSION = "2025-06-18";

function statusOfStr(v: unknown): FieldStatus {
  if (v === undefined || v === null) return "missing";
  return typeof v === "string" && v.length > 0 ? "present" : "wrong_type";
}
function statusOfObj(v: unknown): FieldStatus {
  if (v === undefined || v === null) return "missing";
  return typeof v === "object" ? "present" : "wrong_type";
}

/** Parses either a plain JSON body or a minimal SSE stream ("data: {...}" lines) into the first JSON-RPC message found. */
async function parseJsonRpcResponse(res: Response): Promise<{ kind: "json" | "sse" | "unknown"; payload: any | undefined; raw: string }> {
  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();
  if (contentType.includes("application/json")) {
    try {
      return { kind: "json", payload: JSON.parse(raw), raw };
    } catch {
      return { kind: "json", payload: undefined, raw };
    }
  }
  if (contentType.includes("text/event-stream")) {
    // Minimal SSE parse: look for the first "data: {...}" event block.
    const blocks = raw.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length > 0) {
        const joined = dataLines.join("\n");
        try {
          return { kind: "sse", payload: JSON.parse(joined), raw };
        } catch {
          continue;
        }
      }
    }
    return { kind: "sse", payload: undefined, raw };
  }
  // Some servers omit/mislabel Content-Type; try JSON as a fallback.
  try {
    return { kind: "unknown", payload: JSON.parse(raw), raw };
  } catch {
    return { kind: "unknown", payload: undefined, raw };
  }
}

async function postJsonRpc(
  url: string,
  body: unknown,
  sessionId: string | undefined,
): Promise<{ res: Response; parsed: Awaited<ReturnType<typeof parseJsonRpcResponse>> } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = await parseJsonRpcResponse(res);
    return { res, parsed };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkMcpEndpoint(url: string): Promise<McpComplianceResult> {
  const timestamp = new Date().toISOString();
  const notes: string[] = [];

  const initReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "x402-fact-letter-compliance-checker", version: "0.1.0" },
    },
  };

  const initResult = await postJsonRpc(url, initReq, undefined);
  if ("error" in initResult) {
    return {
      url,
      timestamp,
      ok: false,
      networkError: initResult.error,
      initialize: {
        jsonRpcValid: false,
        protocolVersion: "missing",
        capabilities: "missing",
        serverInfo: "missing",
        rawError: initResult.error,
      },
      toolsList: { attempted: false, jsonRpcValid: false, toolsArray: "missing", toolsCount: 0, tools: [] },
      compliant: false,
      notes: ["network_error_on_initialize"],
    };
  }

  const { res: initRes, parsed: initParsed } = initResult;
  const sessionId = initRes.headers.get("mcp-session-id") || undefined;
  const initPayload = initParsed.payload;
  const initJsonRpcValid =
    !!initPayload && initPayload.jsonrpc === "2.0" && initPayload.id === 1 && !!initPayload.result;
  const result = initPayload?.result ?? {};
  const protocolVersionStatus = statusOfStr(result.protocolVersion);
  const capabilitiesStatus = statusOfObj(result.capabilities);
  const serverInfoStatus = statusOfObj(result.serverInfo);

  if (initRes.status !== 200) notes.push(`initialize: expected HTTP 200, got ${initRes.status}`);
  if (!initJsonRpcValid) notes.push("initialize: response is not a valid JSON-RPC 2.0 result for id=1");
  if (protocolVersionStatus !== "present") notes.push("initialize: result.protocolVersion missing");
  if (capabilitiesStatus !== "present") notes.push("initialize: result.capabilities missing");
  if (serverInfoStatus !== "present") notes.push("initialize: result.serverInfo missing");

  const initCompliant =
    initRes.status === 200 && initJsonRpcValid && protocolVersionStatus === "present" && capabilitiesStatus === "present" && serverInfoStatus === "present";

  // Best-effort "initialized" notification (per spec the client MUST send this; servers
  // generally tolerate it being skipped, but we send it for a faithful handshake).
  await postJsonRpc(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  ).catch(() => undefined);

  // tools/list
  if (!initCompliant) {
    return {
      url,
      timestamp,
      ok: true,
      initialize: {
        httpStatus: initRes.status,
        contentType: initRes.headers.get("content-type"),
        transportKind: initParsed.kind,
        jsonRpcValid: initJsonRpcValid,
        protocolVersion: protocolVersionStatus,
        capabilities: capabilitiesStatus,
        serverInfo: serverInfoStatus,
        sessionId,
      },
      toolsList: { attempted: false, jsonRpcValid: false, toolsArray: "missing", toolsCount: 0, tools: [] },
      compliant: false,
      notes: [...notes, "skipped tools/list because initialize did not pass"],
    };
  }

  const toolsReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const toolsResult = await postJsonRpc(url, toolsReq, sessionId);
  if ("error" in toolsResult) {
    return {
      url,
      timestamp,
      ok: true,
      initialize: {
        httpStatus: initRes.status,
        contentType: initRes.headers.get("content-type"),
        transportKind: initParsed.kind,
        jsonRpcValid: initJsonRpcValid,
        protocolVersion: protocolVersionStatus,
        capabilities: capabilitiesStatus,
        serverInfo: serverInfoStatus,
        sessionId,
      },
      toolsList: { attempted: true, jsonRpcValid: false, toolsArray: "missing", toolsCount: 0, tools: [], rawError: toolsResult.error },
      compliant: false,
      notes: [...notes, `tools/list: network error: ${toolsResult.error}`],
    };
  }

  const { res: toolsRes, parsed: toolsParsed } = toolsResult;
  const toolsPayload = toolsParsed.payload;
  const toolsJsonRpcValid = !!toolsPayload && toolsPayload.jsonrpc === "2.0" && toolsPayload.id === 2 && !!toolsPayload.result;
  const toolsArrRaw = toolsPayload?.result?.tools;
  const toolsArrayStatus: FieldStatus = Array.isArray(toolsArrRaw) ? "present" : toolsArrRaw === undefined ? "missing" : "wrong_type";
  const toolsArr: any[] = Array.isArray(toolsArrRaw) ? toolsArrRaw : [];

  const tools: McpToolCheck[] = toolsArr.map((t) => ({
    name: statusOfStr(t?.name),
    description: statusOfStr(t?.description),
    inputSchema: statusOfObj(t?.inputSchema),
  }));

  if (toolsRes.status !== 200) notes.push(`tools/list: expected HTTP 200, got ${toolsRes.status}`);
  if (!toolsJsonRpcValid) notes.push("tools/list: response is not a valid JSON-RPC 2.0 result for id=2");
  if (toolsArrayStatus !== "present") notes.push("tools/list: result.tools is not an array");
  const everyToolOk = tools.every((t) => t.name === "present" && t.inputSchema === "present");
  if (toolsArrayStatus === "present" && !everyToolOk) notes.push("tools/list: at least one tool is missing name/inputSchema");

  const toolsCompliant = toolsRes.status === 200 && toolsJsonRpcValid && toolsArrayStatus === "present" && everyToolOk;

  return {
    url,
    timestamp,
    ok: true,
    initialize: {
      httpStatus: initRes.status,
      contentType: initRes.headers.get("content-type"),
      transportKind: initParsed.kind,
      jsonRpcValid: initJsonRpcValid,
      protocolVersion: protocolVersionStatus,
      capabilities: capabilitiesStatus,
      serverInfo: serverInfoStatus,
      sessionId,
    },
    toolsList: {
      attempted: true,
      httpStatus: toolsRes.status,
      jsonRpcValid: toolsJsonRpcValid,
      toolsArray: toolsArrayStatus,
      toolsCount: toolsArr.length,
      tools,
    },
    compliant: initCompliant && toolsCompliant,
    notes,
  };
}
