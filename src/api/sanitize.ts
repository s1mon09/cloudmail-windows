/**
 * 安全地从任意 HTML/文本中提取纯文本。
 * 优先使用 DOMParser 解析出 textContent——这是可靠、无注入风险的净化方式；
 * 仅在缺少 DOM（如 SSR/单测）时才退化为保守的正则剥离。
 * 用于替代原先依赖单一 `<[^>]+>` 正则的剥离（CodeQL js/bad-tag-filter、
 * js/incomplete-multi-character-sanitization 告警的来源），规避 XSS/污染风险。
 */
export function toPlainText(input: unknown): string {
  const raw = String(input ?? "");
  if (typeof DOMParser === "undefined" || typeof document === "undefined") {
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const doc = new DOMParser().parseFromString(raw, "text/html");
  doc.querySelectorAll("script, style, noscript, template").forEach((el) => el.remove());
  return (doc.body?.textContent || "").replace(/\s+/g, " ").trim();
}