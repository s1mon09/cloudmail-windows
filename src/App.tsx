import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CloudflareClient, normalizeCloudflareMail, type ParsedMail } from "./api/cloudflare";
import { findOtpCandidates } from "./api/otp";
import { LocalAiClient } from "./api/local-ai";
import { MAIL_ANALYSIS_SYSTEM_PROMPT, buildMailAnalysisPrompt } from "./api/ai-prompts";
import { CloudSyncClient } from "./api/cloud-sync";
import "./App.css";

type Mail = {
  id: number;
  sender: string;
  address: string;
  subject: string;
  preview: string;
  time: string;
  unread?: boolean;
  otp?: string;
  tag?: string;
  color: string;
  body?: string;
  html?: string;
  attachments?: unknown[];
  starred?: boolean;
  provider?: "cloudflare" | "163";
};

const mails: Mail[] = [];

const EMPTY_MAIL: Mail = {
  id: 0, sender: "", address: "",
  subject: "没有更多邮件", preview: "",
  time: "", color: "#64748b",
};

const navItems = [
  ["收件箱", "⌁", "12"], ["验证码", "◇", "3"], ["已加星标", "☆", ""], ["草稿", "✎", "1"], ["已发送", "↗", ""], ["垃圾邮件", "⊘", ""],
];

