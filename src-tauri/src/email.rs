// 163 邮箱 IMAP/SMTP 接入。
// 收信用 `daaki-imap`(async tokio + rustls)，发信用 `lettre`。授权码仅作为密码随命令传入，
// 由前端保存到 Windows Credential Manager，不会写日志或同步到云端。
//
// 关键：网易要求登录后发送 IMAP ID 扩展（RFC 2971）。不发送 ID 时，`SELECT` 会返回
// `SELECT Unsafe Login`。`open_session` 在登录成功后立即发送 `id` 以规避该问题。
use std::time::Duration;

use serde::Serialize;

use daaki_imap::{Envelope, EnvelopeAddress, FetchAttr, Flag, ImapConnection, SequenceSet, StoreOperation, TlsMode};

use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{Message, SmtpTransport, Transport};

const IMAP_HOST: &str = "imap.163.com";
const IMAP_PORT: u16 = 993;
const SMTP_HOST: &str = "smtp.163.com";
const TIMEOUT: Duration = Duration::from_secs(30);
const CLIENT_VERSION: &str = "0.1.7";

// 将 IMAP INTERNALDATE（如 "17-Jul-1996 02:44:25 -0700"）转为含时区的 ISO 串
// （如 "1996-07-17T02:44:25-07:00"），以保持前端 date.replace("T"," ").slice(5,16) 的展示格式。
fn imap_date_to_iso(raw: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let parts: Vec<&str> = raw.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return raw.to_string();
    }
    let date_part = parts[0]; // DD-Mon-YYYY
    let time_part = parts[1]; // HH:MM:SS
    let zone = parts.get(2).copied(); // ±HHMM（IMAP 风格，时区固定 4 位数字）
    let mut dp = date_part.split('-');
    let (dd, mon, yyyy) = match (dp.next(), dp.next(), dp.next()) {
        (Some(d), Some(m), Some(y)) => (d, m, y),
        _ => return raw.to_string(),
    };
    let mm = MONTHS
        .iter()
        .position(|&m| m.eq_ignore_ascii_case(mon))
        .map(|i| format!("{:02}", i + 1))
        .unwrap_or_else(|| mon.to_string());
    let zone_str = match zone {
        Some(z) if z.len() == 5 && (z.starts_with('+') || z.starts_with('-')) => {
            format!("{}{}:{}", &z[..1], &z[1..3], &z[3..5])
        }
        Some(z) => z.to_string(),
        None => "Z".to_string(),
    };
    format!("{yyyy}-{mm}-{dd}T{time_part}{zone_str}")
}

/// 打开一条 163 IMAP 连接并登录，随后发送 ID 扩展（RFC 2971）。
async fn open_session(email: &str, code: &str) -> Result<ImapConnection, String> {
    let conn = ImapConnection::connect(IMAP_HOST, IMAP_PORT, TlsMode::Implicit, TIMEOUT)
        .await
        .map_err(|e| format!("连接 {IMAP_HOST} 失败: {e}"))?;
    conn.login(email, code, TIMEOUT).await.map_err(|e| {
        let detail = e.to_string();
        if detail.to_ascii_lowercase().contains("unsafe login") {
            "163 拒绝连接：Unsafe Login。请确认已在网易邮箱网页版开启 IMAP/SMTP，且客户端授权码有效；客户端已尝试发送 ID 扩展（RFC 2971）。".to_string()
        } else {
            format!("163 登录失败（请确认已开启 IMAP/SMTP 且授权码正确）: {detail}")
        }
    })?;
    // 网易要求登录后发送 ID，否则 SELECT 会返回 "Unsafe Login"。失败不影响后续操作。
    let _ = conn
        .id(
            &[
                ("name", Some("CloudMail")),
                ("version", Some(CLIENT_VERSION)),
                ("vendor", Some("codao")),
            ],
            TIMEOUT,
        )
        .await;
    Ok(conn)
}

fn flags_unread(flags: &[Flag]) -> bool {
    !flags.iter().any(|f| matches!(f, Flag::Seen))
}

