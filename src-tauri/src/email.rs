// 163 邮箱 IMAP/SMTP 接入。
// 收信用 `daaki-imap`(async tokio + rustls)，发信用 `lettre`。授权码仅作为密码随命令传入，
// 由前端保存到 Windows Credential Manager，不会写日志或同步到云端。
//
// 关键：网易要求登录后发送 IMAP ID 扩展（RFC 2971）。不发送 ID 时，`SELECT` 会返回
// `SELECT Unsafe Login`。`open_session` 在登录成功后立即发送 `id` 以规避该问题。
use std::time::Duration;

use serde::Serialize;

use daaki_imap::{Envelope, EnvelopeAddress, FetchAttr, Flag, ImapConnection, SequenceSet, StoreOperation, TlsMode};

use base64::Engine as _;
use encoding_rs::{GB18030, UTF_8};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{Message, SmtpTransport, Transport};

const IMAP_HOST: &str = "imap.163.com";
const IMAP_PORT: u16 = 993;
const SMTP_HOST: &str = "smtp.163.com";
const TIMEOUT: Duration = Duration::from_secs(30);
const CLIENT_VERSION: &str = "0.1.8";

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

// ---------- 编码解码：163 邮件普遍使用 GBK/GB18030 + base64/quoted-printable ----------

/// 按 charset 把字节解码为 UTF-8 字符串。GB 系列统一走 GB18030（兼容 GBK/GB2312）。
fn decode_with_charset(bytes: &[u8], charset: &str) -> String {
    let label = charset.trim().to_ascii_lowercase();
    if label.contains("gb") || label.contains("18030") || label.contains("2312") {
        let (decoded, _, _) = GB18030.decode(bytes);
        decoded.into_owned()
    } else {
        // 默认先按 UTF-8，若非法则退回 GB18030，最大限度避免乱码。
        let (decoded, had_error, _) = UTF_8.decode(bytes);
        if had_error {
            let (gb, _, _) = GB18030.decode(bytes);
            gb.into_owned()
        } else {
            decoded.into_owned()
        }
    }
}

/// 解码 RFC2047 的 Q 编码字（`_`=空格，`=XX`=字节）。
fn decode_qp_word(data: &str) -> Vec<u8> {
    let bytes = data.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'=' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) { out.push(v); }
            }
            i += 3;
        } else if b == b'_' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b);
            i += 1;
        }
    }
    out
}

/// 解码一个 RFC2047 编码词 `=?charset?B|Q?data?=`。
fn decode_rfc2047_word(raw: &str) -> String {
    if !raw.contains("=?") || !raw.contains("?=") {
        return raw.to_string();
    }
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        // charset?B?data? 或 charset?Q?data?
        let Some(sep1) = after.find('?') else {
            out.push_str("=?");
            rest = after;
            continue;
        };
        let charset = &after[..sep1];
        let tail = &after[sep1 + 1..];
        let Some(sep2) = tail.find('?') else {
            out.push_str("=?");
            rest = after;
            continue;
        };
        let enc = &tail[..sep2];
        let tail2 = &tail[sep2 + 1..];
        let Some(end) = tail2.find("?=") else {
            out.push_str("=?");
            rest = after;
            continue;
        };
        let data = &tail2[..end];
        if enc.eq_ignore_ascii_case("B") {
            let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).unwrap_or_default();
            out.push_str(&decode_with_charset(&bytes, charset));
        } else {
            out.push_str(&decode_with_charset(&decode_qp_word(data), charset));
        }
        rest = &tail2[end + 2..];
    }
    out.push_str(rest);
    out
}

/// 解析出第一个 text/plain 或 text/html 子部分正文（用于 multipart 邮件）。
fn extract_first_text(raw: &[u8], boundary: &str, is_html: &mut bool) -> Vec<u8> {
    let text = String::from_utf8_lossy(raw);
    let marker = format!("--{boundary}");
    let mut best_plain: Option<(Vec<u8>, bool)> = None;
    let mut best_html: Option<(Vec<u8>, bool)> = None;
    for part in text.split(&marker) {
        let p = part.trim_start();
        let low = p.to_ascii_lowercase();
        let html_part = low.contains("text/html") || low.contains("<html") || low.contains("<!doctype");
        let plain_part = low.contains("text/plain") || low.contains("text/x-mail") || (!low.contains("content-type:") && !html_part);
        let body = p.split_once("\r\n\r\n").or_else(|| p.split_once("\n\n")).map(|(_, b)| b);
        if !html_part && !plain_part {
            continue;
        }
        if let Some(body) = body {
            let bytes = body.trim().as_bytes().to_vec();
            if html_part {
                best_html = Some((bytes, true));
                break;
            } else if best_plain.is_none() {
                best_plain = Some((bytes, false));
            }
        }
    }
    if let Some((b, h)) = best_html {
        *is_html = true;
        b
    } else if let Some((b, h)) = best_plain {
        *is_html = h;
        b
    } else {
        raw.to_vec()
    }
}

