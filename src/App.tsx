import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CloudflareClient, normalizeCloudflareMail, type ParsedMail } from "./api/cloudflare";
import { findOtpCandidates } from "./api/otp";
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
};

const mails: Mail[] = [
  { id: 1, sender: "GitHub", address: "noreply@github.com", subject: "Your GitHub verification code", preview: "Use 482 193 to verify your new sign-in…", time: "刚刚", unread: true, otp: "482 193", tag: "验证码", color: "#24292f" },
  { id: 2, sender: "Cloudflare 临时邮箱", address: "mail.kodao.site", subject: "欢迎使用 CloudMail", preview: "你的临时邮箱已经准备好，所有新邮件会显示在这里。", time: "8:41", unread: true, tag: "临时邮箱", color: "#f38020" },
  { id: 3, sender: "Apple", address: "appleid@id.apple.com", subject: "Your Apple ID was used to sign in", preview: "Your Apple ID was used to sign in on a new device.", time: "昨天", color: "#111827" },
  { id: 4, sender: "网易邮箱", address: "service@mail.163.com", subject: "客户端授权码设置提醒", preview: "请妥善保管你的客户端授权码，不要泄露给任何人。", time: "周一", tag: "163", color: "#d62828" },
  { id: 5, sender: "Notion", address: "team@makenotion.com", subject: "Your weekly workspace digest", preview: "Here’s what happened in your workspace this week…", time: "周日", color: "#111111" },
];

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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailCache = useRef(new Map<number, Mail>());

  const selectFolder = (label: string) => {
    setFolder(label);
    setFilter(label === "验证码" ? "otp" : "all");
  };

  const sourceMails = remoteMails ?? mails;
  const activeMail = sourceMails.find((mail) => mail.id === selected) ?? sourceMails[0];
  const visibleMails = useMemo(() => sourceMails.filter((mail) => {
    const text = `${mail.sender} ${mail.address} ${mail.subject} ${mail.preview}`.toLowerCase();
    const matchesFilter = filter === "all"
      || (filter === "unread" && mail.unread)
      || (filter === "attachments" && Boolean(mail.attachments?.length))
      || (filter === "otp" && Boolean(mail.otp));
    return matchesFilter && text.includes(deferredQuery.toLowerCase());
  }), [deferredQuery, filter, sourceMails]);

  useEffect(() => {
    invoke<string | null>("get_secret", { account: "cloudflare-credential" }).then((saved) => {
      if (saved) setCredential(saved);
    }).catch(() => undefined);
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

  const connectCloudflare = async () => {
    if (!credential.trim()) { setApiStatus("请输入邮箱凭据"); return; }
    setApiStatus("连接中…");
    try {
      const apiClient = new CloudflareClient(apiBase);
      const settings = await apiClient.credentialLogin(credential);
      await invoke("save_secret", { account: "cloudflare-credential", secret: credential });
      const result = await apiClient.listMails(1, 20);
      setClient(apiClient);
      setRemoteMails(result.results.map(toMail));
      setMailTotal(result.count);
      setMailPage(1);
      setApiStatus(`已连接 · ${settings.address || "Cloudflare 邮箱"}`);
      setShowSettings(false);
    } catch (error) {
      setApiStatus(error instanceof Error ? error.message : "连接失败");
    }
  };

  const toMail = (mail: ParsedMail): Mail => {
    const normalized = normalizeCloudflareMail(mail);
    const body = String(mail.text || mail.html || mail.message || "");
    const otp = findOtpCandidates(`${mail.subject || ""}\n${body}`)[0]?.value;
    return { ...normalized, body, html: mail.html, otp, tag: otp ? "验证码" : "实时", color: "#f38020" } as Mail;
  };

  const refreshInbox = async () => {
    if (!client) { setShowSettings(true); return; }
    setLoading(true); setActionStatus("");
    try {
      const result = await client.listMails(1, 20);
      setRemoteMails(result.results.map(toMail));
      setMailTotal(result.count);
      setMailPage(1);
      setActionStatus(`已更新 ${result.results.length} 封邮件`);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "刷新失败"); }
    finally { setLoading(false); }
  };

  const loadMore = async () => {
    if (!client || loadingMore || sourceMails.length >= mailTotal) return;
    setLoadingMore(true);
    try {
      const nextPage = mailPage + 1;
      const result = await client.listMails(nextPage, 20);
      setRemoteMails((current) => [...(current ?? []), ...result.results.map(toMail)]);
      setMailPage(nextPage);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "加载更多失败"); }
    finally { setLoadingMore(false); }
  };

  const openMail = async (mail: Mail) => {
    setSelected(mail.id);
    const cached = detailCache.current.get(mail.id);
    if (cached) {
      setRemoteMails((current) => current?.map((item) => item.id === mail.id ? cached : item) ?? current);
      return;
    }
    if (!client || mail.body) return;
    try {
      const detail = await client.getParsedMail(mail.id);
      const detailedMail = toMail(detail);
      detailCache.current.set(mail.id, detailedMail);
      if (detailCache.current.size > 30) detailCache.current.delete(detailCache.current.keys().next().value as number);
      setRemoteMails((current) => current?.map((item) => item.id === mail.id ? detailedMail : item) ?? current);
      if (mail.unread) await client.markRead(mail.id, false);
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "邮件加载失败"); }
  };

  const deleteActiveMail = async () => {
    if (!client || !activeMail) return;
    try {
      await client.deleteMail(activeMail.id);
      setRemoteMails((current) => current?.filter((item) => item.id !== activeMail.id) ?? current);
      setActionStatus("邮件已删除");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "删除失败"); }
  };

  const sendCompose = async () => {
    if (!client || !composeTo.trim() || !composeSubject.trim()) { setActionStatus("请先连接邮箱并填写收件人、主题"); return; }
    try {
      await client.sendMail({ to_mail: composeTo.trim(), subject: composeSubject.trim(), content: composeBody, is_html: false });
      setShowCompose(false); setComposeTo(""); setComposeSubject(""); setComposeBody(""); setActionStatus("邮件已发送");
    } catch (error) { setActionStatus(error instanceof Error ? error.message : "发送失败"); }
  };

  const copyOtp = async () => {
    if (!activeMail.otp) return;
    await navigator.clipboard?.writeText(activeMail.otp.replace(/ /g, ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand"><div className="brand-mark">C</div><span>CloudMail</span><small>Windows</small></div>
        <div className="titlebar-actions"><button className="icon-button" aria-label="搜索">⌕</button><button className="icon-button" aria-label="设置" onClick={() => setShowSettings(true)}>⚙</button><div className="avatar">K</div></div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <button className="compose-button" onClick={() => setShowCompose(true)}><span>＋</span> 写邮件</button>
          <div className="account-card"><div className="account-icon">K</div><div><strong>mail.kodao.site</strong><small>Cloudflare 临时邮箱</small></div><span className="chevron">⌄</span></div>
          <nav className="nav-list">{navItems.map(([label, icon, count]) => <button key={label} className={`nav-item ${folder === label ? "active" : ""}`} onClick={() => selectFolder(label)}><span className="nav-icon">{icon}</span><span>{label}</span>{count && <b>{label === "验证码" ? sourceMails.filter((mail) => mail.otp).length : count}</b>}</button>)}</nav>
          <div className="sidebar-section"><div className="section-label">邮箱账户 <button onClick={() => setShowSettings(true)}>＋</button></div><button className="account-row"><span className="status-dot orange" /> 临时邮箱 <em>12</em></button><button className="account-row"><span className="status-dot red" /> 163 邮箱 <em>0</em></button></div>
          <div className="sidebar-footer"><span className={`sync-dot ${loading ? "syncing" : ""}`} /> {actionStatus || (client ? "已连接 · 可同步" : "演示数据")}</div>
        </aside>
        <main className="mail-list-panel">
          <div className="panel-heading"><div><p className="eyebrow">{folder}</p><h1>{folder === "验证码" ? "验证码" : "收件箱"} <span>{sourceMails.length}{mailTotal > sourceMails.length && ` / ${mailTotal}`}</span></h1></div><button className="refresh-button" onClick={refreshInbox} disabled={loading} title="刷新收件箱">{loading ? "…" : "↻"}</button></div>
          <div className="search-box"><span>⌕</span><input ref={searchInputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索邮件、发件人或验证码" /><kbd>Ctrl K</kbd></div>
          <div className="filter-row"><button className={`filter ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>全部</button><button className={`filter ${filter === "unread" ? "active" : ""}`} onClick={() => setFilter("unread")}>未读</button><button className={`filter ${filter === "attachments" ? "active" : ""}`} onClick={() => setFilter("attachments")}>带附件</button><button className={`filter otp-filter ${filter === "otp" ? "active" : ""}`} onClick={() => setFilter("otp")}>验证码 <span>{sourceMails.filter((mail) => mail.otp).length}</span></button></div>
          <div className="mail-list">{visibleMails.length ? visibleMails.map((mail) => <button key={mail.id} onClick={() => openMail(mail)} className={`mail-row ${selected === mail.id ? "selected" : ""}`}><div className="sender-avatar" style={{ background: mail.color }}>{mail.sender.slice(0, 1)}</div><div className="mail-copy"><div className="mail-meta"><strong>{mail.sender}</strong><time>{mail.time}</time></div><div className="subject">{mail.subject} {mail.tag && <span className="tag">{mail.tag}</span>}</div><p>{mail.preview}</p></div>{mail.unread && <i className="unread-dot" />}</button>) : <div className="empty-state"><div className="empty-icon">⌕</div><strong>没有找到邮件</strong><span>试试更换筛选条件或搜索关键词</span><button onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button></div>}{client && sourceMails.length < mailTotal && <button className="load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "加载中…" : `加载更多（剩余 ${mailTotal - sourceMails.length} 封）`}</button>}</div>
        </main>
        <section className="reading-panel">
          <div className="reading-toolbar"><div className="toolbar-left"><button>←</button><button>↗</button><button onClick={deleteActiveMail}>⌫</button></div><div className="toolbar-right"><button>☆</button><button>⋯</button></div></div>
          <article className="message"><div className="message-heading"><div className="sender-avatar large" style={{ background: activeMail.color }}>{activeMail.sender.slice(0, 1)}</div><div><h2>{activeMail.subject}</h2><div className="from-line"><strong>{activeMail.sender}</strong><span>&lt;{activeMail.address}&gt;</span><time>{activeMail.time}</time></div></div></div>
            {activeMail.otp && <div className="otp-card"><div className="otp-icon">◇</div><div className="otp-content"><small>检测到验证码</small><strong>{activeMail.otp}</strong><span>仅在此设备本地解析，不会上传邮件内容</span></div><button onClick={copyOtp}>{copied ? "已复制" : "复制"}</button></div>}
            <div className="message-body">{activeMail.body ? <><p>{activeMail.body}</p>{activeMail.attachments && activeMail.attachments.length > 0 && <p className="muted">附件：{activeMail.attachments.length} 个</p>}</> : <><p>Hi there,</p><p>连接邮箱后点击邮件即可加载真实正文。当前为演示内容。</p><div className="code-box"><span>Verification code</span><strong>{activeMail.otp ?? "—"}</strong></div><p className="muted">邮件正文默认按需加载，减少启动时间和网络流量。</p></>}</div>
          </article>
        </section>
      </div>
      {actionStatus && <div className="status-toast" role="status">{actionStatus}<button onClick={() => setActionStatus("")}>×</button></div>}
      {showSettings && <div className="modal-backdrop" onClick={() => setShowSettings(false)}><div className="modal" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">设置</p><h2>账户与同步</h2></div><button onClick={() => setShowSettings(false)}>×</button></div><label>邮箱账户</label><div className="settings-account"><span className={`status-dot ${client ? "orange" : "red"}`} /><div><strong>mail.kodao.site</strong><small>{apiStatus}</small></div><span className="connected">{client ? "已连接" : "未连接"}</span></div><label>Cloudflare API 地址</label><input className="settings-input" value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://email.kodao.site" /><label>邮箱凭据 / JWT</label><input className="settings-input" type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="凭据仅保存在 Windows Credential Manager" /><button className="compose-button connect-button" onClick={connectCloudflare} disabled={loading}>{loading ? "连接中…" : "连接并同步收件箱"}</button><div className="settings-account muted-account"><span className="status-dot red" /><div><strong>163 邮箱</strong><small>使用授权码连接 IMAP/SMTP</small></div><button className="outline-button">即将支持</button></div><div className="settings-note">凭据通过 Tauri 存入 Windows Credential Manager，不会写入日志或同步到云端。</div></div></div>}
      {showCompose && <div className="modal-backdrop" onClick={() => setShowCompose(false)}><div className="modal compose" onClick={(e) => e.stopPropagation()}><div className="modal-header"><div><p className="eyebrow">新邮件</p><h2>写邮件</h2></div><button onClick={() => setShowCompose(false)}>×</button></div><input value={composeTo} onChange={(e) => setComposeTo(e.target.value)} placeholder="收件人" /><input value={composeSubject} onChange={(e) => setComposeSubject(e.target.value)} placeholder="主题" /><textarea value={composeBody} onChange={(e) => setComposeBody(e.target.value)} placeholder="输入邮件内容…" rows={7} /><div className="compose-footer"><span>当前账户：mail.kodao.site</span><button className="compose-button small" onClick={sendCompose}>发送</button></div></div></div>}
    </div>
  );
}

export default App;
