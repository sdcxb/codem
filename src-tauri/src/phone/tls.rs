// ============================================================
// phone/tls.rs — LAN 边缘的**自签证书**（阶段 1：安全对齐）
//
// ## 为什么是"自签 CA + 短命叶子"而不是一张自签叶子
//
// 一张直接自签的叶子证书，手机上每次连都要重新信任（没有稳定的锚点）。
// 我们照 DSH 的形状（`lan-https-certificate-*.js:17-18`：
// **CA 3650 天 / 叶子 30 天**）做两段式：
//
// - **CA 长期稳定**：用户只在手机上装一次（或信任一次指纹），
//   之后换叶子不再需要动手机；
// - **叶子短期轮换**：叶子泄了也只影响 30 天，且轮换**不需要用户操作**。
//
// ## 为什么 SAN 只放**规范化后的 IPv4**
//
// 浏览器的 IP 证书校验要求 SAN 里有该 IP 的 `iPAddress` 项（不是 `dNSName`）。
// DSH 在 `lan-https-certificate-*.js:73-79,294` 专门做了"规范化 IP 后再入 SAN"，
// 因为同一张网卡的 IP 可能有多种文本写法（前导零等），写错了就等于没覆盖。
//
// ## 为什么要有元数据侧车文件
//
// "叶子还剩几天""当初覆盖了哪些 IP"这类信息，靠**解析 PEM 反推**需要引入
// x509 解析依赖。我们改成在旁边记一份 JSON：读它就能判断该不该轮换。
// 侧车丢了/坏了 ⇒ 直接重新签一张叶子（对用户无损，因为 CA 没动）。
// ============================================================

use std::fs;
use std::path::{Path, PathBuf};

use rcgen::{
    BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType,
};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};

/// CA 有效期（天）—— 对齐 DSH 的 3650。
pub const CA_VALID_DAYS: i64 = 3650;
/// 叶子有效期（天）—— 对齐 DSH 的 30。
pub const LEAF_VALID_DAYS: i64 = 30;
/// 叶子剩余不足这个天数就**提前轮换**（避免用户正好在过期那一刻连上来）。
pub const LEAF_RENEW_BEFORE_DAYS: i64 = 7;

/// 侧车元数据（记"该不该轮换"，避免解析 PEM）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct CertMeta {
    /// CA 到期时间（Unix 秒）
    pub ca_not_after: i64,
    /// 叶子到期时间（Unix 秒）
    pub leaf_not_after: i64,
    /// 这张叶子的 SAN 覆盖的 IP（用于判断 LAN IP 变了要不要重签）
    pub leaf_ips: Vec<String>,
}

/// 边缘要用的证书材料。
pub struct CertMaterial {
    /// 叶子证书链（PEM，叶子在前）—— rustls 只需要叶子（自签 CA 由客户端信任）
    pub leaf_cert_pem: String,
    /// 叶子私钥（PEM）
    pub leaf_key_pem: String,
    /// CA 证书 PEM（手机上安装用；也是指纹的来源，DER 由它现算）
    pub ca_pem: String,
    /// CA 指纹（大写十六进制，冒号分隔）—— 用户肉眼核对用
    pub ca_fingerprint: String,
}

pub fn tls_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("phone").join("tls")
}

fn ca_pem_path(dir: &Path) -> PathBuf {
    dir.join("ca.pem")
}
fn ca_key_path(dir: &Path) -> PathBuf {
    dir.join("ca.key.pem")
}
fn leaf_pem_path(dir: &Path) -> PathBuf {
    dir.join("leaf.pem")
}
fn leaf_key_path(dir: &Path) -> PathBuf {
    dir.join("leaf.key.pem")
}
fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

/// 把 DER 算成"人眼可核对"的指纹：大写十六进制、字节之间加冒号。
///
/// 为什么用 SHA-256 而不是 SHA-1：SHA-1 已被认为可碰撞，
/// 而指纹的全部意义就是"用户念出来能确认没被换过"。
pub fn fingerprint_of(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":")
}

