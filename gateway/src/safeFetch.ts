import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 8000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

export function validateTarget(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid url"); }
  if (u.protocol !== "https:") throw new Error("only https urls are allowed");
  if (u.username || u.password) throw new Error("credentials in url are not allowed");
  if (u.port && u.port !== "443") throw new Error("only port 443 is allowed");
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) throw new Error("ip literal hosts are not allowed");
  if (!u.hostname.includes(".") || u.hostname.endsWith(".local") || u.hostname.endsWith(".internal")) throw new Error("hostname not allowed");
  if (raw.length > 2048) throw new Error("url too long");
  return u;
}

// Single GET, no redirects; the socket only connects to addresses that pass isPrivateIp (checked at connect time, so DNS rebinding cannot bypass it).
export const safeFetch = ((input: string | URL | Request): Promise<Response> => {
  const u = validateTarget(String(input));
  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "SelectaRank-x402-preflight/1.0 (+mailto:selectarank@sales.tosaka-office.jp)" },
        timeout: TIMEOUT_MS,
        lookup: (host, opts, cb) => {
          dns.lookup(host, { ...(opts as object), all: true } as dns.LookupOptions & { all: true }, (err, addrs) => {
            if (err) return (cb as any)(err);
            const list = addrs as unknown as dns.LookupAddress[];
            if (!list.length || list.some((a) => isPrivateIp(a.address))) return (cb as any)(new Error("target resolves to a non-public address"));
            if ((opts as any)?.all) return (cb as any)(null, list);
            (cb as any)(null, list[0].address, list[0].family);
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
          else res.destroy();
        });
        const done = () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
          const status = res.statusCode ?? 0;
          resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status: status < 200 ? 502 : status, headers }));
        };
        res.on("end", done);
        res.on("close", done);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}) as typeof fetch;