function App() {
  const [selected, setSelected] = useState(1);
  const [folder, setFolder] = useState("收件箱");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<"all" | "unread" | "attachments" | "otp">("all");
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [apiBase, setApiBase] = useState("https://email.kodao.site");
  const [credential, setCredential] = useState("");
  const [apiStatus, setApiStatus] = useState("演示数据");
  const [remoteMails, setRemoteMails] = useState<Mail[] | null>(null);
  const [client, setClient] = useState<CloudflareClient | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [mailTotal, setMailTotal] = useState(0);
  const [mailPage, setMailPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());
  const [aiBaseUrl, setAiBaseUrl] = useState(() => localStorage.getItem("cloudmail-ai-base") || "http://localhost:8000/v1");
  const [aiModel, setAiModel] = useState(() => localStorage.getItem("cloudmail-ai-model") || "Qwen3.5-9B-AWQ");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiAnalysis, setAiAnalysis] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [syncBaseUrl, setSyncBaseUrl] = useState(() => sessionStorage.getItem("cloudmail-sync-base") || "");
  const [syncToken, setSyncToken] = useState(() => sessionStorage.getItem("cloudmail-sync-token") || "");
  const [syncLoading, setSyncLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailCache = useRef(new Map<number, Mail>());
  const [neteaseEmail, setNeteaseEmail] = useState("");
  const [neteaseCode, setNeteaseCode] = useState("");
  const [neteaseMails, setNeteaseMails] = useState<Mail[] | null>(null);
  const [activeProvider, setActiveProvider] = useState<"cloudflare" | "163">("cloudflare");
  const [cloudAddress, setCloudAddress] = useState("mail.kodao.site");
  const [showCreate, setShowCreate] = useState(false);
  const [tempName, setTempName] = useState("");
  const [tempDomain, setTempDomain] = useState("");
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);

  const selectFolder = (label: string) => {
    setFolder(label);
    if (label === "验证码") setFilter("otp");
    else if (label === "收件箱") setFilter("all");
    else if (label === "已加星标") setActionStatus("星标邮件筛选已启用");
    else setActionStatus(`${label}功能正在接入，当前按钮已响应`);
  };

  const sourceMails = activeProvider === "163" ? (neteaseMails ?? []) : (remoteMails ?? mails);
  const activeMail = sourceMails.find((mail) => mail.id === selected) ?? sourceMails[0] ?? EMPTY_MAIL;
  const visibleMails = useMemo(() => sourceMails.filter((mail) => {
    const text = `${mail.sender} ${mail.address} ${mail.subject} ${mail.preview}`.toLowerCase();
    const matchesFolder = folder !== "已加星标" || starredIds.has(mail.id);
    const matchesFilter = filter === "all"
      || (filter === "unread" && mail.unread)
      || (filter === "attachments" && Boolean(mail.attachments?.length))
      || (filter === "otp" && Boolean(mail.otp));
    return matchesFolder && matchesFilter && text.includes(deferredQuery.toLowerCase());
  }), [deferredQuery, filter, folder, sourceMails, starredIds]);

  const aiSections = useMemo(() => {
    if (!aiAnalysis) return [];
    return aiAnalysis.split(/(?=【(?:摘要|验证码|关键链接|风险等级|风险依据|建议|置信度)】)/g).map((part) => {
      const match = part.match(/^【([^】]+)】\s*([\s\S]*)$/);
      return match ? { title: match[1], content: match[2].trim() } : { title: "分析结果", content: part.trim() };
    }).filter((part) => part.content);
  }, [aiAnalysis]);

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("get_secret", { account: "cloudflare-credential" }).then((saved) => {
      if (saved && !cancelled) { setCredential(saved); void connectCloudflare(saved); }
    }).catch(() => undefined);
    invoke<string | null>("get_secret", { account: "netease-credential" }).then((saved) => {
      if (!saved || cancelled) return;
      const nl = saved.indexOf("\n");
      const email = nl > 0 ? saved.slice(0, nl) : saved;
      const code = nl > 0 ? saved.slice(nl + 1) : "";
      setNeteaseEmail(email); setNeteaseCode(code);
      if (email && code) void connectNetease(email, code);
    }).catch(() => undefined);
    invoke<string | null>("get_secret", { account: "ai-api-key" }).then((saved) => {
      if (saved && !cancelled) setAiApiKey(saved);
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const connectCloudflare = async (provided?: string) => {
    const target = (provided ?? credential).trim();
    if (!target) { setApiStatus("请输入邮箱凭据"); return; }
    setApiStatus("连接中…");
    try {
      const apiClient = new CloudflareClient(apiBase);
      const settings = await apiClient.credentialLogin(target);
      await invoke("save_secret", { account: "cloudflare-credential", secret: target });
      const result = await apiClient.listParsedMails(1, 20);
      setClient(apiClient);
      setRemoteMails(result.results.map(toMail));
      setMailTotal(result.count);
      setMailPage(1);
      if (settings.address) setCloudAddress(settings.address);
      setApiStatus(`已连接 · ${settings.address || "Cloudflare 邮箱"}`);
      setShowSettings(false);
      void syncCloudPull(settings.address || cloudAddress);
    } catch (error) {
      setApiStatus(error instanceof Error ? error.message : "连接失败");
    }
  };

  const toMail = (mail: ParsedMail): Mail => {
    const normalized = normalizeCloudflareMail(mail);
    const body = String(mail.text || mail.html || mail.message || "");
    const otp = findOtpCandidates(`${mail.subject || ""}\n${body}`)[0]?.value;
    return { ...normalized, body, html: mail.html, otp, tag: otp ? "验证码" : "实时", color: "#f38020", provider: "cloudflare" } as Mail;
  };

  const toNeteaseMail = (m: { id: number; subject: string; sender: string; date: string; unread: boolean; body?: string }): Mail => ({
    id: m.id, sender: m.sender || "未知发件人", address: "", subject: m.subject || "无主题",
    preview: m.body ? m.body.replace(/\s+/g, " ").slice(0, 100) : "",
    time: m.date ? m.date.replace("T", " ").slice(5, 16) : "",
    unread: m.unread, body: m.body, provider: "163", color: "#d62828", tag: "163",
  });

  const connectNetease = async (providedEmail?: string, providedCode?: string) => {
    const email = (providedEmail ?? neteaseEmail).trim();
    const code = (providedCode ?? neteaseCode).trim();
    if (!email || !code) { setActionStatus("请输入 163 邮箱和授权码"); return; }
    setActionStatus("连接 163…"); setLoading(true);
    try {
      const metas = await invoke<Array<{ id: number; subject: string; sender: string; date: string; unread: boolean }>>(
        "netease_list_emails", { email, code });
      await invoke("save_secret", { account: "netease-credential", secret: `${email}\n${code}` });
      setNeteaseMails(metas.map(toNeteaseMail));
      setActiveProvider("163"); setFolder("收件箱"); setFilter("all");
      setShowSettings(false);
      setActionStatus(`已连接 163 · ${metas.length} 封邮件`);
      void syncCloudPull(email);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  const refreshInbox = async () => {
    if (activeProvider === "163") {
      if (!neteaseEmail.trim() || !neteaseCode.trim()) { setShowSettings(true); return; }
      setLoading(true); setActionStatus("");
      try {
        const metas = await invoke<Array<{ id: number; subject: string; sender: string; date: string; unread: boolean }>>("netease_list_emails", { email: neteaseEmail.trim(), code: neteaseCode.trim() });
        setNeteaseMails(metas.map(toNeteaseMail));
        setActionStatus(`已更新 163 邮箱 ${metas.length} 封邮件`);
      } catch (error) { setActionStatus(error instanceof Error ? error.message : "163 刷新失败"); }
      finally { setLoading(false); }
      return;
    }
    if (!client) { setShowSettings(true); return; }
    setLoading(true); setActionStatus("");
    try {
      const result = await client.listParsedMails(1, 20);
      setRemoteMails(result.results.map(toMail));
      setMailTotal(result.count);
      setMailPage(1);
      setActionStatus(`已更新 ${result.results.length} 封邮件`);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "刷新失败"); }
    finally { setLoading(false); }
  };

  const searchCurrentMailbox = async () => {
    if (activeProvider !== "163") { setActionStatus("临时邮箱搜索已在当前已加载邮件中完成"); return; }
    if (!neteaseEmail.trim() || !neteaseCode.trim()) { setActionStatus("请先连接 163 邮箱"); return; }
    setLoading(true);
    try {
      const result = await invoke<Array<{ id: number; subject: string; sender: string; date: string; unread: boolean }>>("netease_search_emails", { email: neteaseEmail.trim(), code: neteaseCode.trim(), query });
      setNeteaseMails(result.map(toNeteaseMail));
      setActionStatus(result.length ? `网易邮箱找到 ${result.length} 封邮件` : "网易邮箱没有找到匹配邮件");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "网易邮箱搜索失败"); }
    finally { setLoading(false); }
  };

  const openCreateAddress = async () => {
    setShowCreate(true);
    try {
      const open = await new CloudflareClient(apiBase).getOpenSettings();
      const domains = open.domains ?? [];
      setAvailableDomains(domains);
      if (domains.length) setTempDomain((current) => current || domains[0]);
    } catch { setAvailableDomains([]); }
  };

  const createTempMail = async () => {
    if (!tempName.trim()) { setActionStatus("请填写邮箱用户名"); return; }
    setActionStatus("创建临时邮箱中…"); setLoading(true);
    try {
      const apiClient = client ?? new CloudflareClient(apiBase);
      const saved = await apiClient.createAddress(tempName.trim(), tempDomain, "");
      apiClient.setToken(saved.jwt);
      setClient(apiClient);
      await invoke("save_secret", { account: "cloudflare-credential", secret: saved.jwt });
      const result = await apiClient.listParsedMails(1, 20);
      setRemoteMails(result.results.map(toMail));
      setMailTotal(result.count); setMailPage(1);
      setActiveProvider("cloudflare");
      setCloudAddress(`${tempName.trim()}@${tempDomain || "mail.kodao.site"}`);
      setApiStatus(saved.password ? `已创建 · 默认密码 ${saved.password}` : "已创建临时邮箱地址");
      setShowCreate(false); setTempName("");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "创建失败");
    } finally { setLoading(false); }
  };

  const loadMore = async () => {
    if (!client || loadingMore || sourceMails.length >= mailTotal) return;
    setLoadingMore(true);
    try {
      const nextPage = mailPage + 1;
      const result = await client.listParsedMails(nextPage, 20);
      setRemoteMails((current) => [...(current ?? []), ...result.results.map(toMail)]);
      setMailPage(nextPage);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "加载更多失败"); }
    finally { setLoadingMore(false); }
  };

  const openMail = async (mail: Mail) => {
    setSelected(mail.id);
    setMobileDetailOpen(true);
    const updateList = (detailedMail: Mail) => {
      if (mail.provider === "163") {
        setNeteaseMails((current) => current?.map((item) => item.id === mail.id ? detailedMail : item) ?? current);
      } else {
        setRemoteMails((current) => current?.map((item) => item.id === mail.id ? detailedMail : item) ?? current);
      }
    };
    const cached = detailCache.current.get(mail.id);
    if (cached) { updateList(cached); return; }
    if (mail.provider === "163") {
      if (mail.body) return;
      try {
        const detail = await invoke<{ id: number; subject: string; sender: string; date: string; unread: boolean; body: string }>(
          "netease_fetch_email", { email: neteaseEmail.trim(), code: neteaseCode.trim(), uid: mail.id });
        const detailedMail = toNeteaseMail(detail);
        detailCache.current.set(mail.id, detailedMail);
        if (detailCache.current.size > 30) detailCache.current.delete(detailCache.current.keys().next().value as number);
        updateList(detailedMail);
        if (mail.unread) {
          await invoke("netease_mark_read", { email: neteaseEmail.trim(), code: neteaseCode.trim(), uid: mail.id, unread: false });
          setNeteaseMails((current) => current?.map((item) => item.id === mail.id ? { ...item, unread: false } : item) ?? current);
        }
      } catch (error) { setActionStatus(error instanceof Error ? error.message : "邮件加载失败"); }
      return;
    }
    if (!client || mail.body) return;
    try {
      const detail = await client.getParsedMail(mail.id);
      const detailedMail = toMail(detail);
      detailCache.current.set(mail.id, detailedMail);
      if (detailCache.current.size > 30) detailCache.current.delete(detailCache.current.keys().next().value as number);
      setRemoteMails((current) => current?.map((item) => item.id === mail.id ? detailedMail : item) ?? current);
      if (mail.unread) {
        await client.markRead(mail.id, false);
        setRemoteMails((current) => current?.map((item) => item.id === mail.id ? { ...item, unread: false } : item) ?? current);
      }
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "邮件加载失败"); }
  };

  const deleteActiveMail = async () => {
    if (!activeMail) return;
    try {
      if (activeMail.provider === "163") {
        await invoke("netease_delete_email", { email: neteaseEmail.trim(), code: neteaseCode.trim(), uid: activeMail.id });
        setNeteaseMails((current) => current?.filter((item) => item.id !== activeMail.id) ?? current);
      } else {
        if (!client) { setActionStatus("演示模式：仅记录删除"); return; }
        await client.deleteMail(activeMail.id);
        setRemoteMails((current) => current?.filter((item) => item.id !== activeMail.id) ?? current);
      }
      setActionStatus("邮件已删除");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "删除失败"); }
  };

  const toggleStar = () => {
    setStarredIds((current) => {
      const next = new Set(current);
      if (next.has(activeMail.id)) next.delete(activeMail.id); else next.add(activeMail.id);
      return next;
    });
    setActionStatus(starredIds.has(activeMail.id) ? "已取消星标" : "已加星标");
  };

  const markActiveUnread = async () => {
    if (activeMail.provider === "163") {
      try {
        await invoke("netease_mark_read", { email: neteaseEmail.trim(), code: neteaseCode.trim(), uid: activeMail.id, unread: true });
        setNeteaseMails((current) => current?.map((mail) => mail.id === activeMail.id ? { ...mail, unread: true } : mail) ?? current);
        setActionStatus("已标记为未读");
      } catch (error) { setActionStatus(error instanceof Error ? error.message : "标记未读失败"); }
      return;
    }
    if (!client) { setActionStatus("演示模式：已记录为未读"); return; }
    try {
      await client.markRead(activeMail.id, true);
      setRemoteMails((current) => current?.map((mail) => mail.id === activeMail.id ? { ...mail, unread: true } : mail) ?? current);
      setActionStatus("已标记为未读");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "标记未读失败"); }
  };

  const moveSelection = (direction: -1 | 1) => {
    const index = visibleMails.findIndex((mail) => mail.id === activeMail.id);
    const next = visibleMails[index + direction];
    if (next) openMail(next);
    else setActionStatus(direction < 0 ? "已经是第一封邮件" : "已经是最后一封邮件");
  };

  const sendCompose = async () => {
    if (!composeTo.trim() || !composeSubject.trim()) { setActionStatus("请填写收件人、主题"); return; }
    try {
      if (activeProvider === "163") {
        if (!neteaseEmail.trim()) { setActionStatus("请先在设置中连接 163 邮箱"); return; }
        await invoke("netease_send_mail", { email: neteaseEmail.trim(), code: neteaseCode.trim(), to: composeTo.trim(), subject: composeSubject.trim(), content: composeBody });
      } else {
        if (!client) { setActionStatus("请先连接临时邮箱"); return; }
        await client.sendMail({ to_mail: composeTo.trim(), subject: composeSubject.trim(), content: composeBody, is_html: false });
      }
      setShowCompose(false); setComposeTo(""); setComposeSubject(""); setComposeBody(""); setActionStatus("邮件已发送");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "发送失败"); }
  };

  const copyOtp = async () => {
    if (!activeMail.otp) return;
    await navigator.clipboard?.writeText(activeMail.otp.replace(/ /g, ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const analyzeActiveMail = async () => {
    if (!activeMail) return;
    setAiLoading(true);
    setAiAnalysis("");
    try {
      const result = await new LocalAiClient({ baseUrl: aiBaseUrl, model: aiModel, apiKey: aiApiKey }).chat([
        { role: "system", content: MAIL_ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: buildMailAnalysisPrompt({ sender: activeMail.sender, address: activeMail.address, subject: activeMail.subject, time: activeMail.time, body: activeMail.body || activeMail.preview, otp: activeMail.otp }) },
      ], { temperature: 0.1, maxTokens: 600 });
      setAiAnalysis(result);
      setActionStatus("本地 AI 分析完成");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "本地 AI 分析失败");
    } finally { setAiLoading(false); }
  };

  const saveAiSettings = async () => {
    localStorage.setItem("cloudmail-ai-base", aiBaseUrl.trim().replace(/\/+$/, ""));
    localStorage.setItem("cloudmail-ai-model", aiModel.trim());
    try {
      if (aiApiKey.trim()) await invoke("save_secret", { account: "ai-api-key", secret: aiApiKey.trim() });
      setActionStatus(aiApiKey.trim() ? "云端 AI 设置已安全保存" : "本地 AI 设置已保存");
    } catch (error) { setActionStatus(error instanceof Error ? `AI Key 保存失败：${error.message}` : "AI Key 保存失败"); }
  };

  const testAiConnection = async () => {
    setAiLoading(true);
    try {
      const result = await new LocalAiClient({ baseUrl: aiBaseUrl, model: aiModel, apiKey: aiApiKey }).chat([{ role: "user", content: "只回复：AI 连接成功" }], { maxTokens: 32 });
      setActionStatus(result || "AI 连接成功");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "本地 AI 连接失败"); }
    finally { setAiLoading(false); }
  };

  const applyAiPreset = (preset: "local" | "zhipu" | "openai") => {
    if (preset === "local") { setAiBaseUrl("http://localhost:8000/v1"); setAiModel("Qwen3.5-9B-AWQ"); }
    if (preset === "zhipu") { setAiBaseUrl("https://open.bigmodel.cn/api/paas/v4"); setAiModel("glm-5.3"); }
    if (preset === "openai") { setAiBaseUrl("https://api.openai.com/v1"); setAiModel("gpt-4o-mini"); }
    setActionStatus(`${preset === "local" ? "本地 Qwen" : preset === "zhipu" ? "智谱 GLM" : "OpenAI"} 预设已填入，请保存设置`);
  };

  const syncCloudState = async () => {
    if (!syncBaseUrl.trim() || !syncToken.trim()) { setActionStatus("请先填写 Cloudflare 同步地址和令牌"); return; }
    setSyncLoading(true);
    try {
      const accountRef = activeProvider === "163" ? neteaseEmail.trim() : cloudAddress;
      const items = sourceMails.map((mail) => ({ account_ref: accountRef, provider: mail.provider || activeProvider, mail_id: String(mail.id), is_read: !mail.unread, starred: starredIds.has(mail.id), ai_result: mail.id === activeMail.id ? aiAnalysis : undefined, updated_at: Date.now() }));
      const result = await new CloudSyncClient(syncBaseUrl, syncToken).push(items);
      sessionStorage.setItem("cloudmail-sync-base", syncBaseUrl.trim().replace(/\/+$/, ""));
      sessionStorage.setItem("cloudmail-sync-token", syncToken.trim());
      setActionStatus(`云同步完成 · ${result.accepted} 条状态`);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "云同步失败"); }
    finally { setSyncLoading(false); }
  };

  const syncCloudPull = async (accountRef: string) => {
    if (!syncBaseUrl.trim() || !syncToken.trim()) return;
    try {
      const items = (await new CloudSyncClient(syncBaseUrl, syncToken).pull(accountRef)).items;
      if (!items.length) return;
      setStarredIds((current) => {
        const next = new Set(current);
        items.forEach((it) => { const id = Number(it.mail_id); if (Number.isFinite(id)) { if (it.starred) next.add(id); else next.delete(id); } });
        return next;
      });
      if (activeProvider === "cloudflare") {
        setRemoteMails((current) => (current ?? []).map((m) => {
          const sync = items.find((it) => String(it.mail_id) === String(m.id) && it.is_read !== undefined);
          return sync ? { ...m, unread: sync.is_read ? false : m.unread } : m;
        }));
      }
      setActionStatus(`已从云端拉取 ${items.length} 条状态（已读 / 星标 / AI）`);
    } catch { /* 拉取失败保持本地状态，不打扰用户 */ }
  };

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand"><div className="brand-mark">C</div><span>CloudMail</span><small>Windows</small></div>
        <div className="titlebar-actions"><button className="icon-button" aria-label="搜索" onClick={() => searchInputRef.current?.focus()}>⌕</button><button className="icon-button" aria-label="设置" onClick={() => setShowSettings(true)}>⚙</button><div className="avatar">K</div></div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <button className="compose-button" onClick={() => setShowCompose(true)}><span>＋</span> 写邮件</button>
          <div className="account-card" onClick={() => setShowSettings(true)} role="button" title="管理邮箱账户"><div className="account-icon">{activeProvider === "163" ? "E" : "C"}</div><div><strong>{activeProvider === "163" ? (neteaseEmail || "163 邮箱") : cloudAddress}</strong><small>{activeProvider === "163" ? "163 邮箱" : "Cloudflare 临时邮箱"}</small></div><span className="chevron">⌄</span></div>
          <nav className="nav-list">{navItems.map(([label, icon, count]) => <button key={label} className={`nav-item ${folder === label ? "active" : ""}`} onClick={() => selectFolder(label)}><span className="nav-icon">{icon}</span><span>{label}</span>{count && <b>{label === "验证码" ? sourceMails.filter((mail) => mail.otp).length : count}</b>}</button>)}</nav>
          <div className="sidebar-section"><div className="section-label">邮箱账户 <button onClick={() => setShowSettings(true)}>＋</button></div><button className="account-row" onClick={() => { setActiveProvider("cloudflare"); setFolder("收件箱"); setFilter("all"); }}><span className="status-dot orange" /> 临时邮箱 <em>{remoteMails ? remoteMails.length : 0}</em></button><button className="account-row" onClick={() => { if (neteaseMails) { setActiveProvider("163"); setFolder("收件箱"); setFilter("all"); } else setShowSettings(true); }}><span className={`status-dot ${neteaseMails ? "orange" : "red"}`} /> 163 邮箱 <em>{neteaseMails ? neteaseMails.length : 0}</em></button></div>
          <div className="sidebar-footer"><span className={`sync-dot ${loading ? "syncing" : ""}`} /> {actionStatus || (client ? "已连接 · 可同步" : "未连接邮箱")}</div>
        </aside>
        <main className="mail-list-panel">
          <div className="panel-heading"><div><p className="eyebrow">{folder}</p><h1>{folder === "验证码" ? "验证码" : "收件箱"} <span>{sourceMails.length}{mailTotal > sourceMails.length && ` / ${mailTotal}`}</span></h1></div><button className="refresh-button" onClick={refreshInbox} disabled={loading} title="刷新收件箱">{loading ? "…" : "↻"}</button></div>
          <div className="search-box"><span>⌕</span><input ref={searchInputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void searchCurrentMailbox(); }} placeholder="搜索邮件、发件人或验证码" /><kbd>Ctrl K</kbd></div>
          <div className="filter-row"><button className={`filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>全部</button><button className={`filter ${filter === "unread" ? "active" : ""}`} onClick={() => setFilter("unread")}>未读</button><button className={`filter ${filter === "attachments" ? "active" : ""}`} onClick={() => setFilter("attachments")}>带附件</button><button className={`filter otp-filter ${filter === "otp" ? "active" : ""}`} onClick={() => setFilter("otp")}>验证码 <span>{sourceMails.filter((mail) => mail.otp).length}</span></button></div>
          <div className="mail-list">{visibleMails.length ? visibleMails.map((mail) => <button key={mail.id} onClick={() => openMail(mail)} className={`mail-row ${selected === mail.id ? "selected" : ""}`}><div className="sender-avatar" style={{ background: mail.color }}>{mail.sender.slice(0, 1)}</div><div className="mail-copy"><div className="mail-meta"><strong>{mail.sender}</strong><time>{mail.time}</time></div><div className="subject">{mail.subject} {mail.tag && <span className="tag">{mail.tag}</span>}</div><p>{mail.preview}</p></div>{starredIds.has(mail.id) && <span className="row-star">★</span>}{mail.unread && <i className="unread-dot" />}</button>) : <div className="empty-state"><div className="empty-icon">⌕</div><strong>没有找到邮件</strong><span>试试更换筛选条件或搜索关键词</span><button onClick={() => { setQuery(""); setFilter("all"); setFolder("收件箱"); }}>清除筛选</button></div>}{activeProvider === "cloudflare" && client && sourceMails.length < mailTotal && <button className="load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "加载中…" : `加载更多（剩余 ${mailTotal - sourceMails.length} 封）`}</button>}</div>
        </main>
        <section className={`reading-panel ${mobileDetailOpen ? "mobile-open" : ""}`}>
          <div className="reading-toolbar"><div className="toolbar-left"><button className="mobile-close" onClick={() => setMobileDetailOpen(false)} title="返回列表">×</button><button onClick={() => moveSelection(-1)} title="上一封">←</button><button onClick={() => moveSelection(1)} title="下一封">↗</button><button onClick={deleteActiveMail} title="删除">⌫</button><button onClick={markActiveUnread} title="标记未读">✉</button></div><div className="toolbar-right"><button onClick={toggleStar} title="星标">{starredIds.has(activeMail.id) ? "★" : "☆"}</button><button onClick={() => setActionStatus("更多操作：可使用删除、星标或标记未读")} title="更多操作">⋯</button></div></div>
          <article className="message"><div className="message-heading"><div className="sender-avatar large" style={{ background: activeMail.color }}>{activeMail.sender.slice(0, 1)}</div><div><h2>{activeMail.subject}</h2><div className="from-line"><strong>{activeMail.sender}</strong><span>&lt;{activeMail.address}&gt;</span><time>{activeMail.time}</time></div></div></div>
            {activeMail.otp && <div className="otp-card"><div className="otp-icon">◇</div><div className="otp-content"><small>检测到验证码</small><strong>{activeMail.otp}</strong><span>仅在此设备本地解析，不会上传邮件内容</span></div><button onClick={copyOtp}>{copied ? "已复制" : "复制"}</button></div>}
            <div className="message-body">{activeMail.body ? <><p>{activeMail.body}</p>{activeMail.attachments && activeMail.attachments.length > 0 && <p className="muted">附件：{activeMail.attachments.length} 个</p>}</> : <><p>{activeProvider === "163" ? (neteaseMails ? "点击邮件加载 163 信箱真实正文。" : "163 邮箱尚未连接，请在设置中填写邮箱和授权码。") : (client ? "点击邮件加载真实正文。" : "临时邮箱尚未连接，请在设置中连接邮箱或创建临时邮箱地址。")}</p><p className="muted">邮件正文按需加载，减少启动时间和网络流量。</p></>}</div>
            <div className="ai-actions"><button className="ai-button" onClick={analyzeActiveMail} disabled={aiLoading}>{aiLoading ? "AI 分析中…" : "✦ AI 分析邮件"}</button><span>可使用本地 Qwen、智谱 GLM 或其他 OpenAI 兼容服务</span></div>{aiSections.length > 0 && <div className="ai-result"><strong>AI 分析</strong><div className="ai-sections">{aiSections.map((section) => <div className="ai-section" key={section.title}><b>{section.title}</b><p>{section.content}</p></div>)}</div></div>}
          </article>
        </section>
      </div>
      {actionStatus && <div className="status-toast" role="status">{actionStatus}<button onClick={() => setActionStatus("")}>×</button></div>}
      {showSettings && <div className="modal-backdrop" onClick={() => setShowSettings(false)}><div className="modal" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">设置</p><h2>账户与同步</h2></div><button onClick={() => setShowSettings(false)}>×</button></div><label>邮箱账户</label><div className="settings-account"><span className={`status-dot ${client ? "orange" : "red"}`} /><div><strong>{cloudAddress}</strong><small>{apiStatus}</small></div><span className="connected">{client ? "已连接" : "未连接"}</span></div><div className="ai-settings"><div className="settings-section-title">AI 邮件分析</div><div className="ai-presets"><button className="outline-button" onClick={() => applyAiPreset("local")}>本地 Qwen</button><button className="outline-button" onClick={() => applyAiPreset("zhipu")}>智谱 GLM</button><button className="outline-button" onClick={() => applyAiPreset("openai")}>OpenAI</button></div><label>OpenAI 兼容接口地址</label><input className="settings-input" value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} placeholder="http://localhost:8000/v1" /><label>模型名称</label><input className="settings-input" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="Qwen3.5-9B-AWQ / glm-4-flash" /><label>API Key（云端需要，本地可留空）</label><input className="settings-input" type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="sk-… 或智谱 API Key" /><div className="ai-setting-actions"><button className="outline-button ai-save" onClick={saveAiSettings}>保存设置</button><button className="outline-button ai-save" onClick={testAiConnection} disabled={aiLoading}>{aiLoading ? "测试中…" : "测试连接"}</button></div><small className="settings-note ai-note">兼容 OpenAI Chat Completions 格式。云端 Key 通过 Windows Credential Manager 保存，不写入源码；本地 Qwen 服务可留空。</small></div><div className="ai-settings sync-settings"><div className="settings-section-title">Cloudflare 云同步（可选）</div><label>同步 Worker 地址</label><input className="settings-input" value={syncBaseUrl} onChange={(e) => setSyncBaseUrl(e.target.value)} placeholder="https://cloudmail-sync.example.workers.dev" /><label>同步令牌</label><input className="settings-input" type="password" value={syncToken} onChange={(e) => setSyncToken(e.target.value)} placeholder="只保存在本次浏览器会话" /><button className="outline-button ai-save" onClick={syncCloudState} disabled={syncLoading}>{syncLoading ? "同步中…" : "同步已读、星标和 AI 结果"}</button><small className="settings-note ai-note">默认不上传邮件正文、附件、JWT 或 163 授权码；仅同步邮件 ID、状态和当前邮件的结构化 AI 结果。</small></div><label>Cloudflare API 地址</label><input className="settings-input" value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://email.kodao.site" /><label>邮箱凭据 / JWT</label><input className="settings-input" type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="凭据仅保存在 Windows Credential Manager" /><button className="compose-button connect-button" onClick={() => connectCloudflare()} disabled={loading}>{loading ? "连接中…" : "连接并同步收件箱"}</button><button className="outline-button ai-save" onClick={openCreateAddress} style={{ width: "100%" }}>＋ 创建临时邮箱地址</button><div className="ai-settings"><div className="settings-section-title">163 邮箱（IMAP/SMTP）</div><label>邮箱地址</label><input className="settings-input" value={neteaseEmail} onChange={(e) => setNeteaseEmail(e.target.value)} placeholder="you@163.com" /><label>客户端授权码</label><input className="settings-input" type="password" value={neteaseCode} onChange={(e) => setNeteaseCode(e.target.value)} placeholder="在 163 网页版「设置→客户端授权密码」获取" /><button className="compose-button connect-button" onClick={() => connectNetease()} disabled={loading}>{loading ? "连接中…" : "连接并同步 163"}</button><small className="settings-note ai-note">请先在 163 设置里开启 IMAP/SMTP 并生成授权码，使用授权码而不是网页登录密码。授权码仅保存在 Windows Credential Manager。</small></div><div className="settings-note">凭据通过 Tauri 存入 Windows Credential Manager，不会写入日志或同步到云端。</div></div></div>}
      {showCreate && <div className="modal-backdrop" onClick={() => setShowCreate(false)}><div className="modal" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">临时邮箱</p><h2>创建临时邮箱地址</h2></div><button onClick={() => setShowCreate(false)}>×</button></div><label>用户名</label><input className="settings-input" value={tempName} onChange={(e) => setTempName(e.target.value.replace(/[^a-z0-9_.-]/gi, ""))} placeholder="自定义用户名（字母/数字）" /><label>域名</label>{availableDomains.length ? <select className="settings-input" value={tempDomain} onChange={(e) => setTempDomain(e.target.value)}>{availableDomains.map((d) => <option key={d} value={d}>{d}</option>)}</select> : <input className="settings-input" value={tempDomain} onChange={(e) => setTempDomain(e.target.value)} placeholder="mail.kodao.site" />}<div className="settings-note" style={{ minHeight: 24 }}>{tempName.trim() && tempDomain && <span>将创建：<strong>{tempName.trim()}@{tempDomain.replace(/^@/, "")}</strong></span>}</div><button className="compose-button connect-button" onClick={createTempMail} disabled={loading || !tempName.trim()}>{loading ? "创建中…" : "创建临时邮箱"}</button><small className="settings-note ai-note">创建后自动切换新地址并同步收件箱，JWT 会保存到 Windows Credential Manager。临时邮箱可用于接收验证码等一次性邮件。</small></div></div>}
      {showCompose && <div className="modal-backdrop" onClick={() => setShowCompose(false)}><div className="modal compose" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">新邮件</p><h2>写邮件</h2></div><button onClick={() => setShowCompose(false)}>×</button></div><input value={composeTo} onChange={(e) => setComposeTo(e.target.value)} placeholder="收件人" /><input value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} placeholder="主题" /><textarea value={composeBody} onChange={(e) => setComposeBody(e.target.value)} placeholder="输入邮件内容…" rows={7} /><div className="compose-footer"><span>当前账户：{activeProvider === "163" ? (neteaseEmail.trim() || "163 邮箱") : cloudAddress}</span><button className="compose-button small" onClick={sendCompose}>发送</button></div></div></div>}
    </div>
  );
}

export default App;
