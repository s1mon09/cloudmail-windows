import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CloudflareClient, normalizeCloudflareMail, type ParsedMail } from "./api/cloudflare";
import { findOtpCandidates } from "./api/otp";
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

/** 多邮箱账户模型：一个账户对应一次连接到的邮箱（163 或 Cloudflare 临时邮箱）。 */
type Account = {
  id: string; // 唯一键，163 用 "163:<email>"，临时邮箱用 "tmp:<address>"
  kind: "163" | "cloudflare";
  label: string; // 展示名（163 为邮箱地址，临时邮箱为地址）
  email: string; // 163 用邮箱地址；临时邮箱保存地址便于恢复
  code: string; // 163 客户端授权码，仅运行时内存持有
  client: CloudflareClient | null; // 仅临时邮箱账户持有
  mails: Mail[];
  connected: boolean;
  mailTotal?: number; // 临时邮箱服务端邮件总数（用于分页）
};

type NeteaseMeta = { id: number; subject: string; sender: string; date: string; unread: boolean; body?: string; html?: boolean };

const EMPTY_MAIL: Mail = {
  id: 0, sender: "", address: "",
  subject: "没有更多邮件", preview: "",
  time: "", color: "#64748b",
};

const navItems = [
  ["收件箱", "⌁", "12"], ["验证码", "◇", "3"], ["已加星标", "☆", ""], ["草稿", "✎", "1"], ["已发送", "↗", ""], ["垃圾邮件", "⊘", ""],
];

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
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
  const [loading, setLoading] = useState(false);
  const [actionStatus, setActionStatus] = useState("");
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeFromId, setComposeFromId] = useState("");
  const [mailTotal, setMailTotal] = useState(0);
  const [mailPage, setMailPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [syncBaseUrl, setSyncBaseUrl] = useState(() => sessionStorage.getItem("cloudmail-sync-base") || "");
  const [syncToken, setSyncToken] = useState(() => sessionStorage.getItem("cloudmail-sync-token") || "");
  const [syncLoading, setSyncLoading] = useState(false);
  const [tempLoginEmail, setTempLoginEmail] = useState("");
  const [tempLoginPwd, setTempLoginPwd] = useState("");
  const [add163Email, setAdd163Email] = useState("");
  const [add163Code, setAdd163Code] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailCache = useRef(new Map<number, Mail>());
  const [showCreate, setShowCreate] = useState(false);
  const [tempName, setTempName] = useState("");
  const [tempDomain, setTempDomain] = useState("");
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);

  // 当前活动账户与数据源
  const activeAccount = accounts.find((a) => a.id === activeAccountId) ?? null;
  const sourceMails = activeAccount?.mails ?? [];
  const activeMail = useMemo(() => sourceMails.find((mail) => mail.id === selected) ?? sourceMails[0] ?? EMPTY_MAIL, [sourceMails, selected]);
  // 可发送账户：仅列出已连接的 163 账户（临时邮箱不支持发送）。
  const sendableAccounts = useMemo(() => accounts.filter((a) => a.kind === "163" && a.connected && a.email.trim()), [accounts]);

  const visibleMails = useMemo(() => sourceMails.filter((mail) => {
    const text = `${mail.sender} ${mail.address} ${mail.subject} ${mail.preview}`.toLowerCase();
    const matchesFolder = folder !== "已加星标" || starredIds.has(mail.id);
    const matchesFilter = filter === "all"
      || (filter === "unread" && mail.unread)
      || (filter === "attachments" && Boolean(mail.attachments?.length))
      || (filter === "otp" && Boolean(mail.otp));
    return matchesFolder && matchesFilter && text.includes(deferredQuery.toLowerCase());
  }), [deferredQuery, filter, folder, sourceMails, starredIds]);

  const selectFolder = (label: string) => {
    setFolder(label);
    if (label === "验证码") setFilter("otp");
    else if (label === "收件箱") setFilter("all");
    else if (label === "已加星标") setActionStatus("星标邮件筛选已启用");
    else setActionStatus(`${label}功能正在接入，当前按钮已响应`);
  };

  // 账户列表变化后，把账户 id 列表持久化到 localStorage（不含任何凭据），供下次启动按 key 恢复。
  useEffect(() => {
    localStorage.setItem("cloudmail-accounts", JSON.stringify(accounts.map((a) => ({ id: a.id, kind: a.kind }))));
  }, [accounts]);

  // 新增或整体替换账户；switchTo 为 true 时切换为活动账户。
  const addOrReplaceAccount = (acc: Account, switchTo = false) => {
    setAccounts((current) => current.some((a) => a.id === acc.id) ? current.map((a) => (a.id === acc.id ? { ...a, ...acc } : a)) : [...current, acc]);
    if (switchTo) setActiveAccountId(acc.id);
  };

  // 以函数式更新某个账户的邮件列表，避免闭包过期导致丢失并发更新。
  const updateAccountMails = (id: string, updater: (mails: Mail[]) => Mail[]) => {
    setAccounts((current) => current.map((a) => (a.id === id ? { ...a, mails: updater(a.mails) } : a)));
  };

  const switchAccount = (id: string) => {
    if (id === activeAccountId) return;
    setActiveAccountId(id);
    setFolder("收件箱");
    setFilter("all");
    setSelected(0);
    setMailPage(1);
    const acc = accounts.find((a) => a.id === id);
    setMailTotal(acc?.kind === "cloudflare" ? (acc.mailTotal ?? acc.mails.length) : 0);
    if (acc) setActionStatus(`已切换到 ${acc.label}`);
  };

  const disconnectAccount = (id: string) => {
    setAccounts((current) => current.map((a) => (a.id === id ? { ...a, connected: false, client: null, mails: [] } : a)));
    setMailTotal(0);
    setActionStatus("账户已断开，可在设置中重新连接");
  };

  const reconnectAccount = async (id: string) => {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return;
    if (acc.kind === "163") {
      if (!acc.code) { setActionStatus("该账户没有可用授权码，请删除后重新添加"); return; }
      await connectNetease(acc.email, acc.code, acc.id);
    } else {
      const secret = await invoke<string | null>("get_secret", { account: `account:${acc.id}` }).catch(() => null);
      if (secret) await connectCloudflare(secret, acc.id);
      else setActionStatus("找不到该账户的登录凭据，请删除后重新添加");
    }
  };

  const removeAccount = async (id: string) => {
    await invoke("delete_secret", { account: `account:${id}` }).catch(() => undefined);
    const next = accounts.filter((a) => a.id !== id);
    setAccounts(next);
    if (activeAccountId === id) setActiveAccountId(next[0]?.id ?? null);
    setActionStatus("已删除该账户");
  };

  // 启动时恢复账户：先读 localStorage 中的账户 id 列表，再从 Windows 凭据读取对应密钥自动连接；
  // 同时兼容旧的 netease-credential / cloudflare-credential 单键，自动迁移为一个账户。
  useEffect(() => {
    let cancelled = false;
    const loadAccounts = async () => {
      let saved: { id: string; kind: string }[] = [];
      try { saved = JSON.parse(localStorage.getItem("cloudmail-accounts") || "[]"); } catch { saved = []; }
      const ne = await invoke<string | null>("get_secret", { account: "netease-credential" }).catch(() => null);
      const oldCf = await invoke<string | null>("get_secret", { account: "cloudflare-credential" }).catch(() => null);
      // 旧 163 键迁移：格式 "邮箱\n授权码"，保存到新键 account:163:<email>，成功后清理旧键。
      if (ne) {
        const nl = ne.indexOf("\n");
        const email = nl > 0 ? ne.slice(0, nl) : ne;
        const code = nl > 0 ? ne.slice(nl + 1) : "";
        if (email && code && !saved.some((a) => a.id === `163:${email}`)) {
          const id = `163:${email}`;
          const ok = await connectNetease(email, code, id);
          if (ok) {
            await invoke("save_secret", { account: `account:${id}`, secret: `${email}\n${code}` }).catch(() => undefined);
            await invoke("delete_secret", { account: "netease-credential" }).catch(() => undefined);
          }
        } else {
          await invoke("delete_secret", { account: "netease-credential" }).catch(() => undefined);
        }
      }
      // 依次恢复已保存的账户。
      for (const a of saved) {
        if (cancelled) return;
        if (a.kind === "163") {
          const secret = await invoke<string | null>("get_secret", { account: `account:${a.id}` }).catch(() => null);
          if (secret) {
            const nl = secret.indexOf("\n");
            const email = nl > 0 ? secret.slice(0, nl) : secret;
            const code = nl > 0 ? secret.slice(nl + 1) : "";
            if (email && code) await connectNetease(email, code, a.id);
          }
        } else {
          const secret = await invoke<string | null>("get_secret", { account: `account:${a.id}` }).catch(() => null);
          if (secret) await connectCloudflare(secret, a.id);
        }
      }
      // 旧 cloudflare 键迁移：凭据本身即 JWT，连接成功后即可推导账户 id。
      if (oldCf && !cancelled) {
        const ok = await connectCloudflare(oldCf);
        if (ok) await invoke("delete_secret", { account: "cloudflare-credential" }).catch(() => undefined);
      }
    };
    void loadAccounts();
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

  const connectCloudflare = async (provided?: string, suggestedId?: string): Promise<boolean> => {
    const target = (provided ?? credential).trim();
    if (!target) { setActionStatus("请输入临时邮箱凭据"); return false; }
    setActionStatus("连接中…"); setLoading(true);
    try {
      const apiClient = new CloudflareClient(apiBase);
      const settings = await apiClient.credentialLogin(target);
      const address = settings.address || "临时邮箱";
      // 有已保存的账户 id 时沿用（重连场景），否则按地址推导。
      const id = suggestedId || `tmp:${address}`;
      await invoke("save_secret", { account: `account:${id}`, secret: target }).catch(() => undefined);
      const result = await apiClient.listParsedMails(1, 20);
      addOrReplaceAccount({ id, kind: "cloudflare", label: address, email: address, code: "", client: apiClient, mails: result.results.map(toMail), connected: true, mailTotal: result.count }, true);
      setMailTotal(result.count);
      setMailPage(1);
      setActionStatus(`已连接 · ${address}`);
      setShowSettings(false);
      void syncCloudPull(address);
      return true;
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "连接失败");
      return false;
    } finally { setLoading(false); }
  };

  const toMail = (mail: ParsedMail): Mail => {
    const normalized = normalizeCloudflareMail(mail);
    const body = String(mail.text || mail.html || mail.message || "");
    const otp = findOtpCandidates(`${mail.subject || ""}\n${body}`)[0]?.value;
    return { ...normalized, body, html: mail.html, otp, tag: otp ? "验证码" : "实时", color: "#f38020", provider: "cloudflare" } as Mail;
  };

  const toNeteaseMail = (m: NeteaseMeta): Mail => {
    const addr = /<([^>]+)>/.exec(m.sender)?.[1] ?? (m.sender.includes("@") ? m.sender : "");
    const display = (m.sender || "未知发件人").replace(/<[^>]+>$/, "").trim() || "未知发件人";
    const body = m.body ?? "";
    const otp = findOtpCandidates(`${m.subject || ""}\n${body}`)[0]?.value;
    return {
      id: m.id, sender: display, address: addr, subject: m.subject || "无主题",
      preview: body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 100),
      time: m.date ? m.date.replace("T", " ").slice(5, 16) : "",
      unread: m.unread, body, html: m.html ? body : undefined, provider: "163", color: "#d62828",
      tag: otp ? "验证码" : "163", otp,
    };
  };

  /** 163 邮件正文安全渲染：只保留安全标签并移除脚本/事件，防止来自邮件的注入。 */
  const renderMailHtml = (raw: string): string => {
    const doc = new DOMParser().parseFromString(raw, "text/html");
    doc.querySelectorAll("script, style, iframe, object, embed, link, meta, form, svg, video, audio").forEach((el) => el.remove());
    doc.querySelectorAll("[onclick],[onerror],[onload],[href^='javascript:']").forEach((el) => {
      Array.from(el.attributes).forEach((a) => { if (/^on/i.test(a.name) || a.name === "href") el.removeAttribute(a.name); });
    });
    // 图片若无真实 src 则移除，避免加载本地资源或追踪像素。
    doc.querySelectorAll("img").forEach((el) => { if (!el.getAttribute("src")) el.remove(); });
    return doc.body.innerHTML;
  };

  const connectNetease = async (providedEmail?: string, providedCode?: string, providedId?: string): Promise<boolean> => {
    const email = (providedEmail ?? add163Email).trim();
    const code = (providedCode ?? add163Code).trim();
    if (!email || !code) { setActionStatus("请输入 163 邮箱和授权码"); return false; }
    setActionStatus("连接 163…"); setLoading(true);
    try {
      const metas = await invoke<NeteaseMeta[]>("netease_list_emails", { email, code });
      const id = providedId ?? `163:${email}`;
      await invoke("save_secret", { account: `account:${id}`, secret: `${email}\n${code}` }).catch(() => undefined);
      addOrReplaceAccount({ id, kind: "163", label: email, email, code, client: null, mails: metas.map(toNeteaseMail), connected: true }, true);
      setMailTotal(0); setMailPage(1);
      setFolder("收件箱"); setFilter("all");
      setShowSettings(false);
      setActionStatus(`已连接 163 · ${metas.length} 封邮件`);
      void syncCloudPull(email);
      return true;
    } catch (error) { setActionStatus(error instanceof Error ? error.message : String(error)); return false; }
    finally { setLoading(false); }
  };

  const refreshInbox = async () => {
    const acc = activeAccount;
    if (!acc) { setShowSettings(true); return; }
    if (acc.kind === "163") {
      if (!acc.email.trim() || !acc.code.trim()) { setShowSettings(true); return; }
      setLoading(true); setActionStatus("");
      try {
        const metas = await invoke<NeteaseMeta[]>("netease_list_emails", { email: acc.email.trim(), code: acc.code.trim() });
        addOrReplaceAccount({ ...acc, mails: metas.map(toNeteaseMail) });
        setMailTotal(0); setMailPage(1);
        setActionStatus(`已更新 163 邮箱 ${metas.length} 封邮件`);
      } catch (error) { setActionStatus(error instanceof Error ? error.message : "163 刷新失败"); }
      finally { setLoading(false); }
      return;
    }
    if (!acc.client) { setShowSettings(true); return; }
    setLoading(true); setActionStatus("");
    try {
      const result = await acc.client.listParsedMails(1, 20);
      addOrReplaceAccount({ ...acc, mails: result.results.map(toMail), mailTotal: result.count });
      setMailTotal(result.count);
      setMailPage(1);
      setActionStatus(`已更新 ${result.results.length} 封邮件`);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "刷新失败"); }
    finally { setLoading(false); }
  };

  const searchCurrentMailbox = async () => {
    const acc = activeAccount;
    if (!acc || acc.kind !== "163") { setActionStatus("仅 163 邮箱支持服务端搜索"); return; }
    if (!acc.email.trim() || !acc.code.trim()) { setActionStatus("请先连接 163 邮箱"); return; }
    setLoading(true);
    try {
      const result = await invoke<NeteaseMeta[]>("netease_search_emails", { email: acc.email.trim(), code: acc.code.trim(), query });
      addOrReplaceAccount({ ...acc, mails: result.map(toNeteaseMail) });
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
      const apiClient = new CloudflareClient(apiBase);
      const saved = await apiClient.createAddress(tempName.trim(), tempDomain, "");
      apiClient.setToken(saved.jwt);
      const address = `${tempName.trim()}@${tempDomain || "mail.kodao.site"}`;
      const id = `tmp:${address}`;
      await invoke("save_secret", { account: `account:${id}`, secret: saved.jwt }).catch(() => undefined);
      const result = await apiClient.listParsedMails(1, 20);
      addOrReplaceAccount({ id, kind: "cloudflare", label: address, email: address, code: "", client: apiClient, mails: result.results.map(toMail), connected: true, mailTotal: result.count }, true);
      setMailTotal(result.count); setMailPage(1);
      setActionStatus(saved.password ? `已创建 · 默认密码 ${saved.password}` : "已创建临时邮箱地址");
      setShowCreate(false); setTempName("");
    } catch (error) {
      setActionStatus(error instanceof Error ? error.message : "创建失败");
    } finally { setLoading(false); }
  };

  const loadMore = async () => {
    const acc = activeAccount;
    if (acc?.kind !== "cloudflare" || !acc.client || loadingMore || sourceMails.length >= mailTotal) return;
    setLoadingMore(true);
    try {
      const nextPage = mailPage + 1;
      const result = await acc.client.listParsedMails(nextPage, 20);
      updateAccountMails(acc.id, (mails) => [...mails, ...result.results.map(toMail)]);
      setMailPage(nextPage);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "加载更多失败"); }
    finally { setLoadingMore(false); }
  };

  const openMail = async (mail: Mail) => {
    setSelected(mail.id);
    setMobileDetailOpen(true);
    const acc = activeAccount;
    if (!acc) return;
    const updateList = (detailedMail: Mail) => updateAccountMails(acc.id, (mails) => mails.map((item) => item.id === mail.id ? detailedMail : item));
    const cached = detailCache.current.get(mail.id);
    if (cached) { updateList(cached); return; }
    if (acc.kind === "163") {
      if (mail.body) return;
      try {
        const detail = await invoke<NeteaseMeta>("netease_fetch_email", { email: acc.email.trim(), code: acc.code.trim(), uid: mail.id });
        const detailedMail = toNeteaseMail(detail);
        detailCache.current.set(mail.id, detailedMail);
        if (detailCache.current.size > 30) detailCache.current.delete(detailCache.current.keys().next().value as number);
        updateList(detailedMail);
        if (mail.unread) {
          await invoke("netease_mark_read", { email: acc.email.trim(), code: acc.code.trim(), uid: mail.id, unread: false });
          updateAccountMails(acc.id, (mails) => mails.map((item) => item.id === mail.id ? { ...item, unread: false } : item));
        }
      } catch (error) { setActionStatus(error instanceof Error ? error.message : "邮件加载失败"); }
      return;
    }
    if (!acc.client || mail.body) return;
    try {
      const detail = await acc.client.getParsedMail(mail.id);
      const detailedMail = toMail(detail);
      detailCache.current.set(mail.id, detailedMail);
      if (detailCache.current.size > 30) detailCache.current.delete(detailCache.current.keys().next().value as number);
      updateList(detailedMail);
      if (mail.unread) {
        await acc.client.markRead(mail.id, false);
        updateAccountMails(acc.id, (mails) => mails.map((item) => item.id === mail.id ? { ...item, unread: false } : item));
      }
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "邮件加载失败"); }
  };

  const deleteActiveMail = async () => {
    if (!activeMail || activeMail.id === 0) return;
    const acc = activeAccount;
    if (!acc) return;
    try {
      if (acc.kind === "163") {
        await invoke("netease_delete_email", { email: acc.email.trim(), code: acc.code.trim(), uid: activeMail.id });
        updateAccountMails(acc.id, (mails) => mails.filter((item) => item.id !== activeMail.id));
      } else {
        if (!acc.client) { setActionStatus("演示模式：仅记录删除"); return; }
        await acc.client.deleteMail(activeMail.id);
        updateAccountMails(acc.id, (mails) => mails.filter((item) => item.id !== activeMail.id));
      }
      setActionStatus("邮件已删除");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "删除失败"); }
  };

  const toggleStar = () => {
    if (!activeMail || activeMail.id === 0) return;
    setStarredIds((current) => {
      const next = new Set(current);
      if (next.has(activeMail.id)) next.delete(activeMail.id); else next.add(activeMail.id);
      return next;
    });
    setActionStatus(starredIds.has(activeMail.id) ? "已取消星标" : "已加星标");
  };

  const markActiveUnread = async () => {
    if (!activeMail || activeMail.id === 0) return;
    const acc = activeAccount;
    if (!acc) return;
    if (acc.kind === "163") {
      try {
        await invoke("netease_mark_read", { email: acc.email.trim(), code: acc.code.trim(), uid: activeMail.id, unread: true });
        updateAccountMails(acc.id, (mails) => mails.map((mail) => mail.id === activeMail.id ? { ...mail, unread: true } : mail));
        setActionStatus("已标记为未读");
      } catch (error) { setActionStatus(error instanceof Error ? error.message : "标记未读失败"); }
      return;
    }
    if (!acc.client) { setActionStatus("演示模式：已记录为未读"); return; }
    try {
      await acc.client.markRead(activeMail.id, true);
      updateAccountMails(acc.id, (mails) => mails.map((mail) => mail.id === activeMail.id ? { ...mail, unread: true } : mail));
      setActionStatus("已标记为未读");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "标记未读失败"); }
  };

  const moveSelection = (direction: -1 | 1) => {
    const index = visibleMails.findIndex((mail) => mail.id === activeMail.id);
    const next = visibleMails[index + direction];
    if (next) openMail(next);
    else setActionStatus(direction < 0 ? "已经是第一封邮件" : "已经是最后一封邮件");
  };

  const openCompose = () => {
    setComposeFromId(sendableAccounts[0]?.id ?? "");
    setShowCompose(true);
  };

  const sendCompose = async () => {
    if (!composeTo.trim() || !composeSubject.trim()) { setActionStatus("请填写收件人、主题"); return; }
    // 临时邮箱不支持发送：仅允许从已连接的 163 账户中选取发件账户。
    const sender = accounts.find((a) => a.id === composeFromId && a.kind === "163");
    if (!sender) { setActionStatus("请先在设置中添加并连接 163 邮箱"); return; }
    try {
      await invoke("netease_send_mail", { email: sender.email.trim(), code: sender.code.trim(), to: composeTo.trim(), subject: composeSubject.trim(), content: composeBody });
      setShowCompose(false); setComposeTo(""); setComposeSubject(""); setComposeBody(""); setActionStatus("邮件已发送");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "发送失败"); }
  };

  const copyOtp = async () => {
    if (!activeMail.otp) return;
    await navigator.clipboard?.writeText(activeMail.otp.replace(/ /g, ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  // 验证码自动复制：邮件带 OTP 时直接写入剪贴板，避免手动复制。
  const autoCopyOtp = async (mail: Mail) => {
    if (!mail.otp) return;
    const code = mail.otp.replace(/ /g, "");
    await navigator.clipboard?.writeText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
    setActionStatus(`验证码 ${code} 已自动复制`);
  };

  // 临时邮箱自动刷新：每 20s 拉取新邮件，收到带验证码的新邮件立即自动复制到剪贴板。
  useEffect(() => {
    const acc = activeAccount;
    if (acc?.kind !== "cloudflare" || !acc.client) return;
    const cc = acc.client;
    const id = window.setInterval(async () => {
      try {
        const result = await cc.listParsedMails(1, 20);
        const next = result.results.map(toMail);
        setAccounts((current) => {
          const cur = current.find((a) => a.id === activeAccountId);
          const fresh = cur ? next.find((m) => m.otp && !cur.mails.some((c) => c.id === m.id && c.otp)) : undefined;
          if (fresh) window.setTimeout(() => void autoCopyOtp(fresh), 0);
          return current.map((a) => a.id === activeAccountId ? { ...a, mails: next, mailTotal: result.count } : a);
        });
        setMailTotal(result.count);
        setMailPage(1);
      } catch { /* 静默：网络抖动不打断用户 */ }
    }, 20_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId]);

  // 登录已有临时邮箱地址（邮箱 + 密码，密码按 SHA-256 哈希后交给 API）。
  const sha256Hex = async (s: string) => {
    const data = new TextEncoder().encode(s);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const loginTempMail = async () => {
    if (!tempLoginEmail.trim() || !tempLoginPwd) { setActionStatus("请输入临时邮箱和密码"); return; }
    setActionStatus("登录临时邮箱…"); setLoading(true);
    try {
      const apiClient = new CloudflareClient(apiBase);
      const passwordHash = await sha256Hex(tempLoginPwd);
      const settings = await apiClient.passwordLogin(tempLoginEmail.trim(), passwordHash);
      const jwt = apiClient.getToken();
      const address = settings.address || tempLoginEmail.trim();
      const id = `tmp:${address}`;
      await invoke("save_secret", { account: `account:${id}`, secret: jwt }).catch(() => undefined);
      const result = await apiClient.listParsedMails(1, 20);
      addOrReplaceAccount({ id, kind: "cloudflare", label: address, email: address, code: "", client: apiClient, mails: result.results.map(toMail), connected: true, mailTotal: result.count }, true);
      setMailTotal(result.count); setMailPage(1);
      setActionStatus(`已登录 · ${address}`);
      setShowSettings(false);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "登录临时邮箱失败"); }
    finally { setLoading(false); }
  };

  const syncCloudState = async () => {
    if (!syncBaseUrl.trim() || !syncToken.trim()) { setActionStatus("请先填写 Cloudflare 同步地址和令牌"); return; }
    setSyncLoading(true);
    const acc = activeAccount;
    if (!acc) { setActionStatus("请先连接邮箱账户"); setSyncLoading(false); return; }
    try {
      const accountRef = acc.email;
      const items = sourceMails.map((mail) => ({ account_ref: accountRef, provider: mail.provider || acc.kind, mail_id: String(mail.id), is_read: !mail.unread, starred: starredIds.has(mail.id), updated_at: Date.now() }));
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
      // 已读状态仅写回匹配账户的邮件列表。
      setAccounts((current) => current.map((a) => {
        const target = a.kind === "cloudflare" ? a.label === accountRef : a.email === accountRef;
        if (!target || a.kind !== "cloudflare") return a;
        return { ...a, mails: a.mails.map((m) => {
          const sync = items.find((it) => String(it.mail_id) === String(m.id) && it.is_read !== undefined);
          return sync ? { ...m, unread: sync.is_read ? false : m.unread } : m;
        }) };
      }));
      setActionStatus(`已从云端拉取 ${items.length} 条状态（已读 / 星标）`);
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
          <button className="compose-button" onClick={openCompose}><span>＋</span> 写邮件</button>
          <div className="account-card" onClick={() => setShowSettings(true)} role="button" title="管理邮箱账户"><div className="account-icon">{activeAccount?.kind === "163" ? "E" : (activeAccount ? "C" : "＋")}</div><div><strong>{activeAccount?.label ?? "未连接账户"}</strong><small>{activeAccount ? (activeAccount.kind === "163" ? "163 邮箱" : "Cloudflare 临时邮箱") : "添加账户以开始"}</small></div><span className="chevron">⌄</span></div>
          <nav className="nav-list">{navItems.map(([label, icon, count]) => <button key={label} className={`nav-item ${folder === label ? "active" : ""}`} onClick={() => selectFolder(label)}><span className="nav-icon">{icon}</span><span>{label}</span>{count && <b>{label === "验证码" ? sourceMails.filter((mail) => mail.otp).length : count}</b>}</button>)}</nav>
          <div className="sidebar-section"><div className="section-label">邮箱账户 <button onClick={() => setShowSettings(true)} title="添加邮箱" aria-label="添加邮箱">＋</button></div>{accounts.map((acc) => <div key={acc.id} className={`account-row ${acc.id === activeAccountId ? "active" : ""} ${acc.connected ? "" : "disconnected"}`} onClick={() => switchAccount(acc.id)} role="button" title={acc.connected ? "点击切换到该账户" : "该账户未连接，点击打开设置"}><span className={`status-dot ${acc.connected ? "orange" : "red"}`} /><span className="account-label">{acc.kind === "163" ? acc.email.split("@")[0] : acc.label}</span><em>{acc.mails.length}</em><button className="account-remove" onClick={(e) => { e.stopPropagation(); void removeAccount(acc.id); }} title="删除该账户" aria-label="删除账户">×</button></div>)}{accounts.length === 0 && <div className="account-empty" onClick={() => setShowSettings(true)} role="button">还没有账户，点击添加</div>}</div>
          <div className="sidebar-footer"><span className={`sync-dot ${loading ? "syncing" : ""}`} /> {actionStatus || (activeAccount ? (activeAccount.connected ? "已连接 · 可同步" : "未连接邮箱") : "未连接邮箱")}</div>
        </aside>
        <main className="mail-list-panel">
          <div className="panel-heading"><div><p className="eyebrow">{folder}</p><h1>{folder === "验证码" ? "验证码" : folder} <span>{sourceMails.length}{mailTotal > sourceMails.length && ` / ${mailTotal}`}</span></h1></div><button className="refresh-button" onClick={refreshInbox} disabled={loading || !activeAccount} title="刷新收件箱">{loading ? "…" : "↻"}</button></div>
          <div className="search-box"><span>⌕</span><input ref={searchInputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void searchCurrentMailbox(); }} placeholder="搜索邮件、发件人或验证码" /><kbd>Ctrl K</kbd></div>
          <div className="filter-row"><button className={`filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>全部</button><button className={`filter ${filter === "unread" ? "active" : ""}`} onClick={() => setFilter("unread")}>未读</button><button className={`filter ${filter === "attachments" ? "active" : ""}`} onClick={() => setFilter("attachments")}>带附件</button><button className={`filter otp-filter ${filter === "otp" ? "active" : ""}`} onClick={() => setFilter("otp")}>验证码 <span>{sourceMails.filter((mail) => mail.otp).length}</span></button></div>
          <div className="mail-list">{!activeAccount ? <div className="empty-state"><div className="empty-icon">✉</div><strong>尚未连接任何邮箱</strong><span>在设置中添加 163 或创建临时邮箱账户</span><button onClick={() => setShowSettings(true)}>添加邮箱账户</button></div> : visibleMails.length ? visibleMails.map((mail) => <button key={mail.id} onClick={() => openMail(mail)} className={`mail-row ${selected === mail.id ? "selected" : ""}`}><div className="sender-avatar" style={{ background: mail.color }}>{mail.sender.slice(0, 1)}</div><div className="mail-copy"><div className="mail-meta"><strong>{mail.sender}</strong><time>{mail.time}</time></div><div className="subject">{mail.subject} {mail.tag && <span className="tag">{mail.tag}</span>}</div><p>{mail.preview}</p></div>{starredIds.has(mail.id) && <span className="row-star">★</span>}{mail.unread && <i className="unread-dot" />}</button>) : <div className="empty-state"><div className="empty-icon">⌕</div><strong>没有找到邮件</strong><span>试试更换筛选条件或搜索关键词</span><button onClick={() => { setQuery(""); setFilter("all"); setFolder("收件箱"); }}>清除筛选</button></div>}{activeAccount?.kind === "cloudflare" && activeAccount.client && sourceMails.length < mailTotal && <button className="load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "加载中…" : `加载更多（剩余 ${mailTotal - sourceMails.length} 封）`}</button>}</div>
        </main>
        <section className={`reading-panel ${mobileDetailOpen ? "mobile-open" : ""}`}>
          <div className="reading-toolbar"><div className="toolbar-left"><button className="mobile-close" onClick={() => setMobileDetailOpen(false)} title="返回列表">×</button><button onClick={() => moveSelection(-1)} title="上一封">←</button><button onClick={() => moveSelection(1)} title="下一封">↗</button><button onClick={deleteActiveMail} title="删除">⌫</button><button onClick={markActiveUnread} title="标记未读">✉</button></div><div className="toolbar-right"><button onClick={toggleStar} title="星标">{starredIds.has(activeMail.id) ? "★" : "☆"}</button><button onClick={() => setActionStatus("更多操作：可使用删除、星标或标记未读")} title="更多操作">⋯</button></div></div>
          <article className="message"><div className="message-heading"><div className="sender-avatar large" style={{ background: activeMail.color }}>{activeMail.sender.slice(0, 1)}</div><div><h2>{activeMail.subject}</h2><div className="from-line"><strong>{activeMail.sender}</strong><span>&lt;{activeMail.address}&gt;</span><time>{activeMail.time}</time></div></div></div>
            {activeMail.otp && <div className="otp-card"><div className="otp-icon">◇</div><div className="otp-content"><small>检测到验证码</small><strong>{activeMail.otp}</strong><span>仅在此设备本地解析，不会上传邮件内容</span></div><button onClick={copyOtp}>{copied ? "已复制" : "复制"}</button></div>}
            <div className="message-body">{activeMail.html ? <div className="html-body" dangerouslySetInnerHTML={{ __html: renderMailHtml(activeMail.html) }} /> : activeMail.body ? <><p>{activeMail.body}</p>{activeMail.attachments && activeMail.attachments.length > 0 && <p className="muted">附件：{activeMail.attachments.length} 个</p>}</> : <><p>{activeAccount?.kind === "163" ? (activeAccount.mails.length ? "点击邮件加载 163 信箱真实正文。" : "163 邮箱尚未连接，请在设置中填写邮箱和授权码。") : (activeAccount?.client ? "点击邮件加载真实正文。" : "临时邮箱尚未连接，请在设置中连接邮箱或创建临时邮箱地址。")}</p><p className="muted">邮件正文按需加载，减少启动时间和网络流量。</p></>}</div>
          </article>
        </section>
      </div>
      {actionStatus && <div className="status-toast" role="status">{actionStatus}<button onClick={() => setActionStatus("")}>×</button></div>}
      {showSettings && <div className="modal-backdrop" onClick={() => setShowSettings(false)}><div className="modal" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">设置</p><h2>账户管理</h2></div><button onClick={() => setShowSettings(false)}>×</button></div><label>邮箱账户</label><div className="account-list">{accounts.length === 0 && <div className="empty-accounts">还没有账户，请在下方添加。</div>}{accounts.map((acc) => <div className={`settings-account ${acc.id === activeAccountId ? "active" : ""}`} key={acc.id}><span className="settings-kind">{acc.kind === "163" ? "E" : "C"}</span><div className="settings-acc-copy"><strong>{acc.label}</strong><small>{acc.kind === "163" ? "163 邮箱 · IMAP/SMTP" : "临时邮箱"} · {acc.connected ? "已连接" : "未连接"}</small></div><div className="account-actions"><button className="outline-button tiny" onClick={() => switchAccount(acc.id)} disabled={acc.id === activeAccountId}>{acc.id === activeAccountId ? "当前" : "切换"}</button>{acc.connected ? <button className="outline-button tiny" onClick={() => disconnectAccount(acc.id)}>断开</button> : <button className="outline-button tiny" onClick={() => void reconnectAccount(acc.id)}>重连</button>}<button className="outline-button tiny danger" onClick={() => void removeAccount(acc.id)} title="删除账户及已保存凭据">删除</button></div></div>)}</div><div className="ai-settings"><div className="settings-section-title">添加 163 邮箱账户</div><label>邮箱地址</label><input className="settings-input" value={add163Email} onChange={(e) => setAdd163Email(e.target.value)} placeholder="you@163.com" /><label>客户端授权码</label><input className="settings-input" type="password" value={add163Code} onChange={(e) => setAdd163Code(e.target.value)} placeholder="在 163 网页版「设置→客户端授权密码」获取" /><button className="compose-button connect-button" onClick={() => connectNetease()} disabled={loading}>{loading ? "连接中…" : "添加并连接 163"}</button><small className="settings-note ai-note">请先在 163 设置里开启 IMAP/SMTP 并生成授权码，使用授权码而不是网页登录密码。授权码仅保存在 Windows Credential Manager。</small></div><div className="ai-settings sync-settings"><div className="settings-section-title">临时邮箱（Cloudflare）</div><label>Cloudflare API 地址</label><input className="settings-input" value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://email.kodao.site" /><button className="outline-button ai-save" onClick={openCreateAddress} style={{ width: "100%", marginBottom: 14 }}>＋ 创建临时邮箱地址</button><label>邮箱凭据 / JWT</label><input className="settings-input" type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="凭据仅保存在 Windows Credential Manager" /><button className="compose-button connect-button" onClick={() => connectCloudflare()} disabled={loading}>{loading ? "连接中…" : "连接并同步收件箱"}</button><div className="sync-settings"><div className="settings-section-title">登录已有临时邮箱（邮箱 + 密码）</div><label>邮箱地址</label><input className="settings-input" value={tempLoginEmail} onChange={(e) => setTempLoginEmail(e.target.value)} placeholder="you@mail.kodao.site" /><label>密码</label><input className="settings-input" type="password" value={tempLoginPwd} onChange={(e) => setTempLoginPwd(e.target.value)} placeholder="创建该地址时返回的密码" /><button className="compose-button connect-button" onClick={loginTempMail} disabled={loading}>{loading ? "登录中…" : "登录并获取邮件"}</button><small className="settings-note ai-note">用邮件+密码登录已有临时邮箱，登录后自动切换并同步收件箱；密码按 SHA-256 哈希后传输，不落盘。</small></div></div><div className="ai-settings sync-settings"><div className="settings-section-title">Cloudflare 云同步（可选）</div><label>同步 Worker 地址</label><input className="settings-input" value={syncBaseUrl} onChange={(e) => setSyncBaseUrl(e.target.value)} placeholder="https://cloudmail-sync.example.workers.dev" /><label>同步令牌</label><input className="settings-input" type="password" value={syncToken} onChange={(e) => setSyncToken(e.target.value)} placeholder="只保存在本次浏览器会话" /><button className="outline-button ai-save" onClick={syncCloudState} disabled={syncLoading}>{syncLoading ? "同步中…" : "同步已读、星标状态"}</button><small className="settings-note ai-note">默认不上传邮件正文、附件、JWT 或 163 授权码；仅同步邮件 ID 和已读 / 星标状态。</small></div><div className="settings-note">凭据通过 Tauri 存入 Windows Credential Manager，不会写入日志或同步到云端。</div></div></div>}
      {showCreate && <div className="modal-backdrop" onClick={() => setShowCreate(false)}><div className="modal" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">临时邮箱</p><h2>创建临时邮箱地址</h2></div><button onClick={() => setShowCreate(false)}>×</button></div><label>用户名</label><input className="settings-input" value={tempName} onChange={(e) => setTempName(e.target.value.replace(/[^a-z0-9_.-]/gi, ""))} placeholder="自定义用户名（字母/数字）" /><label>域名</label>{availableDomains.length ? <select className="settings-input" value={tempDomain} onChange={(e) => setTempDomain(e.target.value)}>{availableDomains.map((d) => <option key={d} value={d}>{d}</option>)}</select> : <input className="settings-input" value={tempDomain} onChange={(e) => setTempDomain(e.target.value)} placeholder="mail.kodao.site" />}<div className="settings-note" style={{ minHeight: 24 }}>{tempName.trim() && tempDomain && <span>将创建：<strong>{tempName.trim()}@{tempDomain.replace(/^@/, "")}</strong></span>}</div><button className="compose-button connect-button" onClick={createTempMail} disabled={loading || !tempName.trim()}>{loading ? "创建中…" : "创建临时邮箱"}</button><small className="settings-note ai-note">创建后自动切换新地址并同步收件箱，JWT 会保存到 Windows Credential Manager。临时邮箱可用于接收验证码等一次性邮件。</small></div></div>}
      {showCompose && <div className="modal-backdrop" onClick={() => setShowCompose(false)}><div className="modal compose" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">新邮件</p><h2>写邮件</h2></div><button onClick={() => setShowCompose(false)}>×</button></div><label className="compose-label">发件账户（仅 163 可发送）</label>{sendableAccounts.length ? <select className="settings-input compose-from" value={composeFromId} onChange={(e) => setComposeFromId(e.target.value)}>{sendableAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select> : <div className="compose-none"><span className="status-dot red" /> 暂无已连接的 163 账户，临时邮箱不支持发送</div>}<input value={composeTo} onChange={(e) => setComposeTo(e.target.value)} placeholder="收件人" /><input value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} placeholder="主题" /><textarea value={composeBody} onChange={(e) => setComposeBody(e.target.value)} placeholder="输入邮件内容…" rows={7} /><div className="compose-footer"><span>发件：{accounts.find((a) => a.id === composeFromId)?.label ?? "请选择 163 账户"}</span><button className="compose-button small" onClick={sendCompose} disabled={!sendableAccounts.length}>{sendableAccounts.length ? "发送" : "无可用发件账户"}</button></div><small className="settings-note">临时邮箱不支持发送，请在设置中添加并连接一个 163 邮箱作为发件账户。</small></div></div>}
    </div>
  );
}

export default App;