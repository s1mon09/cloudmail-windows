export interface Env {
  DB: D1Database;
  SYNC_TOKEN: string;
}

type SyncItem = {
  account_ref: string;
  provider: "cloudflare" | "163";
  mail_id: string;
  is_read?: boolean;
  starred?: boolean;
  ai_result?: string;
  updated_at?: number;
};

function authorized(request: Request, env: Env) {
  const value = request.headers.get("Authorization") || "";
  return value === `Bearer ${env.SYNC_TOKEN}`;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "cloudmail-sync" });
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/v1/sync/pull" && request.method === "GET") {
      const account = url.searchParams.get("account_ref");
      if (!account) return json({ error: "account_ref is required" }, 400);
      const rows = await env.DB.prepare("SELECT account_ref, provider, mail_id, is_read, starred, ai_result, updated_at FROM mail_sync WHERE account_ref = ? ORDER BY updated_at DESC LIMIT 500").bind(account).all();
      return json({ items: rows.results });
    }
    if (url.pathname === "/v1/sync/push" && request.method === "POST") {
      const body = await request.json<{ items?: SyncItem[] }>().catch(() => ({}));
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      if (!items.length) return json({ accepted: 0 });
      const batch = items.map((item) => env.DB.prepare("INSERT INTO mail_sync (account_ref, provider, mail_id, is_read, starred, ai_result, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_ref, provider, mail_id) DO UPDATE SET is_read=excluded.is_read, starred=excluded.starred, ai_result=excluded.ai_result, updated_at=excluded.updated_at").bind(item.account_ref, item.provider, String(item.mail_id), item.is_read ? 1 : 0, item.starred ? 1 : 0, item.ai_result ? item.ai_result.slice(0, 12000) : null, item.updated_at || Date.now()));
      await env.DB.batch(batch);
      return json({ accepted: items.length });
    }
    return json({ error: "not_found" }, 404);
  },
};
