export type OtpCandidate = {
  value: string;
  kind: "numeric" | "alphanumeric" | "link";
  confidence: number;
  context: string;
};

import { toPlainText } from "./sanitize";

const CONTEXT = /(验证码|校验码|动态码|安全码|verification\s*code|security\s*code|one[- ]time password|otp)/i;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function stripHtml(value: string) {
  // 委托给基于 DOMParser 的安全净化，避免依赖单一正则剥离（CodeQL 告警）。
  return toPlainText(value);
}

export function findOtpCandidates(raw: string): OtpCandidate[] {
  const text = stripHtml(raw);
  const candidates: OtpCandidate[] = [];
  const lines = text.split(/[\n。.!！?？]/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!CONTEXT.test(line)) continue;
    const numeric = line.match(/\b\d[\d\s-]{3,9}\b/g) || [];
    for (const match of numeric) {
      const value = match.replace(/[\s-]/g, "");
      if (value.length >= 4 && value.length <= 8 && !/^20\d{2}/.test(value)) candidates.push({ value, kind: "numeric", confidence: 0.96, context: line.slice(0, 140) });
    }
    const alpha = line.match(/\b[A-Z0-9]{5,10}\b/gi) || [];
    for (const match of alpha) {
      if (/\d/.test(match) && /[A-Z]/i.test(match)) candidates.push({ value: match, kind: "alphanumeric", confidence: 0.9, context: line.slice(0, 140) });
    }
    const link = line.match(URL_RE)?.[0];
    if (link) candidates.push({ value: link, kind: "link", confidence: 0.84, context: line.slice(0, 140) });
  }
  return candidates.filter((item, index, list) => list.findIndex((other) => other.value === item.value) === index);
}