/// LAN IP 的**规范化**文本（去空白、去前导零、只接受能解析的 IP）。
///
/// 不能把解析不了的字符串塞进 SAN：那会静默产生一张"看起来覆盖了、
/// 实际浏览器不认"的证书。宁可少覆盖也不要假覆盖。
pub fn normalize_san_ips(ips: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in ips {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        match t.parse::<std::net::IpAddr>() {
            Ok(ip) => {
                let canonical = ip.to_string();
                if !out.contains(&canonical) {
                    out.push(canonical);
                }
            }
            Err(_) => continue,
        }
    }
    out
}

fn now_unix() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn write_private(path: &Path, data: &str) -> Result<(), String> {
    fs::write(path, data).map_err(|e| format!("写 {} 失败: {}", path.display(), e))?;
    // Windows 下不设 ACL（与既有 devices.json 同策略）；至少保证文件是我们建的。
    Ok(())
}

/// 读侧车；坏了就当作"没有元数据"（触发重签，对用户无损）。
fn read_meta(dir: &Path) -> Option<CertMeta> {
    let raw = fs::read_to_string(meta_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 生成一张新的 CA，返回 (证书 PEM, 私钥 PEM, 到期 Unix 秒)。
fn generate_ca() -> Result<(String, String, i64), String> {
    let key = KeyPair::generate().map_err(|e| format!("生成 CA 私钥失败: {}", e))?;
    let mut params =
        CertificateParams::new(Vec::<String>::new()).map_err(|e| format!("CA 参数失败: {}", e))?;
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::hours(1); // 容忍客户端时钟偏差
    params.not_after = now + Duration::days(CA_VALID_DAYS);
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(DnType::CommonName, "Codem LAN CA");
    params
        .distinguished_name
        .push(DnType::OrganizationName, "Codem");
    // CA 必须显式带上"签证书"的用途，否则严格实现的客户端会拒绝这条链
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let cert = params
        .self_signed(&key)
        .map_err(|e| format!("CA 自签失败: {}", e))?;
    Ok((
        cert.pem(),
        key.serialize_pem(),
        params.not_after.unix_timestamp(),
    ))
}

/// 用给定 CA 签一张覆盖 `ips` 的新叶子，返回 (叶子 PEM, 叶子私钥 PEM, 到期 Unix 秒)。
fn generate_leaf(
    ca_pem: &str,
    ca_key_pem: &str,
    ips: &[String],
) -> Result<(String, String, i64), String> {
    let ca_key = KeyPair::from_pem(ca_key_pem).map_err(|e| format!("读 CA 私钥失败: {}", e))?;
    // Issuer 由 CA 的证书 PEM + 私钥构成 —— 直接复用 PEM 而不是重新构造参数，
    // 保证叶子里的 issuer 字段与落盘的 CA **逐字一致**。
    let issuer = Issuer::from_ca_cert_pem(ca_pem, ca_key)
        .map_err(|e| format!("构造 CA Issuer 失败: {}", e))?;

    let leaf_key = KeyPair::generate().map_err(|e| format!("生成叶子私钥失败: {}", e))?;
    let san: Vec<String> = normalize_san_ips(ips);
    let mut params =
        CertificateParams::new(san.clone()).map_err(|e| format!("叶子参数失败: {}", e))?;
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::hours(1);
    params.not_after = now + Duration::days(LEAF_VALID_DAYS);
    params.is_ca = IsCa::NoCa;
    params
        .distinguished_name
        .push(DnType::CommonName, "Codem Phone Bridge");
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    // 显式把 IP 写成 iPAddress 类型的 SAN（CertificateParams::new 已按内容猜测，
    // 这里再确认一次，避免"看着有 SAN、其实是 dNSName"）
    params.subject_alt_names = san
        .iter()
        .filter_map(|s| s.parse::<std::net::IpAddr>().ok())
        .map(SanType::IpAddress)
        .collect();

    let cert = params
        .signed_by(&leaf_key, &issuer)
        .map_err(|e| format!("叶子签发失败: {}", e))?;
    Ok((
        cert.pem(),
        leaf_key.serialize_pem(),
        params.not_after.unix_timestamp(),
    ))
}

/// 确保目录里有一对可用的 CA + 叶子，**尽量复用**已有的 CA。
///
/// 复用规则（每条都对应一个用户可见的后果）：
/// - CA 缺失 / 已过期 ⇒ 只能新建 CA（手机需要重新信任 —— 无法避免）
/// - CA 还在 ⇒ **一定复用**，即使叶子要重签（手机无需任何操作）
/// - 叶子缺失 / 快过期 / SAN 没覆盖当前 IP ⇒ 重签叶子（CA 不动）
pub fn ensure(app_data_dir: &Path, ips: &[String]) -> Result<CertMaterial, String> {
    let dir = tls_dir(app_data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("建 TLS 目录失败: {}", e))?;
    let now = now_unix();
    let want_ips = normalize_san_ips(ips);

    // ---------- CA：能复用就复用 ----------
    let existing_meta = read_meta(&dir);
    let ca_ok = ca_pem_path(&dir).exists()
        && ca_key_path(&dir).exists()
        && existing_meta
            .as_ref()
            .map(|m| m.ca_not_after > now + Duration::days(1).whole_seconds())
            .unwrap_or(false);

    let (ca_pem, ca_meta_not_after) = if ca_ok {
        let pem = fs::read_to_string(ca_pem_path(&dir))
            .map_err(|e| format!("读 CA 证书失败: {}", e))?;
        (pem, existing_meta.as_ref().map(|m| m.ca_not_after).unwrap_or(0))
    } else {
        let (pem, key, not_after) = generate_ca()?;
        write_private(&ca_pem_path(&dir), &pem)?;
        write_private(&ca_key_path(&dir), &key)?;
        (pem, not_after)
    };
    let ca_key_pem =
        fs::read_to_string(ca_key_path(&dir)).map_err(|e| format!("读 CA 私钥失败: {}", e))?;

    // ---------- 叶子：需要就重签 ----------
    let leaf_reusable = leaf_pem_path(&dir).exists()
        && leaf_key_path(&dir).exists()
        && existing_meta
            .as_ref()
            .map(|m| {
                let renew_before = LEAF_RENEW_BEFORE_DAYS * 24 * 3600;
                m.leaf_not_after - renew_before > now
                    // LAN IP 变了必须重签：否则手机上证书对不上新地址，
                    // 浏览器会报"证书不匹配主机名"，而用户不知道为什么
                    && want_ips.iter().all(|ip| m.leaf_ips.contains(ip))
            })
            .unwrap_or(false);

    let (leaf_pem, leaf_not_after) = if leaf_reusable {
        (
            fs::read_to_string(leaf_pem_path(&dir)).map_err(|e| format!("读叶子证书失败: {}", e))?,
            existing_meta.as_ref().map(|m| m.leaf_not_after).unwrap_or(0),
        )
    } else {
        let (pem, key, not_after) = generate_leaf(&ca_pem, &ca_key_pem, &want_ips)?;
        write_private(&leaf_pem_path(&dir), &pem)?;
        write_private(&leaf_key_path(&dir), &key)?;
        (pem, not_after)
    };
    let leaf_key_pem =
        fs::read_to_string(leaf_key_path(&dir)).map_err(|e| format!("读叶子私钥失败: {}", e))?;

    // ---------- 落元数据（下次据此判断该不该轮换）----------
    let meta = CertMeta {
        ca_not_after: ca_meta_not_after,
        leaf_not_after,
        leaf_ips: want_ips.clone(),
    };
    if let Ok(js) = serde_json::to_string_pretty(&meta) {
        let _ = fs::write(meta_path(&dir), js);
    }

    // ---------- CA DER + 指纹 ----------
    let ca_der = pem_to_der(&ca_pem).ok_or("CA 证书不是合法 PEM".to_string())?;
    let ca_fingerprint = fingerprint_of(&ca_der);

    Ok(CertMaterial {
        leaf_cert_pem: leaf_pem,
        leaf_key_pem,
        ca_pem,
        ca_fingerprint,
    })
}

/// 从 PEM 里取第一段 CERTIFICATE 的 DER。
pub fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN CERTIFICATE-----"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END CERTIFICATE-----"))
        .map(|l| l.trim())
        .collect();
    if body.is_empty() {
        return None;
    }
    base64_decode(&body)
}

