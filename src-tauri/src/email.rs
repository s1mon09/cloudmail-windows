// 163 邮箱 IMAP/SMTP 接入。
// 收信用 `imap`(blocking + native-tls)，发信用 `lettre`。授权码仅作为密码随命令传入，
// 由前端保存到 Windows Credential Manager，不会写日志或同步到云端。
use serde::Serialize;

use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{Message, SmtpTransport, Transport};

const IMAP_HOST: &str = "imap.163.com";
const IMAP_PORT: u16 = 993;
const SMTP_HOST: &str = "smtp.163.com";

type ImapSession = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

// 从 IMAP Envelope 提取 (subject, sender)。用宏展开以避免显式命名 imap_proto 类型。
macro_rules! envelope_text {
    ($env:expr) => {{
        let env = $env;
        let subject = env
            .subject
            .as_deref()
            .map(String::from_utf8_lossy)
            .unwrap_or_default()
            .trim()
            .to_string();
        let sender = match env.from.as_ref().and_then(|list| list.first()) {
            None => "未知发件人".to_string(),
            Some(addr) => {
                let name = addr
                    .name
                    .as_deref()
                    .map(String::from_utf8_lossy)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let mailbox = addr
                    .mailbox
                    .as_deref()
                    .map(String::from_utf8_lossy)
                    .unwrap_or_default()
                    .to_string();
                let host = addr
                    .host
                    .as_deref()
                    .map(String::from_utf8_lossy)
                    .unwrap_or_default()
                    .to_string();
                if name.is_empty() {
                    format!("{mailbox}@{host}")
                } else {
                    format!("{name} <{mailbox}@{host}>")
                }
            }
        };
        (subject, sender)
    }};
}

/// 打开一条 163 IMAP 连接并登录。
fn open_imap(email: &str, code: &str) -> Result<ImapSession, String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| format!("初始化 TLS 失败: {e}"))?;
    let client = imap::connect((IMAP_HOST, IMAP_PORT), IMAP_HOST, &tls)
        .map_err(|e| format!("连接 {IMAP_HOST} 失败: {e}"))?;
    client
        .login(email, code)
        .map_err(|(e, _)| format!("163 登录失败（请确认已开启 IMAP/SMTP 且授权码正确）: {e}"))
}

fn flags_unread(flags: &[imap::types::Flag]) -> bool {
    !flags.iter().any(|f| matches!(f, imap::types::Flag::Seen))
}

fn fetch_to_meta(fetch: &imap::types::Fetch) -> ImapMailMeta {
    let envelope = fetch.envelope();
    let (subject, sender) = envelope
        .map(|env| envelope_text!(env))
        .unwrap_or_default();
    ImapMailMeta {
        id: fetch.uid.unwrap_or(0),
        subject: if subject.is_empty() {
            "无主题".to_string()
        } else {
            subject
        },
        sender,
        date: fetch
            .internal_date()
            .map(|d| d.to_rfc3339())
            .unwrap_or_default(),
        unread: flags_unread(fetch.flags()),
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
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = open_imap(&email, &code)?;
        session
            .select("INBOX")
            .map_err(|e| format!("打开收件箱失败: {e}"))?;
        let fetched = session
            .fetch("1:*", "(UID ENVELOPE FLAGS INTERNALDATE)")
            .map_err(|e| format!("读取邮件列表失败: {e}"))?;
        let list: Vec<ImapMailMeta> = fetched.iter().map(fetch_to_meta).collect();
        let _ = session.logout();
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 按 UID 拉取单封邮件正文（不标记已读）。
#[tauri::command]
pub async fn netease_fetch_email(email: String, code: String, uid: u32) -> Result<ImapMailDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = open_imap(&email, &code)?;
        session
            .select("INBOX")
            .map_err(|e| format!("打开收件箱失败: {e}"))?;
        let uid_set = uid.to_string();
        let fetched = session
            .uid_fetch(&uid_set, "(UID ENVELOPE FLAGS INTERNALDATE BODY.PEEK[TEXT])")
            .map_err(|e| format!("读取邮件详情失败: {e}"))?;
        let fetch = fetched
            .iter()
            .next()
            .ok_or_else(|| "找不到该邮件".to_string())?;
        let envelope = fetch.envelope();
        let (subject, sender) = envelope
            .map(|env| envelope_text!(env))
            .unwrap_or_default();
        let detail = ImapMailDetail {
            id: fetch.uid.unwrap_or(uid),
            subject: if subject.is_empty() {
                "无主题".to_string()
            } else {
                subject
            },
            sender,
            unread: flags_unread(fetch.flags()),
            body: fetch
                .body()
                .map(String::from_utf8_lossy)
                .unwrap_or_default()
                .to_string(),
            date: fetch
                .internal_date()
                .map(|d| d.to_rfc3339())
                .unwrap_or_default(),
        };
        let _ = session.logout();
        Ok(detail)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 标记已读 / 未读。
#[tauri::command]
pub async fn netease_mark_read(email: String, code: String, uid: u32, unread: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = open_imap(&email, &code)?;
        session
            .select("INBOX")
            .map_err(|e| format!("打开收件箱失败: {e}"))?;
        let query = if unread {
            "-FLAGS (\\Seen)"
        } else {
            "+FLAGS (\\Seen)"
        };
        session
            .uid_store(&uid.to_string(), query)
            .map_err(|e| format!("更新已读状态失败: {e}"))?;
        let _ = session.logout();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除邮件：标记已删并 expunge。
#[tauri::command]
pub async fn netease_delete_email(email: String, code: String, uid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = open_imap(&email, &code)?;
        session
            .select("INBOX")
            .map_err(|e| format!("打开收件箱失败: {e}"))?;
        session
            .uid_store(&uid.to_string(), "+FLAGS (\\Deleted)")
            .map_err(|e| format!("标记删除失败: {e}"))?;
        session.expunge().map_err(|e| format!("删除失败: {e}"))?;
        let _ = session.logout();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
}