fn sender_from(from: &[EnvelopeAddress]) -> String {
    match from.first() {
        None => "未知发件人".to_string(),
        Some(a) => {
            let name = a.name.as_deref().unwrap_or("").trim().to_string();
            let mailbox = a.mailbox.as_deref().unwrap_or("").to_string();
            let host = a.host.as_deref().unwrap_or("").to_string();
            if name.is_empty() {
                format!("{mailbox}@{host}")
            } else {
                format!("{name} <{mailbox}@{host}>")
            }
        }
    }
}

fn envelope_meta(env: &Envelope) -> (String, String) {
    let subject = env.subject.as_deref().unwrap_or("").trim().to_string();
    (subject, sender_from(&env.from))
}

fn fetch_to_meta(f: &daaki_imap::FetchResponse) -> ImapMailMeta {
    let (subject, sender) = f
        .envelope
        .as_ref()
        .map(envelope_meta)
        .unwrap_or_default();
    ImapMailMeta {
        id: f.uid.unwrap_or(0),
        subject: if subject.is_empty() {
            "无主题".to_string()
        } else {
            subject
        },
        sender,
        date: f
            .internal_date
            .as_deref()
            .map(imap_date_to_iso)
            .unwrap_or_default(),
        unread: flags_unread(f.flags.as_deref().unwrap_or(&[])),
    }
}

#[derive(Clone, Serialize)]
pub struct ImapMailMeta {
    pub id: u32,
    pub subject: String,
    pub sender: String,
    pub date: String,
    pub unread: bool,
}

#[derive(Clone, Serialize)]
pub struct ImapMailDetail {
    pub id: u32,
    pub subject: String,
    pub sender: String,
    pub date: String,
    pub unread: bool,
    pub body: String,
}

/// 列出收件箱邮件（仅元数据）。
#[tauri::command]
pub async fn netease_list_emails(email: String, code: String) -> Result<Vec<ImapMailMeta>, String> {
    let conn = open_session(&email, &code).await?;
    conn.select("INBOX", TIMEOUT)
        .await
        .map_err(|e| format!("打开收件箱失败: {e}"))?;
    let items = [
        FetchAttr::Uid,
        FetchAttr::Flags,
        FetchAttr::Envelope,
        FetchAttr::InternalDate,
    ];
    let fetched = conn
        .fetch(&SequenceSet::new("1:*"), &items, TIMEOUT)
        .await
        .map_err(|e| format!("读取邮件列表失败: {e}"))?;
    let list: Vec<ImapMailMeta> = fetched.iter().map(fetch_to_meta).collect();
    let _ = conn.logout().await;
    Ok(list)
}

/// 在 163 收件箱执行服务端搜索，避免只搜索当前已经加载的列表。
#[tauri::command]
pub async fn netease_search_emails(
    email: String,
    code: String,
    query: String,
) -> Result<Vec<ImapMailMeta>, String> {
    let query = query.trim().chars().take(120).collect::<String>();
    if query.is_empty() {
        return netease_list_emails(email, code).await;
    }
    let conn = open_session(&email, &code).await?;
    conn.select("INBOX", TIMEOUT)
        .await
        .map_err(|e| format!("打开收件箱失败: {e}"))?;
    let escaped = query.replace('"', "");
    let criteria = format!("OR SUBJECT \"{escaped}\" FROM \"{escaped}\"");
    let res = conn
        .uid_search(criteria, TIMEOUT)
        .await
        .map_err(|e| format!("网易邮箱搜索失败: {e}"))?;
    let ids = res.ids;
    let mut list: Vec<ImapMailMeta> = Vec::new();
    if !ids.is_empty() {
        let uid_set = ids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let items = [
            FetchAttr::Uid,
            FetchAttr::Flags,
            FetchAttr::Envelope,
            FetchAttr::InternalDate,
        ];
        let fetched = conn
            .uid_fetch(&SequenceSet::new(uid_set), &items, TIMEOUT)
            .await
            .map_err(|e| format!("读取搜索结果失败: {e}"))?;
        list = fetched.iter().map(fetch_to_meta).collect();
        list.sort_by(|a, b| b.id.cmp(&a.id));
    }
    let _ = conn.logout().await;
    Ok(list)
}