/// 极简 base64 解码（只处理标准字母表与 `=` 填充）。
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lut[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for b in s.bytes() {
        if b == b'=' {
            break;
        }
        let v = lut[b as usize];
        if v == 255 {
            continue; // 跳过换行等空白
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// 由 `CertMaterial` 构造 rustls 的服务端配置。
pub fn server_config(material: &CertMaterial) -> Result<std::sync::Arc<rustls::ServerConfig>, String> {
    // rustls 0.23 需要显式选加密提供者。这里用 ring（与 rcgen 同一后端，
    // 避免同时链进两套密码学实现）。
    let _ = rustls::crypto::ring::default_provider().install_default();

    let certs = rustls_pemfile_certs(&material.leaf_cert_pem)?;
    let key = rustls_pemfile_key(&material.leaf_key_pem)?;
    let cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("构造 TLS 配置失败: {}", e))?;
    Ok(std::sync::Arc::new(cfg))
}

fn rustls_pemfile_certs(
    pem: &str,
) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>, String> {
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(d) = pem_to_der(rest) {
        out.push(rustls::pki_types::CertificateDer::from(d));
        // 继续找下一段：简单按 END 行截断
        match rest.find("-----END CERTIFICATE-----") {
            Some(i) => rest = &rest[i + "-----END CERTIFICATE-----".len()..],
            None => break,
        }
    }
    if out.is_empty() {
        return Err("叶子证书 PEM 里没有 CERTIFICATE 段".into());
    }
    Ok(out)
}

fn rustls_pemfile_key(pem: &str) -> Result<rustls::pki_types::PrivateKeyDer<'static>, String> {
    // 只看 PKCS#8（rcgen 的 serialize_pem 产出的就是它）
    let body: String = pem
        .lines()
        .skip_while(|l| !l.starts_with("-----BEGIN PRIVATE KEY-----"))
        .skip(1)
        .take_while(|l| !l.starts_with("-----END PRIVATE KEY-----"))
        .map(|l| l.trim())
        .collect();
    let der = base64_decode(&body).ok_or("私钥不是合法 PEM".to_string())?;
    Ok(rustls::pki_types::PrivateKeyDer::Pkcs8(
        rustls::pki_types::PrivatePkcs8KeyDer::from(der),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_drops_unparsable_and_canonicalizes() {
        let got = normalize_san_ips(&[
            "192.168.1.20".into(),
            " 192.168.1.20 ".into(), // 重复（去空白后同一地址）
            "not-an-ip".into(),      // 解析不了 ⇒ 丢掉，不要假覆盖
            "".into(),
            "127.0.0.1".into(),
        ]);
        assert_eq!(got, vec!["192.168.1.20", "127.0.0.1"]);
    }

    #[test]
    fn fingerprint_is_sha256_hex_colons() {
        let f = fingerprint_of(b"abc");
        // SHA-256("abc") 的已知值
        assert_eq!(
            f,
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
        // 32 字节 ⇒ 32 段
        assert_eq!(f.split(':').count(), 32);
    }

    #[test]
    fn pem_roundtrip_extracts_der() {
        let (pem, _key, _na) = generate_ca().expect("能生成 CA");
        let der = pem_to_der(&pem).expect("能取出 DER");
        assert!(der.len() > 100);
        // DER 是 SEQUENCE
        assert_eq!(der[0], 0x30);
        // 指纹稳定（同一份 PEM 两次一致）
        assert_eq!(fingerprint_of(&der), fingerprint_of(&pem_to_der(&pem).unwrap()));
    }

    #[test]
    fn base64_decodes_known_value() {
        assert_eq!(base64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(base64_decode("YQ==").unwrap(), b"a");
        assert_eq!(base64_decode("YWJjZA==").unwrap(), b"abcd");
    }
}
