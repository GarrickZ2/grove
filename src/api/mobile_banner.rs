//! `grove mobile` startup screens.
//!
//! A passkey the user typed is never printed: they already know it, and the
//! terminal or a log is the last place it should end up. A generated key has
//! to be shown once, so it appears on the terminal's alternate screen — the one
//! full-screen programs use, which leaves no scrollback — together with a QR
//! code that signs a phone in. That screen closes as soon as a device signs in
//! with the key, on Enter, or after five minutes. The resident banner that
//! follows lists only the address, instructions and a QR code without the key.

use std::io::{BufRead, IsTerminal, Write};
use std::sync::Arc;
use std::time::Duration;

use super::auth::ServerAuth;

/// How long the one-time key stays on screen if nobody acts on it.
const KEY_SCREEN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

const ENTER_ALT_SCREEN: &str = "\x1b[?1049h\x1b[H\x1b[2J";
const LEAVE_ALT_SCREEN: &str = "\x1b[?1049l";

enum KeyScreenOutcome {
    Dismissed,
    SignedIn(String),
    TimedOut,
}

/// Render a QR code with Unicode half blocks, two pixel rows per text line.
pub(crate) fn qr_text(content: &str) -> Option<String> {
    let code = match qrcode::QrCode::new(content) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Failed to generate QR code: {}", error);
            return None;
        }
    };
    let modules = code.to_colors();
    let width = code.width();
    let quiet_zone = 2;
    let mut out = format!("   {}\n", " ".repeat(width + quiet_zone * 2));
    let rows: Vec<&[qrcode::Color]> = modules.chunks(width).collect();
    for y in (0..rows.len()).step_by(2) {
        out.push_str("   ");
        out.push_str(&" ".repeat(quiet_zone));
        for x in 0..width {
            let top = rows[y][x] == qrcode::Color::Dark;
            let bottom = rows
                .get(y + 1)
                .is_some_and(|row| row[x] == qrcode::Color::Dark);
            out.push(match (top, bottom) {
                (true, true) => '\u{2588}',
                (true, false) => '\u{2580}',
                (false, true) => '\u{2584}',
                (false, false) => ' ',
            });
        }
        out.push_str(&" ".repeat(quiet_zone));
        out.push('\n');
    }
    Some(out)
}

