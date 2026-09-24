export interface Env {
  UPSTREAM_API: string;
  GATEWAY_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
}

const json = (data: unknown, status = 200, origin = "*") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type, x-fingerprint, x-lang",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "cache-control": "no-store",
  },
});

function safeOrigin(request: Request, env: Env) {
  const requested = request.headers.get("origin");
  if (!env.ALLOWED_ORIGIN || env.ALLOWED_ORIGIN === "*") return "*";
  return requested === env.ALLOWED_ORIGIN ? requested : env.ALLOWED_ORIGIN;
}

function isPublicPath(path: string) {
  return path === "/open_api/settings" || path === "/health";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = safeOrigin(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type, x-fingerprint, x-lang, x-gateway-token", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS" } });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cloudmail-gateway", upstream: env.UPSTREAM_API }, 200, origin);
    if (!env.UPSTREAM_API) return json({ error: "UPSTREAM_API is not configured" }, 500, origin);

    const gatewayToken = env.GATEWAY_TOKEN?.trim();
    if (gatewayToken && !isPublicPath(url.pathname) && request.headers.get("x-gateway-token") !== gatewayToken) {
      return json({ error: "gateway authentication required" }, 401, origin);
    }

    const upstream = new URL(url.pathname + url.search, env.UPSTREAM_API.replace(/\/+$/, ""));
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("x-gateway-token");
    headers.set("x-forwarded-host", url.host);
    const response = await fetch(new Request(upstream, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body, redirect: "follow" }));
    const output = new Response(response.body, response);
    output.headers.set("access-control-allow-origin", origin);
    output.headers.set("cache-control", "no-store");
    return output;
  },
} satisfies ExportedHandler<Env>;

export {}; 
