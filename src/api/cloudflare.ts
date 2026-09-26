import { toPlainText } from "./sanitize";

export type CloudflareMail = {
  id: number | string;
  source?: string;
  subject?: string;
  sender?: string;
  message?: string;
  text?: string;
  date?: string;
  is_unread?: number;
  originalSource?: string;
  attachment?: unknown[];
  attachments?: Array<{ filename?: string; mimeType?: string; disposition?: string; size?: number; [key: string]: unknown }>;
  [key: string]: unknown;
};

export type CloudflareSettings = {
  address?: string;
  enableMailReadStatus?: boolean;
  enableUserDeleteEmail?: boolean;
  enableSendMail?: boolean;
  [key: string]: unknown;
};

export type CloudflareOpenSettings = {
  title?: string;
  domains?: string[];
  needAuth?: boolean;
  enableAddressPassword?: boolean;
  enableUserCreateEmail?: boolean;
  [key: string]: unknown;
};

export type MailPage = { results: CloudflareMail[]; count: number };

export type ParsedMail = CloudflareMail & {
  sender?: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename?: string; mimeType?: string; disposition?: string; size?: number; [key: string]: unknown }>;
};

export class CloudflareApiError extends Error {
  constructor(public status: number, message: string, public payload?: unknown) {
    super(`[${status}] ${message}`);
    this.name = "CloudflareApiError";
  }
}

function fingerprint() {
  const key = "cloudmail-device-fingerprint";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value = crypto.randomUUID();
  localStorage.setItem(key, value);
  return value;
}

export class CloudflareClient {
  private token = "";

  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setToken(token: string) { this.token = token.trim(); }
  getToken() { return this.token; }

  private async request<T>(path: string, init: RequestInit = {}, options: { auth?: boolean } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("x-lang", "zh-CN");
    headers.set("x-fingerprint", fingerprint());
    if (options.auth !== false && this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CloudflareApiError(408, "请求超时，请检查网络或 API 地址");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const message = typeof payload === "object" && payload
        ? String((payload as Record<string, unknown>).message || (payload as Record<string, unknown>).error || response.statusText)
        : String(payload || response.statusText);
      throw new CloudflareApiError(response.status, message, payload);
    }
    return payload as T;
  }

  getOpenSettings() { return this.request<CloudflareOpenSettings>("/open_api/settings", {}, { auth: false }); }

  async credentialLogin(credential: string, cfToken = "") {
    await this.request("/open_api/credential_login", { method: "POST", body: JSON.stringify({ credential, cf_token: cfToken }) }, { auth: false });
    this.token = credential;
    return this.getSettings();
  }

  async passwordLogin(email: string, passwordHash: string, cfToken = "") {
    const result = await this.request<{ jwt: string }>("/api/address_login", { method: "POST", body: JSON.stringify({ email, password: passwordHash, cf_token: cfToken }) }, { auth: false });
    this.token = result.jwt;
    return this.getSettings();
  }

  getSettings() { return this.request<CloudflareSettings>("/api/settings"); }

  listMails(page = 1, pageSize = 20) {
    const offset = Math.max(0, (page - 1) * pageSize);
    return this.request<MailPage>(`/api/mails?limit=${pageSize}&offset=${offset}`);
  }

  getMail(id: number | string) { return this.request<CloudflareMail>(`/api/mail/${encodeURIComponent(String(id))}`); }

  listParsedMails(page = 1, pageSize = 20) {
    const offset = Math.max(0, (page - 1) * pageSize);
    return this.request<{ results: ParsedMail[]; count: number }>(`/api/parsed_mails?limit=${pageSize}&offset=${offset}`);
  }

  getParsedMail(id: number | string) { return this.request<ParsedMail>(`/api/parsed_mail/${encodeURIComponent(String(id))}`); }

  markRead(id: number | string, isUnread: boolean) {
    return this.request(`/api/mails/${encodeURIComponent(String(id))}/read`, { method: "PATCH", body: JSON.stringify({ isUnread }) });
  }

  deleteMail(id: number | string) {
    return this.request(`/api/mails/${encodeURIComponent(String(id))}`, { method: "DELETE" });
  }

  clearInbox() { return this.request("/api/clear_inbox", { method: "DELETE" }); }

  deleteAddress() { return this.request("/api/delete_address", { method: "DELETE" }); }

  sendMail(input: { to_mail: string; subject: string; content: string; from_name?: string; to_name?: string; is_html?: boolean }) {
    return this.request("/api/send_mail", { method: "POST", body: JSON.stringify(input) });
  }

  createAddress(name = "", domain = "", cfToken = "") {
    return this.request<{ jwt: string; password?: string }>("/api/new_address", { method: "POST", body: JSON.stringify({ name, domain, cf_token: cfToken, enableRandomSubdomain: false }) }, { auth: false });
  }
}

export function normalizeCloudflareMail(mail: CloudflareMail) {
  const source = String(mail.sender || mail.source || mail.originalSource || "未知发件人");
  const address = source.match(/<([^>]+)>/)?.[1] || (source.includes("@") ? source : "");
  // 仅取出尖括号之前的显示名，并用 DOMParser 安全净化，避免标签剥录取代。
  const senderName = source.split("<")[0].replace(/[<>]/g, "").trim();
  const sender = toPlainText(senderName) || address || "未知发件人";
  return {
    id: Number(mail.id), sender, address,
    subject: String(mail.subject || "无主题"),
    preview: toPlainText(mail.text || mail.message || "").slice(0, 100),
    time: mail.date ? new Date(mail.date).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "刚刚",
    unread: mail.is_unread === 1,
    color: "#64748b",
    raw: mail,
    attachments: mail.attachments || mail.attachment || [],
  };
}
