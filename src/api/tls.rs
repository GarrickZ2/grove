//! Self-signed TLS certificate generation and caching for `grove mobile --tls`.

use std::fs;
use std::path::PathBuf;

/// Return the directory used to cache self-signed certificates (`~/.grove/certs/`).
fn certs_dir() -> PathBuf {
    crate::storage::grove_dir().join("certs")
}

/// Ensure a self-signed certificate exists, generating one if needed.
///
/// The certificate includes `localhost` and the supplied LAN IP as SANs.
/// Returns `(cert_pem, key_pem)` strings.
pub fn ensure_cert(lan_ip: Option<&str>) -> std::io::Result<(String, String)> {
    let dir = certs_dir();
    let cert_path = dir.join("grove-self-signed.crt");
    let key_path = dir.join("grove-self-signed.key");

    // Return cached cert if both files exist
    if cert_path.exists() && key_path.exists() {
        let cert_pem = fs::read_to_string(&cert_path)?;
        let key_pem = fs::read_to_string(&key_path)?;
        return Ok((cert_pem, key_pem));
    }

    // Generate a new self-signed certificate
    fs::create_dir_all(&dir)?;

    let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()])
        .map_err(std::io::Error::other)?;

    // Add LAN IP as SAN
    if let Some(ip) = lan_ip {
        if let Ok(ip_addr) = ip.parse::<std::net::IpAddr>() {
            params
                .subject_alt_names
                .push(rcgen::SanType::IpAddress(ip_addr));
        }
    }

    // Set validity to 365 days
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2034, 12, 31);

    let key_pair = rcgen::KeyPair::generate().map_err(std::io::Error::other)?;
    let cert = params
        .self_signed(&key_pair)
        .map_err(std::io::Error::other)?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();

    fs::write(&cert_path, &cert_pem)?;
    fs::write(&key_path, &key_pem)?;

    Ok((cert_pem, key_pem))
}