/// 按 UID 拉取单封邮件正文（不标记已读）。
#[tauri::command]
pub async fn netease_fetch_email(
    email: String,
    code: String,
    uid: u32,
) -> Result<ImapMailDetail, String> {
    let conn = open_session(&email, &code).await?;
    conn.select("INBOX", TIMEOUT)
        .await
        .map_err(|e| format!("打开收件箱失败: {e}"))?;
    let items = [
        FetchAttr::Uid,
        FetchAttr::Flags,
        FetchAttr::Envelope,
        FetchAttr::InternalDate,
        FetchAttr::BodySection {
            peek: true,
            section: Some("TEXT".to_string()),
            partial: None,
        },
    ];
    let fetched = conn
        .uid_fetch(&SequenceSet::new(uid.to_string()), &items, TIMEOUT)
        .await
        .map_err(|e| format!("读取邮件详情失败: {e}"))?;
    let f = fetched
        .iter()
        .next()
        .ok_or_else(|| "找不到该邮件".to_string())?;
    let (subject, sender) = f
        .envelope
        .as_ref()
        .map(envelope_meta)
        .unwrap_or_default();
    let body_bytes: Vec<u8> = f
        .body_sections
        .iter()
        .filter_map(|bs| bs.data.as_deref())
        .flatten()
        .copied()
        .collect();
    let detail = ImapMailDetail {
        id: f.uid.unwrap_or(uid),
        subject: if subject.is_empty() {
            "无主题".to_string()
        } else {
            subject
        },
        sender,
        unread: flags_unread(f.flags.as_deref().unwrap_or(&[])),
        body: String::from_utf8_lossy(&body_bytes).to_string(),
        date: f
            .internal_date
            .as_deref()
            .map(imap_date_to_iso)
            .unwrap_or_default(),
    };
    let _ = conn.logout().await;
    Ok(detail)
}

/// 标记已读 / 未读。
#[tauri::command]
pub async fn netease_mark_read(
    email: String,
    code: String,
    uid: u32,
    unread: bool,
) -> Result<(), String> {
    let conn = open_session(&email, &code).await?;
    conn.select("INBOX", TIMEOUT)
        .await
        .map_err(|e| format!("打开收件箱失败: {e}"))?;
    let operation = if unread {
        StoreOperation::Remove
    } else {
        StoreOperation::Add
    };
    conn.uid_store(
        &SequenceSet::new(uid.to_string()),
        operation,
        &[Flag::Seen],
        None,
        TIMEOUT,
    )
    .await
    .map_err(|e| format!("更新已读状态失败: {e}"))?;
    let _ = conn.logout().await;
    Ok(())
}

/// 删除邮件：标记已删并 expunge。
#[tauri::command]
pub async fn netease_delete_email(email: String, code: String, uid: u32) -> Result<(), String> {
    let conn = open_session(&email, &code).await?;
    conn.select("INBOX", TIMEOUT)
        .await
        .map_err(|e| format!("打开收件箱失败: {e}"))?;
    conn.uid_store(
        &SequenceSet::new(uid.to_string()),
        StoreOperation::Add,
        &[Flag::Deleted],
        None,
        TIMEOUT,
    )
    .await
    .map_err(|e| format!("标记删除失败: {e}"))?;
    let _ = conn
        .expunge(TIMEOUT)
        .await
        .map_err(|e| format!("删除失败: {e}"))?;
    let _ = conn.logout().await;
    Ok(())
}

/// 发送纯文本邮件（163 SMTP）。
#[tauri::command]
pub async fn netease_send_mail(
    email: String,
    code: String,
    to: String,
    subject: String,
    content: String,
) -> Result<(), String> {
    // 用字符串 parse 构建信封，Mailbox 类型交由编译器推断（无需手写路径）。
    let message = Message::builder()
        .from(email.parse().map_err(|e: lettre::address::AddressError| format!("发件地址无效: {e}"))?)
        .to(to.trim().parse().map_err(|e: lettre::address::AddressError| format!("收件人地址无效: {e}"))?)
        .subject(subject)
        .body(content)
        .map_err(|e| format!("构建邮件失败: {e}"))?;
    let transport = SmtpTransport::relay(SMTP_HOST)
        .map_err(|e| format!("SMTP 配置失败: {e}"))?
        .credentials(Credentials::new(email, code))
        .authentication(vec![Mechanism::Login])
        .build();
    transport
        .send(&message)
        .map_err(|e| format!("发送失败: {e}"))?;
    Ok(())
}