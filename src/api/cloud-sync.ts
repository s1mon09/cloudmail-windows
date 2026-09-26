export type SyncItem = {
  account_ref: string;
  provider: "cloudflare" | "163";
  mail_id: string;
  is_read?: boolean;
  starred?: boolean;
  ai_result?: string;
  updated_at?: number;
};

export class CloudSyncClient {
  constructor(private baseUrl: string, private token: string) {}

  private headers() {
    return { "content-type": "application/json", authorization: `Bearer ${this.token}` };
  }

  async push(items: SyncItem[]) {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/sync/push`, { method: "POST", headers: this.headers(), body: JSON.stringify({ items }) });
    if (!response.ok) throw new Error(`云同步失败（${response.status}）`);
    return response.json() as Promise<{ accepted: number }>;
  }

  async pull(accountRef: string) {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/sync/pull?account_ref=${encodeURIComponent(accountRef)}`, { headers: this.headers() });
    if (!response.ok) throw new Error(`云端读取失败（${response.status}）`);
    return response.json() as Promise<{ items: SyncItem[] }>;
  }
}
