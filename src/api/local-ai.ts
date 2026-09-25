export type LocalAiConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type LocalAiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export class LocalAiError extends Error {
  constructor(public status: number, message: string) {
    super(`[本地 AI ${status}] ${message}`);
    this.name = "LocalAiError";
  }
}

export class LocalAiClient {
  constructor(private config: LocalAiConfig) {}

  async chat(messages: LocalAiMessage[], options: { temperature?: number; maxTokens?: number } = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60_000);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.config.apiKey?.trim()) headers.set("Authorization", `Bearer ${this.config.apiKey.trim()}`);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 512,
          stream: false,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = typeof payload === "object" && payload
          ? String((payload as Record<string, unknown>).error || (payload as Record<string, unknown>).message || response.statusText)
          : response.statusText;
        throw new LocalAiError(response.status, message);
      }
      const content = (payload as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
      if (!content) throw new LocalAiError(502, "本地模型没有返回有效内容");
      return content.trim();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new LocalAiError(408, "分析超时，请检查本地模型是否正在运行");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
