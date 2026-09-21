import { CloudflareClient, type CloudflareMail, normalizeCloudflareMail } from "./cloudflare";

export type UnifiedMessage = ReturnType<typeof normalizeCloudflareMail> & { provider: "cloudflare" | "163"; otp?: string };
export type ProviderStatus = { id: string; name: string; kind: "cloudflare" | "163"; connected: boolean; detail: string };

export interface MailProvider {
  readonly id: string;
  readonly name: string;
  listMessages(page?: number): Promise<UnifiedMessage[]>;
  getMessage(id: number | string): Promise<UnifiedMessage>;
  markRead(id: number | string, unread: boolean): Promise<void>;
  deleteMessage(id: number | string): Promise<void>;
  sendMessage(input: { to: string; subject: string; content: string }): Promise<void>;
}

export class CloudflareProvider implements MailProvider {
  readonly id = "cloudflare";
  readonly name = "Cloudflare 临时邮箱";
  constructor(private client: CloudflareClient) {}
  async listMessages(page = 1) {
    const result = await this.client.listMails(page, 20);
    return result.results.map((mail) => ({ ...normalizeCloudflareMail(mail), provider: "cloudflare" as const }));
  }
  async getMessage(id: number | string) { return { ...normalizeCloudflareMail(await this.client.getMail(id)), provider: "cloudflare" as const }; }
  async markRead(id: number | string, unread: boolean) { await this.client.markRead(id, unread); }
  async deleteMessage(id: number | string) { await this.client.deleteMail(id); }
  async sendMessage(input: { to: string; subject: string; content: string }) { await this.client.sendMail({ to_mail: input.to, subject: input.subject, content: input.content }); }
}

/**
 * 163 is intentionally represented as a native provider boundary. IMAP/SMTP
 * credentials must never be sent through the React webview; the next Rust
 * implementation will call this contract via Tauri commands and Windows
 * Credential Manager.
 */
export class NetEase163Provider implements MailProvider {
  readonly id = "163";
  readonly name = "163 邮箱";
  async listMessages(): Promise<UnifiedMessage[]> { throw new Error("163 邮箱尚未连接，请在设置中填写授权码"); }
  async getMessage(): Promise<UnifiedMessage> { throw new Error("163 邮箱尚未连接"); }
  async markRead(): Promise<void> { throw new Error("163 邮箱尚未连接"); }
  async deleteMessage(): Promise<void> { throw new Error("163 邮箱尚未连接"); }
  async sendMessage(): Promise<void> { throw new Error("163 邮箱尚未连接"); }
}

export function providersStatus(): ProviderStatus[] {
  return [
    { id: "cloudflare", name: "临时邮箱", kind: "cloudflare", connected: false, detail: "mail.kodao.site" },
    { id: "163", name: "163 邮箱", kind: "163", connected: false, detail: "IMAP / SMTP" },
  ];
}

export type { CloudflareMail };
