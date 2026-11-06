//! Platform differences that would otherwise be re-decided at every call site:
//! path spelling, how a background process leaves the console, process-tree
//! lifetime and which shell runs a script.

use std::path::{Path, PathBuf};

/// `canonicalize` that never returns a Windows verbatim (`\\?\C:\...`) path.
///
/// Verbatim paths are not interchangeable with the ones `git` and the user
/// type: they hash differently, `Path::starts_with` treats their drive prefix
/// as different, and Explorer and `cmd.exe` do not understand them. All
/// canonicalization goes through this so both sides of a comparison match.
pub trait CanonicalPath {
    fn canonical(&self) -> std::io::Result<PathBuf>;
}

impl<T: AsRef<Path> + ?Sized> CanonicalPath for T {
    fn canonical(&self) -> std::io::Result<PathBuf> {
        dunce::canonicalize(self)
    }
}

/// Spell a Windows path the way `git rev-parse --show-toplevel` does, which is
/// what existing project keys were hashed from.
fn normalize_windows_path(path: &str) -> String {
    let path = match path.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => path.strip_prefix(r"\\?\").unwrap_or(path).to_string(),
    };
    path.replace('\\', "/")
}

/// Stable spelling of a project path. Project keys are hashes of this string,
/// so one directory must always produce the same bytes however it was reached.
pub fn normalize_project_path(path: &str) -> String {
    if cfg!(windows) {
        normalize_windows_path(path)
    } else {
        path.to_string()
    }
}

/// A path relative to some root, in the `/`-separated form the API and the
/// frontend use. A backslash is an ordinary filename character on Unix.
pub fn slash_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

/// Put a long-lived background process (the GUI daemon, `grove serve`) out of
/// reach of the terminal that started it.
///
/// On Windows a new process group does not leave the console: closing the
/// terminal still kills everything attached to it. `CREATE_NO_WINDOW` gives the
/// process a console of its own that is never shown, and its console children
/// (git and every other tool) share that one instead of each flashing a window.
pub fn detach_from_terminal(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = command;
}

/// Give an interactive console program its own window. Without this it would
/// share Grove's console, which is hidden or belongs to the user's terminal.
#[cfg(windows)]
pub fn open_in_new_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    command.creation_flags(CREATE_NEW_CONSOLE);
}

/// Owns a process and everything it starts.
///
/// Unix callers already get the behavior they need from the existing process
/// handling, so this is empty there. On Windows killing a process leaves its
/// children running, and agents are usually `.cmd` shims, so killing one would
/// only stop `cmd.exe` and leave the real `node.exe` holding its worktree. The
/// Job closes with this value, which ends the whole tree. A descendant started
/// before `adopt` returns can escape; the window is one process launch.
#[derive(Default)]
pub struct ProcessTree {
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

impl ProcessTree {
    #[cfg(unix)]
    pub fn adopt(_child: &tokio::process::Child) -> Self {
        Self::default()
    }

    #[cfg(windows)]
    pub fn adopt(child: &tokio::process::Child) -> Self {
        Self {
            job: child.raw_handle().and_then(windows_job::kill_on_close),
        }
    }

    #[cfg(not(any(unix, windows)))]
    pub fn adopt(_child: &tokio::process::Child) -> Self {
        Self::default()
    }

    /// End every process in the tree now, without waiting for `drop`.
    pub fn terminate(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            windows_job::terminate(job);
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub fn kill_on_close(process: RawHandle) -> Option<OwnedHandle> {
        // SAFETY: both pointer arguments are optional. A non-null result is a
        // new handle owned by the `OwnedHandle`, which closes it on every path
        // below. `process` is live for the duration of this call.
        unsafe {
            let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw.is_null() {
                return None;
            }
            let job = OwnedHandle::from_raw_handle(raw as RawHandle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job.as_raw_handle() as _,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0
                || AssignProcessToJobObject(job.as_raw_handle() as _, process as _) == 0
            {
                return None;
            }
            Some(job)
        }
    }

    pub fn terminate(job: &OwnedHandle) {
        // SAFETY: `job` is a live Job handle owned by the caller.
        unsafe {
            TerminateJobObject(job.as_raw_handle() as _, 1);
        }
    }
}

/// The family of shell a script is written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellSyntax {
    Posix,
    #[cfg_attr(not(windows), allow(dead_code))]
    PowerShell,
}

/// The shell Grove runs command strings with.
///
/// Agents write POSIX shell, so Windows prefers Git for Windows' bash and only
/// falls back to PowerShell, which every Windows install has.
pub struct ScriptShell {
    program: PathBuf,
    syntax: ShellSyntax,
}

impl ScriptShell {
    pub fn detect() -> Self {
        #[cfg(windows)]
        {
            Self::detect_windows()
        }
        #[cfg(not(windows))]
        {
            Self {
                program: std::env::var_os("SHELL")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("sh")),
                syntax: ShellSyntax::Posix,
            }
        }
    }

    #[cfg(windows)]
    fn detect_windows() -> Self {
        let explicit = ["GROVE_SHELL", "SHELL"]
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .find_map(|shell| crate::check::resolve_program(&shell));
        if let Some(program) = explicit {
            let syntax = if is_powershell(&program) {
                ShellSyntax::PowerShell
            } else {
                ShellSyntax::Posix
            };
            return Self { program, syntax };
        }
        if let Some(program) = git_bash() {
            return Self {
                program,
                syntax: ShellSyntax::Posix,
            };
        }
        Self {
            program: PathBuf::from("powershell.exe"),
            syntax: ShellSyntax::PowerShell,
        }
    }