/// 解码 MIME 正文：处理 base64 / quoted-printable 传输编码、GBK/UTF-8 字符集，
/// 并识别 multipart 邮件，返回 `(解码后的 UTF-8 文本, 是否为 HTML)`。
fn decode_mime_body(raw: &[u8]) -> (String, bool) {
    let raw_text = String::from_utf8_lossy(raw);
    // 先分离 MIME 头与正文：正文从首个空行之后开始（拉取的是含头的完整邮件）。
    let (header_part, body_part) = match raw_text.find("\r\n\r\n").map(|i| (i, 4))
        .or_else(|| raw_text.find("\r\n\n").map(|i| (i, 3)))
        .or_else(|| raw_text.find("\n\n").map(|i| (i, 2)))
    {
        Some((idx, off)) => (&raw_text[..idx], &raw_text[idx + off..]),
        None => ("", &raw_text[..]),
    };

    let mut transfer = String::new();
    let mut charset = String::new();
    let mut boundary: Option<String> = None;
    for line in header_part.lines().take(60) {
        let low = line.trim_start().to_ascii_lowercase();
        if low.starts_with("content-transfer-encoding:") {
            transfer = low["content-transfer-encoding:".len()..].trim().to_string();
        } else if low.starts_with("content-type:") {
            if let Some(ci) = low.find("charset=") {
                let val: String = low[ci + 8..].trim()
                    .trim_matches('"').trim_matches('\'')
                    .chars().take_while(|c| *c != ';' && *c != ' ' && *c != '\r' && *c != '\n')
                    .collect();
                if !val.is_empty() { charset = val; }
            }
            if low.contains("boundary=") && boundary.is_none() {
                if let Some(b) = low.split("boundary=").nth(1) {
                    let b: String = b.trim().trim_matches('"')
                        .chars().take_while(|c| *c != ';' && *c != ' ' && *c != '\r' && *c != '\n')
                        .collect();
                    if !b.is_empty() { boundary = Some(b); }
                }
            }
        }
    }

    // 依据传输编码还原正文原始字节（仅处理正文部分，头部不参与解码）。
    let mut payload: Vec<u8> = if transfer.starts_with("base64") {
        let compact: String = body_part.chars().filter(|c| !c.is_whitespace()).collect();
        base64::engine::general_purpose::STANDARD.decode(&compact).unwrap_or_default()
    } else if transfer.starts_with("quoted-printable") {
        quoted_printable::decode(body_part.as_bytes())
    } else {
        body_part.as_bytes().to_vec()
    };

    // multipart：优先提取 text/plain 或 text/html 子部分。
    let mut is_html = false;
    if let Some(boundary) = boundary {
        if !boundary.is_empty() {
            payload = extract_first_text(&payload, &boundary, &mut is_html);
        }
    }
    // 提取出的子部分自身可能仍是 base64（嵌套传输编码），自动尝试还原一次。
    if !payload.is_empty() {
        let compact: String = String::from_utf8_lossy(&payload).chars().filter(|c| !c.is_whitespace()).collect();
        if compact.len() >= 8
            && compact.len() % 4 == 0
            && compact.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
        {
            if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&compact) {
                if !decoded.is_empty() {
                    payload = decoded;
                }
            }
        }
    }
    if !is_html {
        let low = String::from_utf8_lossy(&payload).to_ascii_lowercase();
        is_html = low.contains("<html") || low.contains("<body") || low.contains("<!doctype") || low.contains("</div>") || low.contains("<p>");
    }
    (decode_with_charset(&payload, &charset), is_html)
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
            let name = decode_rfc2047_word(a.name.as_deref().unwrap_or("").trim()).trim().to_string();
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
    let subject = decode_rfc2047_word(env.subject.as_deref().unwrap_or("").trim()).trim().to_string();
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
    /// 正文是否为 HTML（前端据此选择渲染方式）。
    pub html: bool,
}

/// 列表最大返回条数。163 收件箱可能非常大，仅拉取最近的邮件以控制体积与耗时。
const MAX_LIST: usize = 60;

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
    let mut list: Vec<ImapMailMeta> = fetched.iter().map(fetch_to_meta).collect();
    // 按 UID 倒序（UID 单调递增，近似时间顺序），只保留最近的 MAX_LIST 封。
    list.sort_by(|a, b| b.id.cmp(&a.id));
    list.truncate(MAX_LIST);
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
        // 拉取完整邮件（含 MIME 头），以便 decode_mime_body 识别传输编码 / 字符集 / boundary。
        // 用 BODY.PEEK 避免 FETCH 本身置为已读。
        FetchAttr::BodySection {
            peek: true,
            section: None,
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
    let (body, html) = decode_mime_body(&body_bytes);
    let detail = ImapMailDetail {
        id: f.uid.unwrap_or(uid),
        subject: if subject.is_empty() {
            "无主题".to_string()
        } else {
            subject
        },
        sender,
        unread: flags_unread(f.flags.as_deref().unwrap_or(&[])),
        body,
        html,
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