/// The terminal the user is sitting at, if any. Prompts and the one-time key
/// go here rather than to stdout, which may be redirected into a log.
fn open_tty() -> Option<std::fs::File> {
    if !std::io::stdin().is_terminal() {
        return None;
    }
    #[cfg(windows)]
    {
        // The key screen uses escape sequences and UTF-8 block characters, and
        // a raw console handle gets neither by default.
        let _ = crossterm::ansi_support::supports_ansi();
        const CP_UTF8: u32 = 65001;
        // SAFETY: takes a code page by value and has no other inputs.
        unsafe {
            windows_sys::Win32::System::Console::SetConsoleOutputCP(CP_UTF8);
        }
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(if cfg!(windows) { "CONOUT$" } else { "/dev/tty" })
        .ok()
}

/// A handle to read the user's Enter from. On Windows the console's input and
/// output are separate devices.
fn open_tty_input(tty: &std::fs::File) -> std::io::Result<std::fs::File> {
    if cfg!(windows) {
        std::fs::File::open("CONIN$")
    } else {
        tty.try_clone()
    }
}

/// Where stdout is redirected to, when that can be determined.
pub(crate) fn stdout_target() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut buf = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: F_GETPATH writes a NUL-terminated path of at most PATH_MAX
        // bytes into the buffer we own.
        let ok = unsafe { libc::fcntl(1, libc::F_GETPATH, buf.as_mut_ptr()) } != -1;
        if ok {
            let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            return Some(String::from_utf8_lossy(&buf[..len]).into_owned());
        }
        None
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link("/proc/self/fd/1")
            .ok()
            .map(|path| path.display().to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// Tell the user at the terminal — not the log — that redirected output never
/// receives their passkey. Called before the passkey prompt.
pub(crate) fn note_redirected_output() {
    if std::io::stdout().is_terminal() {
        return;
    }
    if let Some(mut tty) = open_tty() {
        let target = stdout_target().unwrap_or_else(|| "a pipe or file".to_string());
        let _ = writeln!(
            tty,
            "Note: output is redirected to {}. Your passkey and any generated key are shown only here, never written there.",
            target
        );
    }
}

/// Print the access banner for `grove mobile` once the server is listening.
/// Must be called inside the runtime: the one-time key screen waits for a
/// sign-in while the server keeps serving.
pub(crate) fn present(auth: Arc<ServerAuth>, base_url: String, tls_label: Option<&'static str>) {
    let sk = auth.secret_key.clone().unwrap_or_default();
    if !auth.key_is_generated {
        print_banner(&base_url, tls_label, "your passkey", &[]);
        return;
    }
    let Some(tty) = open_tty() else {
        // Nobody to show it to once: stdout is the only way to deliver the key.
        let notes = [
            format!("Generated key: {}", sk),
            "Warning: no terminal is attached, so the key above is written wherever this output goes (for example a log file).".to_string(),
            "Run `grove mobile` in a terminal to see the key only once, or type your own passkey there.".to_string(),
        ];
        print_banner(&base_url, tls_label, "the generated key", &notes);
        return;
    };
    let logins = auth.logins.subscribe();
    tokio::spawn(async move {
        let outcome = show_key_once(tty, &sk, &base_url, logins).await;
        let hidden = match outcome {
            KeyScreenOutcome::SignedIn(device) => {
                format!("Generated key hidden — signed in on {}.", device)
            }
            KeyScreenOutcome::Dismissed => "Generated key hidden.".to_string(),
            KeyScreenOutcome::TimedOut => "Generated key hidden after 5 minutes.".to_string(),
        };
        let notes = [
            hidden,
            "It was shown once and is not saved: restart Grove to get a new one, or type your own passkey at the prompt.".to_string(),
        ];
        print_banner(&base_url, tls_label, "the generated key", &notes);
    });
}

async fn show_key_once(
    mut tty: std::fs::File,
    sk: &str,
    base_url: &str,
    mut logins: tokio::sync::watch::Receiver<Option<String>>,
) -> KeyScreenOutcome {
    let mut screen = format!(
        "{ENTER_ALT_SCREEN}Grove Mobile — one-time key\n\n  {sk}\n\n  Copy it now, or scan to sign in on your phone. It will not be shown again.\n"
    );
    if let Some(qr) = qr_text(&format!("{}/#sk={}", base_url, sk)) {
        screen.push_str(&qr);
    }
    screen.push_str(
        "\n  This screen closes when a device signs in, when you press Enter, or after 5 minutes.\n",
    );
    let _ = tty.write_all(screen.as_bytes());
    let _ = tty.flush();

    // Reading the terminal blocks, so it runs on its own thread. If the screen
    // closes for another reason the thread just consumes the next Enter.
    let (enter_tx, enter_rx) = tokio::sync::oneshot::channel();
    if let Ok(reader) = open_tty_input(&tty) {
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = std::io::BufReader::new(reader).read_line(&mut line);
            let _ = enter_tx.send(());
        });
    }

    let outcome = tokio::select! {
        _ = enter_rx => KeyScreenOutcome::Dismissed,
        changed = logins.changed() => match (changed, logins.borrow().clone()) {
            (Ok(()), Some(device)) => KeyScreenOutcome::SignedIn(device),
            _ => KeyScreenOutcome::Dismissed,
        },
        _ = tokio::time::sleep(KEY_SCREEN_TIMEOUT) => KeyScreenOutcome::TimedOut,
        _ = tokio::signal::ctrl_c() => {
            // Leaving the terminal on the alternate screen would keep the key
            // visible after Grove exits.
            let _ = tty.write_all(LEAVE_ALT_SCREEN.as_bytes());
            let _ = tty.flush();
            super::shutdown_file_watchers();
            std::process::exit(130);
        }
    };
    let _ = tty.write_all(LEAVE_ALT_SCREEN.as_bytes());
    let _ = tty.flush();
    outcome
}

fn print_banner(base_url: &str, tls_label: Option<&str>, credential: &str, notes: &[String]) {
    let mut out = format!(
        "\nGrove Mobile UI: {}\n\n  Authentication: HMAC-SHA256\n",
        base_url
    );
    if let Some(label) = tls_label {
        out.push_str(&format!("  TLS: enabled ({})\n", label));
    }
    for note in notes {
        out.push_str(&format!("  {}\n", note));
    }
    out.push_str(&format!(
        "\n  Scan to open, then sign in with {}:\n",
        credential
    ));
    if let Some(qr) = qr_text(base_url) {
        out.push_str(&qr);
    }
    out.push_str(&format!(
        "\n  Connect with Grove GUI:\n    grove gui --remote-url {}\n    (sign in with {} when prompted)\n",
        base_url, credential
    ));
    println!("{}", out);
}

#[cfg(test)]
mod tests {
    use super::qr_text;

    #[test]
    fn qr_text_renders_two_pixel_rows_per_line() {
        let code = qrcode::QrCode::new("https://grove.example.com").unwrap();
        let qr = qr_text("https://grove.example.com").unwrap();
        // One blank top quiet line, then ceil(width / 2) module lines.
        assert_eq!(qr.lines().count(), 1 + code.width().div_ceil(2));
        assert!(!qr.contains("#sk="));
    }
}