    /// A command that runs `script`. `login` asks a Unix shell for the user's
    /// full interactive environment; it has no Windows equivalent.
    pub fn command(&self, script: &str, login: bool) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.program);
        match self.syntax {
            ShellSyntax::PowerShell => {
                command
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-EncodedCommand",
                    ])
                    .arg(powershell_encoded_command(script));
            }
            ShellSyntax::Posix => {
                if login && cfg!(unix) {
                    command.args(["-l", "-i"]);
                }
                command.arg("-c").arg(script);
            }
        }
        command
    }

    /// One command line for `program args...`, quoted so that spaces and
    /// metacharacters cannot change argument boundaries.
    pub fn command_line(&self, program: &str, args: &[String]) -> String {
        let quote = match self.syntax {
            ShellSyntax::Posix => posix_quote,
            ShellSyntax::PowerShell => powershell_quote,
        };
        let words = std::iter::once(program)
            .chain(args.iter().map(String::as_str))
            .map(quote)
            .collect::<Vec<_>>()
            .join(" ");
        match self.syntax {
            ShellSyntax::Posix => words,
            ShellSyntax::PowerShell => format!("& {words}"),
        }
    }
}

fn posix_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Wrap `script` for `powershell -EncodedCommand`, which sidesteps command-line
/// quoting entirely. Output is forced to UTF-8 because Grove decodes it as such
/// and the console code page on a Chinese Windows is GBK. The trailer turns a
/// failure into a process exit code, which PowerShell does not do on its own.
fn powershell_encoded_command(script: &str) -> String {
    use base64::Engine;
    let wrapped = format!(
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n\
         $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n\
         $global:LASTEXITCODE = 0\n\
         {script}\n\
         $groveSucceeded = $?\n\
         if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}\n\
         if (-not $groveSucceeded) {{ exit 1 }}\n"
    );
    let bytes: Vec<u8> = wrapped.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(windows)]
fn is_powershell(program: &Path) -> bool {
    program
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| {
            stem.eq_ignore_ascii_case("powershell") || stem.eq_ignore_ascii_case("pwsh")
        })
}

/// Git for Windows' bash, found through `git` so custom install locations work.
/// `bash` on PATH is not used: `C:\Windows\System32\bash.exe` is the WSL launcher
/// and would run the command in another filesystem.
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let from_git = crate::check::resolve_program("git").and_then(|git| {
        git.ancestors()
            .skip(1)
            .take(3)
            .map(|dir| dir.join("bin").join("bash.exe"))
            .find(|candidate| candidate.is_file())
    });
    from_git.or_else(|| {
        ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"]
            .iter()
            .filter_map(std::env::var_os)
            .flat_map(|root| {
                let root = PathBuf::from(root);
                [
                    root.join("Git").join("bin").join("bash.exe"),
                    root.join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe"),
                ]
            })
            .find(|candidate| candidate.is_file())
    })
}

/// The shell to hand the terminal to for an interactive session.
pub fn interactive_shell() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("SHELL")
            .ok()
            .and_then(|shell| crate::check::resolve_program(&shell))
            .or_else(|| std::env::var_os("COMSPEC").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("cmd.exe"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("sh"))
    }
}

/// How an agent should launch a stdio MCP server configured as `command args`.
///
/// Agents spawn these directly, and neither `CreateProcess` nor Node can start
/// a `.cmd` shim (`npx`, `uvx` wrappers) that way, so Windows goes through
/// `cmd.exe`. Everything else resolves to the absolute path ACP asks for.
pub fn stdio_server_launch(command: &str, args: Vec<String>) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let Some(resolved) = crate::check::resolve_program(command) else {
            return (command.to_string(), args);
        };
        let is_batch = resolved
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
            });
        if !is_batch {
            return (resolved.to_string_lossy().into_owned(), args);
        }
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut launch = vec!["/d".to_string(), "/c".to_string(), command.to_string()];
        launch.extend(args);
        (shell, launch)
    }
    #[cfg(not(windows))]
    {
        (command.to_string(), args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_normalize_to_the_spelling_git_reports() {
        for spelling in [
            r"\\?\C:\Users\me\repo",
            r"C:\Users\me\repo",
            "C:/Users/me/repo",
        ] {
            assert_eq!(normalize_windows_path(spelling), "C:/Users/me/repo");
        }
        assert_eq!(
            normalize_windows_path(r"\\?\UNC\server\share\repo"),
            "//server/share/repo"
        );
    }

    #[test]
    fn powershell_script_is_utf16le_base64_and_reports_failure() {
        use base64::Engine;
        let encoded = powershell_encoded_command("git status");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let script = String::from_utf16(&units).unwrap();
        assert!(script.contains("\ngit status\n"));
        assert!(script.contains("exit $LASTEXITCODE"));
    }

    #[test]
    fn command_lines_keep_argument_boundaries() {
        let posix = ScriptShell {
            program: "sh".into(),
            syntax: ShellSyntax::Posix,
        };
        assert_eq!(
            posix.command_line("git", &["it's".to_string(), String::new()]),
            r#"'git' 'it'"'"'s' ''"#
        );
        let powershell = ScriptShell {
            program: "powershell.exe".into(),
            syntax: ShellSyntax::PowerShell,
        };
        assert_eq!(
            powershell.command_line("git", &["it's; rm".to_string()]),
            "& 'git' 'it''s; rm'"
        );
    }
}
